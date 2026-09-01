import { fetchAircallCalls, type AircallCall } from "../../lib/aircall.js";
import { toE164 } from "../../lib/phone.js";
import {
  interestedTagSet,
  logInterestedDecision,
  processAircallInterested,
} from "../../lib/aircall-interested.js";
import {
  companyCounterSlug,
  createNote,
  findPersonByPhone,
  incrementCounter,
  isPersonInList,
  isTransientAttioError,
  LISTS,
  personCompanyId,
  personCounterSlug,
  personDisplayName,
  personLabel,
} from "../../lib/attio.js";
import {
  advanceCursor,
  advanceCursorTo,
  CURSOR_GRACE_MS,
  getSyncCursor,
  isAfterCursor,
  saveSyncCursor,
  type CursorEvent,
} from "../../lib/cursors.js";
import { errorMessage } from "../../lib/json.js";
import { isAuthorizedCron, json, serverError } from "../../lib/http.js";
import { budgetSeconds, startRunBudget } from "../../lib/run-budget.js";

const SYNC_KEY = "aircall-touchpoints";
//An outcome tag is applied after the call, sometimes minutes after, so a cursor alone can carry a call past the
//interested check before the tag it is wanted for exists. This widens how far back that check looks, measured
//on ended_at, for the interested workflow alone. Touchpoint counters stay cursor-gated regardless and are never
//double-counted.
//
//It is a FLOOR, not a window: the effective floor is min(cursor, now - this). It therefore binds only while it
//reaches further back than the cursor does - that is, while it is wider than the inter-run gap.
//
//AT THE CURRENT TEN-MINUTE CADENCE IT DOES NOT NORMALLY BIND, AND FIVE MINUTES IS A MINIMUM, NOT THE WINDOW.
//The cursor sits about 12 minutes back (the gap plus CURSOR_GRACE_MS), and 12 minutes back reaches further back
//than five does, so min() picks the cursor. Real tag tolerance day to day is therefore ~12 minutes, not this
//five. What this value actually guarantees is the floor when two runs land close together - a manual trigger
//behind a scheduled one, or a retry - where the cursor is only a minute or two back and would otherwise leave
//almost no tolerance at all. Lowering this further cannot reduce tolerance below the cursor's ~12 minutes; only
//a shorter cadence can do that.
//
//WHAT THIS SETTING BUYS AND WHAT IT COSTS. Against this workspace's tag history (63 of 67 hand-applied tags
//landed within five minutes of the call ending, three within thirty, one took 165 minutes), a ~12-minute
//tolerance catches the 63 and misses the late ones. That is the deliberate trade: it is chosen for ONE note
//per interested call rather than for maximum tag coverage. An interested call is re-checked on every run whose
//floor still covers it, so at a floor barely wider than the cadence it is normally checked once, occasionally
//twice when it lands inside the two-minute grace band. Compare a 65-minute value, which recovers the 30-minute
//tags and the 165-minute outlier but writes each interested call's person and deal notes about six times over
//(the count is always this value divided by the cadence; the deal itself is never duplicated, only the notes).
//
//So: widen this to trade duplicate notes for late-tag coverage, lengthen the cadence to get coverage without
//the duplicates, and leave it here to keep notes clean at the cost of a tag applied more than ~12 minutes out.
const INTERESTED_LOOKBACK_MS = 5 * 60 * 1_000;

//[STABILITY] How far back the API window must reach BEYOND the oldest completion this run cares about.
//Aircall filters /calls on a call's creation time; this sync places calls on the timeline by ended_at. A call
//is therefore visible to the query from the moment it starts, but is discarded by fetchAircallCalls until it
//is "done". Without this margin a call lasting longer than the window is filtered out on every run that covers
//its start, then falls out of range before it ever appears finished - lost entirely, tag and touchpoint alike.
//[PERF] This widens every request; page count scales with it. Lower it if pagination becomes expensive, but
//never below the longest call the account actually makes.
//
//CEILING: a call is caught while its duration is under roughly this value. Precisely, the run that first sees
//it finished needs start >= processFloor - this, and processFloor trails the completion by up to the inter-run
//gap, so the safe duration is about this value plus CURSOR_GRACE_MS. At two hours that is calls up to ~2h02m.
//A longer call is dropped in full - no touchpoint, no tag - and dropped SILENTLY: it never reaches the fetch,
//so no counter, log line, or failure records that it existed.
const MAX_CALL_DURATION_MS = 2 * 60 * 60 * 1_000;

