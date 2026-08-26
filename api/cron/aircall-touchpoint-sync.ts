import { fetchAircallCalls, toE164, type AircallCall } from "../../lib/aircall.js";
import { interestedTagSet, logInterestedDecision, processAircallInterested } from "../aircall-interested.js";
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
  getSyncCursor,
  isAfterCursor,
  saveSyncCursor,
  type CursorEvent,
} from "../../lib/cursors.js";
import { errorMessage } from "../../lib/json.js";
import { isAuthorizedCron, json, serverError } from "../../lib/http.js";

const SYNC_KEY = "aircall-touchpoints";

//An outcome tag is applied after the call, sometimes minutes after, so the cursor can carry a call out of the window
//before the tag it is wanted for exists. Every run therefore re-reads this far back for the interested check alone.
//Calls inside it are re-checked even though the cursor has passed them, which means an interested call is handled on
//two consecutive runs and its notes are written twice. That is the intended trade: a duplicate note can be deleted,
//a missed booking is gone silently. The touchpoint counters stay cursor-gated, so they are never double-counted.
const INTERESTED_LOOKBACK_MS = 10 * 60 * 1_000;

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

/**
 * Runs the interested workflow for a call the poll found already tagged. It is kept apart from the touchpoint
 * processing above, and given its own try, so that neither step can stop the other from running on the same call.
 * Returns whether it wrote anything, for the run summary.
 */
async function processInterestedTag(
  call: AircallCall,
  interested: ReadonlySet<string>,
  failures: string[],
): Promise<boolean> {
  //Logs the decision for every call the poll looked at, matched or not, so a quiet run is still accounted for.
  if (logInterestedDecision(call, "poll", interested).length === 0) return false;
  try {
    const result = await processAircallInterested(call, call.endedAt ?? call.startedAt, "poll");
    return result.status === "done";
  } catch (error) {
    failures.push(`Call ${call.id} (interested): ${errorMessage(error)}`);
    console.error(
      `[interested] poll call ${call.id}: FAILED and was passed over - ${errorMessage(error)}`,
    );
    return false;
  }
}

export function aircallCursorEvent(call: AircallCall): CursorEvent {
  return { id: String(call.id), timestampMs: (call.endedAt ?? call.startedAt) * 1_000 };
}

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
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM, personName))) {
    console.log(`[event] aircall touchpoint call ${call.id}: skipped - person ${personName} is not on the Master TAM list`);
    return "not_tam";
  }

  const timestamp = new Date((call.endedAt ?? call.startedAt) * 1_000).toISOString();
  const durationMinutes = Math.round(call.duration / 60);
  const content = `**${timestamp}**\nDirection: ${call.direction ?? "unknown"}\nDuration: ${durationMinutes} min`;
  const title = `Aircall Touchpoint — ${timestamp}`;
  await incrementCounter("people", personId, personCounterSlug("aircall"), personName);

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

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const upperBoundMs = Date.now();
    let cursor = await getSyncCursor(SYNC_KEY, upperBoundMs);

    //Whichever reaches further back: a cursor behind after downtime, or the fixed interested lookback.
    const windowStartMs = Math.min(cursor.timestampMs, upperBoundMs - INTERESTED_LOOKBACK_MS);
    const calls = [...(await fetchAircallCalls(windowStartMs, upperBoundMs))].sort(
      (left, right) => aircallCursorEvent(left).timestampMs - aircallCursorEvent(right).timestampMs,
    );

    const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 };
    const failures: string[] = [];
    //Read up front, so a missing or empty list fails the run once with a named variable rather than per call.
    const interestedTags = interestedTagSet();
    let interestedCount = 0;

    for (const call of calls) {
      const event = aircallCursorEvent(call);
      //Ahead of the cursor check, because a call the cursor has already passed is exactly the one whose tag arrived
      //late, and it is the only reason the window reaches back at all.
      if (await processInterestedTag(call, interestedTags, failures)) interestedCount += 1;
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

    cursor = advanceCursorTo(cursor, upperBoundMs);
    await saveSyncCursor(cursor);
    console.log(
      `[run] aircall sync: ${calls.length} call(s) in window (from ${new Date(windowStartMs).toISOString()}), ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${interestedCount} interested, ${failures.length} failed and passed over, cursor now ${new Date(cursor.timestampMs).toISOString()}`,
    );
    const body = {
      success: failures.length === 0,
      callsFound: calls.length,
      ...results,
      interested: interestedCount,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    return serverError("Aircall touchpoint sync error", error);
  }
}
