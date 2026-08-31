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

const SYNC_KEY = "aircall-touchpoints";

//An outcome tag is applied after the call, sometimes minutes after, so a cursor alone can carry a call past the
//interested check before the tag it is wanted for exists. This widens how far back that check looks, measured
//on ended_at, for the interested workflow alone. Touchpoint counters stay cursor-gated regardless and are never
//double-counted.
//
//It is a FLOOR, not a window: the effective floor is min(cursor, now - this). It therefore binds only while it
//reaches further back than the cursor does - that is, while it is wider than the inter-run gap.
//
//AT THE CURRENT HOURLY CADENCE IT DOES NOT NORMALLY BIND. The cursor sits about 62 minutes back (the gap plus
//CURSOR_GRACE_MS), so min() picks the cursor and real tag tolerance is that 62 minutes, not this ten. The
//constant takes effect only when two runs land within ten minutes of each other - a manual trigger behind a
//scheduled one, or a retry - which is worth keeping it for, but it does not set tolerance day to day.
//
//So the hourly cursor is the real floor, and it gives: ~62 minutes of tolerance, which against this workspace's
//tag history catches 66 of 67 hand-applied tags (only the 165-minute outlier is missed), and ONE check per
//interested call, so its notes are written once. At the former five-minute cadence this constant did bind, and
//deliberately overlapped: every interested call was checked on two consecutive runs and its notes written twice
//- accepted because a duplicate note can be deleted while a missed booking is gone silently.
//
//To make it bind again, shorten the cadence below ten minutes or widen this value past the gap. Widening trades
//coverage for duplicates: notes are rewritten once per run the floor still covers, so the count is this value
//divided by the cadence.
const INTERESTED_LOOKBACK_MS = 10 * 60 * 1_000;

//[STABILITY] How far back the API window must reach BEYOND the oldest completion this run cares about.
//Aircall filters /calls on a call's creation time; this sync places calls on the timeline by ended_at. A call
//is therefore visible to the query from the moment it starts, but is discarded by fetchAircallCalls until it
//is "done". Without this margin a call lasting longer than the window is filtered out on every run that covers
//its start, then falls out of range before it ever appears finished - lost entirely, tag and touchpoint alike.
//[PERF] This widens every request; page count scales with it. Lower it if pagination becomes expensive, but
//never below the longest call the account actually makes.
//
//CEILING: a call is caught while its duration is under roughly this value. Precisely, the run that first sees
//it finished needs start >= processFloor - this, and at the hourly cadence processFloor trails the completion
//by up to the inter-run gap, so the safe duration is about this value plus CURSOR_GRACE_MS. At two hours that
//is calls up to ~2h02m. A longer call is dropped in full - no touchpoint, no tag - and dropped SILENTLY: it
//never reaches the fetch, so no counter, log line, or failure records that it existed.
const MAX_CALL_DURATION_MS = 2 * 60 * 60 * 1_000;

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

  const person = await findPersonByPhone(phone);
  if (!person) {
    console.log(`[event] aircall touchpoint call ${call.id}: skipped - no Attio person has phone ${phone}`);
    return "skipped";
  }
  const personId = person.id.record_id;
  const personName = personLabel(person);
  //Master TAM is the gate on counting anything: off-list people are read but never written to.
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM, personName))) {
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
//Vercel Cron entry point, hourly (`0 * * * *`). Runs two independent passes over one shared read of Aircall.
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
//    interested gate is an explicit floor rather than "everything the fetch returned". At the hourly cadence
//    the two floors nearly coincide, since the cursor is what min() picks - see INTERESTED_LOOKBACK_MS.
// 6. advanceCursor past each handled call, whether or not its writes succeeded.
// 7. advanceCursorTo(upperBound - CURSOR_GRACE_MS) and persist.
//
//[STABILITY] A failed call is counted and passed over, never retried: its earlier writes are already committed,
//so a retry would duplicate them, and a permanently failing call would block the sync forever.
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

    for (const call of calls) {
      const event = aircallCursorEvent(call);
      //Interested gate. Rejects the calls the widened fetch dragged in purely for reach; everything at or above
      //the floor is checked, tagged or not, so the decision is logged either way.
      if (event.timestampMs >= processFloorMs) {
        inScopeCount += 1;
        if (await processInterestedTag(call, interestedTags, failures)) interestedCount += 1;
      }
      //Touchpoint gate. Everything at or below the mark has already been counted on an earlier run.
      if (!isAfterCursor(cursor, event)) continue;
      try {
        const outcome = await processAircallTouchpoint(call);
        results[outcome] += 1;
      } catch (error) {
        failures.push(`Call ${call.id} (touchpoint): ${errorMessage(error)}`);
        console.error(
          `[event] aircall touchpoint call ${call.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs.
      cursor = advanceCursor(cursor, event);
    }

    //[STABILITY] Park short of now. A call Aircall has not yet published is picked up next run instead of skipped.
    cursor = advanceCursorTo(cursor, upperBoundMs - CURSOR_GRACE_MS);
    await saveSyncCursor(cursor);
    console.log(
      `[run] aircall sync: ${calls.length} call(s) fetched from ${new Date(fetchFromMs).toISOString()} (reach), ${inScopeCount} completed at or after ${new Date(processFloorMs).toISOString()} (scope), ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${interestedCount} interested, ${failures.length} failed and passed over, cursor now ${new Date(cursor.timestampMs).toISOString()}`,
    );
    const body = {
      success: failures.length === 0,
      //callsFound is the whole fetch including the reach-back; callsInScope is what the run could act on.
      callsFound: calls.length,
      callsInScope: inScopeCount,
      ...results,
      interested: interestedCount,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      //[DEBUG] Errors are returned as well as logged, so a manual run reports failures without a log search.
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    return serverError("Aircall touchpoint sync error", error);
  }
}