//---------------------------------------------------------------------------------------------------------
//Raised when a touchpoint was throttled or hit a server error BEFORE it had written anything to Attio.
//
//WHY THE DISTINCTION EXISTS. This sync's standing policy is to count a failed call and pass it over, never
//retrying, because its earlier writes are already committed and a retry would duplicate them. That reasoning
//holds only once something HAS been written. A 429 on the opening lookup wrote nothing, so passing the call
//over threw it away for no reason: the counter and note were lost and the cursor moved past it regardless.
//Attio rate-limits on "query complexity" - the filtered lookup at the top of every touchpoint is exactly what
//trips it - so this was the common failure, not an edge case.
//
//A call raising this is left ALONE: the cursor does not advance past it and the run stops, so the next run
//retries it from the beginning. Nothing was written, so nothing can double.
//---------------------------------------------------------------------------------------------------------
class ThrottledBeforeWrite extends Error {
  constructor(readonly reason: unknown) {
    super(errorMessage(reason));
    this.name = "ThrottledBeforeWrite";
  }
}

//---------------------------------------------------------------------------------------------------------
//Wraps a touchpoint step that has not yet written anything. A TRANSIENT failure there becomes
//ThrottledBeforeWrite; a deterministic one (a 400 or 404, a bad slug, a malformed record) is re-raised
//untouched, because retrying it on every future run would block the sync on a call that can never succeed.
//---------------------------------------------------------------------------------------------------------
async function beforeAnyWrite<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (isTransientAttioError(error)) throw new ThrottledBeforeWrite(error);
    throw error;
  }
}

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

//---------------------------------------------------------------------------------------------------------
//Runs the interested workflow for one polled call. Kept apart from touchpoint processing, with its own try,
//so neither step can stop the other from running on the same call.
//FLOW: 1. logInterestedDecision records the decision and returns matched tags. 2. no match -> nothing to do.
//3. match -> processAircallInterested (lib/aircall-interested.ts). 4. any throw is captured, not propagated.
//Returns whether Attio was written, for the run summary.
//---------------------------------------------------------------------------------------------------------
async function processInterestedTag(
  call: AircallCall,
  interested: ReadonlySet<string>,
  failures: string[],
): Promise<boolean> {
  //[DEBUG] Logs a decision for every call reaching this point, matched or not, so a quiet run is still accounted for.
  if (logInterestedDecision(call, interested).length === 0) return false;
  try {
    //Epoch seconds. endedAt is always set here - fetchAircallCalls drops calls without one.
    const result = await processAircallInterested(call, call.endedAt ?? call.startedAt);
    return result.status === "done";
  } catch (error) {
    failures.push(`Call ${call.id} (interested): ${errorMessage(error)}`);
    console.error(
      `[interested] poll call ${call.id}: FAILED and was passed over - ${errorMessage(error)}`,
    );
    return false;
  }
}

/** Places a call on the cursor timeline by when it finished, not when it started. */
export function aircallCursorEvent(call: AircallCall): CursorEvent {
  return { id: String(call.id), timestampMs: (call.endedAt ?? call.startedAt) * 1_000 };
}

//---------------------------------------------------------------------------------------------------------
//Records one call as a touchpoint. Writes no Person note by design - the call lives in Aircall and the Person
//only needs the count; the Company carries the note as the roll-up view.
//FLOW: 1. normalise the number to E.164. 2. match a Person on it. 3. require Master TAM membership.
//4. bump the Person counter. 5. if a Company is linked, note it and bump the Company counter.
//USES: toE164 (lib/phone.ts); findPersonByPhone, isPersonInList, incrementCounter, createNote,
//personCompanyId, personCounterSlug, companyCounterSlug (lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export async function processAircallTouchpoint(call: AircallCall): Promise<ProcessingOutcome> {
  //Attio stores E.164, so the punctuated raw_digits Aircall sends never matches a record as it stands.
  const phone = toE164(call.rawDigits);
  if (!phone) {
    console.log(`[event] aircall touchpoint call ${call.id}: skipped - the call carried no phone number`);
    return "skipped";
  }

  //[STABILITY] The filtered lookup, and the list read after it, are the whole pre-write region - see
  //beforeAnyWrite. incrementCounter below opens with a read too, but its PATCH is inside the same call, so a
  //failure there cannot be told apart from a failure after it and stays on the pass-over path.
  const person = await beforeAnyWrite(() => findPersonByPhone(phone));
  if (!person) {
    console.log(`[event] aircall touchpoint call ${call.id}: skipped - no Attio person has phone ${phone}`);
    return "skipped";
  }
  const personId = person.id.record_id;
  const personName = personLabel(person);
  //Master TAM is the gate on counting anything: off-list people are read but never written to.
  if (!(await beforeAnyWrite(() => isPersonInList(personId, LISTS.MASTER_TAM, personName)))) {
    console.log(`[event] aircall touchpoint call ${call.id}: skipped - person ${personName} is not on the Master TAM list`);
    return "not_tam";
  }

  const timestamp = new Date((call.endedAt ?? call.startedAt) * 1_000).toISOString();
  const durationMinutes = Math.round(call.duration / 60);
  const content = `**${timestamp}**\nDirection: ${call.direction ?? "unknown"}\nDuration: ${durationMinutes} min`;
  const title = `Aircall Touchpoint — ${timestamp}`;
  await incrementCounter("people", personId, personCounterSlug("aircall"), personName);

  //A Person with no Company records only the counter increment; there is nowhere to hang the note.
  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      title,
      `Aircall touchpoint with ${personDisplayName(person) ?? phone}:\n\n${content}`,
    );
    await incrementCounter("companies", companyId, companyCounterSlug("aircall"));
  }
  return "processed";
}

//---------------------------------------------------------------------------------------------------------
//Vercel Cron entry point, every ten minutes (`*/10 * * * *`). Runs two independent passes over one shared read
//of Aircall, under a wall-clock budget - see lib/run-budget.ts for why the cadence is what it is.
//
//FLOW:
// 1. isAuthorizedCron (lib/http.ts) - reject anything without the CRON_SECRET bearer.
// 2. getSyncCursor (lib/cursors.ts) - the ended_at high-water mark from Supabase.
// 3. Derive two floors and one window:
//      processFloorMs = whichever reaches further back, the cursor or the interested lookback.
//      fetchFromMs    = processFloorMs - MAX_CALL_DURATION_MS, because the API filters on creation time
//                       while everything below reasons in completion time.
// 4. fetchAircallCalls (lib/aircall.ts) - paginate the window, keep only finished calls, sort by completion.
// 5. Per call, two gates that do not interact:
//      interested - runs when the call finished at or after processFloorMs. Deliberately NOT cursor-gated;
//                   that is what lets a late-applied tag be seen. Duplicates are accepted here.
//      touchpoint - runs only when isAfterCursor passes. Exactly once per call, ever.
//    The MAX_CALL_DURATION_MS margin drags in older calls that both gates then reject, which is why the
//    interested gate is an explicit floor rather than "everything the fetch returned". At this cadence the
//    cursor is the wider of the two and so is what min() picks; the lookback is the backstop for runs that
//    land close together - see INTERESTED_LOOKBACK_MS.
// 6. advanceCursor past each handled call, whether or not its writes succeeded.
// 6a. Stop the loop if it is still going at the run budget, or if a call was throttled before writing anything,
//     leaving the cursor at the last call actually handled.
// 7. advanceCursorTo(upperBound - CURSOR_GRACE_MS) and persist - the park is SKIPPED on either stop, since the
//     calls the loop never reached are not dealt with and must stay above the mark.
//
//[STABILITY] A failed call is counted and passed over, never retried: its earlier writes are already committed,
//so a retry would duplicate them, and a permanently failing call would block the sync forever. THE EXCEPTION is
//a transient failure before the first write, which is safe to attempt again precisely because nothing is
//committed yet; that stops the run instead, and the next one starts on the call - see ThrottledBeforeWrite.
//---------------------------------------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  //[SECURITY] Runs before any external call, so an unauthorized request costs nothing.
  if (!isAuthorizedCron(request)) return json({ error: "Unauthorized" }, 401);
  try {
    //[PERF] Read before any network call: a missing or empty AIRCALL_INTERESTED_TAGS throws here, so a
    //misconfigured deployment fails without first paying for the multi-hour Aircall pull it cannot use.
    //[DEBUG] Also fails once per run with a named variable, rather than once per call.
    const interestedTags = interestedTagSet();
    const upperBoundMs = Date.now();
    let cursor = await getSyncCursor(SYNC_KEY, upperBoundMs);

    //Oldest completion this run will act on: whichever reaches further back, a cursor left behind by downtime
    //or the fixed lookback. Captured BEFORE the loop, because `cursor` advances inside it and a floor read from
    //the moving cursor would climb as the run progressed, skipping later calls in the same batch.
    const processFloorMs = Math.min(cursor.timestampMs, upperBoundMs - INTERESTED_LOOKBACK_MS);
    //Creation-time floor. See MAX_CALL_DURATION_MS - without this a long call is never seen finished in range.
    const fetchFromMs = processFloorMs - MAX_CALL_DURATION_MS;
    //Aircall orders by creation time; re-sort by completion so the cursor advances monotonically.
    const calls = [...(await fetchAircallCalls(fetchFromMs, upperBoundMs))].sort(
      (left, right) => aircallCursorEvent(left).timestampMs - aircallCursorEvent(right).timestampMs,
    );

    const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 };
    const failures: string[] = [];
    let interestedCount = 0;
    //[DEBUG] Most of what the fetch returns is reach, not scope: MAX_CALL_DURATION_MS pulls in an extra span of
    //already-handled calls so that one long recent call is reachable. Counting the in-scope subset separately
    //keeps the summary honest - without it, callsFound alone reads as though the run ignored most of its input.
    let inScopeCount = 0;

    //[STABILITY] The wall clock the loop stops at. Measured from upperBoundMs rather than a fresh Date.now(),
    //because upperBoundMs is read at the top of the handler and so the budget covers the Aircall pagination too -
    //a wide backlog spends real time there before the first call is ever processed.
    const budget = startRunBudget(upperBoundMs, "AIRCALL_SYNC_BUDGET_MS");
    //Number of calls the loop reached before it stopped, so a partial run can report what it left behind.
    let examinedCount = 0;
    //[DEBUG] Of those, the ones the TOUCHPOINT gate rejected as handled on an earlier run. Touchpoints only:
    //the interested gate above runs on reach, not on the cursor, so a call counted here may still have been
    //checked for tags. Counted so the summary accounts for the window instead of leaving a silent shortfall.
    let beforeCursorCount = 0;
    //Why the loop stopped early, if it did. Both reasons share one consequence - the cursor must NOT be parked
    //at now - so they are one value rather than two flags that could disagree.
    let stopReason: "budget" | "throttled" | null = null;

    for (const call of calls) {
      //[STABILITY] Checked before the call rather than after, so the budget is what remains for a whole call and
      //not what remains after one has already overrun it. Stopping here leaves `cursor` exactly where the last
      //completed call put it; everything past this point is untouched and still above the mark next run.
      if (budget.expired()) {
        stopReason = "budget";
        break;
      }
      examinedCount += 1;
      const event = aircallCursorEvent(call);
      //Interested gate. Rejects the calls the widened fetch dragged in purely for reach; everything at or above
      //the floor is checked, tagged or not, so the decision is logged either way.
      if (event.timestampMs >= processFloorMs) {
        inScopeCount += 1;
        if (await processInterestedTag(call, interestedTags, failures)) interestedCount += 1;
      }
      //Touchpoint gate. Everything at or below the mark has already been counted on an earlier run.
      if (!isAfterCursor(cursor, event)) {
        beforeCursorCount += 1;
        continue;
      }
      try {
        const outcome = await processAircallTouchpoint(call);
        results[outcome] += 1;
      } catch (error) {
        //[STABILITY] Throttled before writing anything: the one failure that is safe to attempt again. The
        //cursor is left BELOW this call and the run stops here, so the next run starts on it. Deliberately not
        //counted as a failure - nothing was lost, the work is deferred. See ThrottledBeforeWrite.
        if (error instanceof ThrottledBeforeWrite) {
          console.warn(
            `[event] aircall touchpoint call ${call.id}: throttled before writing anything - ${error.message}. The run stops here and the next one starts on this call, so nothing is lost and nothing is double-counted.`,
          );
          stopReason = "throttled";
          //Examined but not handled, so it counts towards what is left rather than what was done.
          examinedCount -= 1;
          break;
        }
        failures.push(`Call ${call.id} (touchpoint): ${errorMessage(error)}`);
        console.error(
          `[event] aircall touchpoint call ${call.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs. The one exception broke out
      //above, before reaching this line.
      cursor = advanceCursor(cursor, event);
    }

    const callsRemaining = calls.length - examinedCount;
    if (stopReason) {
      //[STABILITY] Do NOT park at now. Parking is a claim that everything up to that moment has been dealt with,
      //and on a stopped run it has not: the calls the loop never reached would be silently skipped forever.
      //Leaving the cursor at the last completed call is what makes the next run resume instead of restart.
      console.warn(
        stopReason === "budget"
          ? `[run] aircall sync: stopped after ${budgetSeconds(budget)}s of a ${calls.length}-call backlog with ${callsRemaining} call(s) still to do, cursor left at ${new Date(cursor.timestampMs).toISOString()} to resume from.${callsRemaining > examinedCount ? " More is left than was done - if that repeats, calls are arriving faster than they are processed and the cron cadence in vercel.json wants shortening." : ""}`
          : `[run] aircall sync: stopped by Attio throttling with ${callsRemaining} call(s) still to do, cursor left at ${new Date(cursor.timestampMs).toISOString()} to resume from. Nothing was lost; the next run starts on the call that was throttled. Repeated throttling means this sync is querying Attio faster than the account allows.`,
      );
    } else {
      //[STABILITY] Park short of now. A call Aircall has not yet published is picked up next run instead of skipped.
      cursor = advanceCursorTo(cursor, upperBoundMs - CURSOR_GRACE_MS);
    }
    await saveSyncCursor(cursor);
    console.log(
      `[run] aircall sync: ${calls.length} call(s) fetched from ${new Date(fetchFromMs).toISOString()} (reach), ${inScopeCount} completed at or after ${new Date(processFloorMs).toISOString()} (scope), ${beforeCursorCount} from before the cursor and already counted, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${interestedCount} interested, ${failures.length} failed and passed over, ${stopReason ? `STOPPED (${stopReason}) with ${callsRemaining} left` : "complete"}, cursor now ${new Date(cursor.timestampMs).toISOString()}`,
    );
    const body = {
      success: failures.length === 0,
      //callsFound is the whole fetch including the reach-back; callsInScope is what the run could act on.
      callsFound: calls.length,
      callsInScope: inScopeCount,
      //Part of callsFound rather than extra to it: the slice an earlier run had already counted as touchpoints.
      beforeCursor: beforeCursorCount,
      ...results,
      interested: interestedCount,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      //[DEBUG] A stopped run is a success, not a failure - it wrote everything it reached and saved its place.
      //It is reported so a manual run sees that a backlog remains rather than reading "complete" and moving on,
      //and stopReason separates "ran out of time" from "Attio throttled us", which want different responses.
      truncated: stopReason !== null,
      ...(stopReason ? { stopReason, callsRemaining } : {}),
      //[DEBUG] Errors are returned as well as logged, so a manual run reports failures without a log search.
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    return serverError("Aircall touchpoint sync error", error);
  }
}
