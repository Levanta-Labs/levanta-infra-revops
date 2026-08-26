import { fetchAircallCalls, type AircallCall } from "../../lib/aircall.js";
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

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

export function aircallCursorEvent(call: AircallCall): CursorEvent {
  return { id: String(call.id), timestampMs: (call.endedAt ?? call.startedAt) * 1_000 };
}

export async function processAircallTouchpoint(call: AircallCall): Promise<ProcessingOutcome> {
  const phone = call.rawDigits;
  if (!phone) {
    console.log(`[event] aircall call ${call.id}: skipped - the call carried no phone number`);
    return "skipped";
  }

  const person = await findPersonByPhone(phone);
  if (!person) {
    console.log(`[event] aircall call ${call.id}: skipped - no Attio person has phone ${phone}`);
    return "skipped";
  }
  const personId = person.id.record_id;
  const personName = personLabel(person);
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM, personName))) {
    console.log(`[event] aircall call ${call.id}: skipped - person ${personName} is not on the Master TAM list`);
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

    const calls = [...(await fetchAircallCalls(cursor.timestampMs, upperBoundMs))].sort(
      (left, right) => aircallCursorEvent(left).timestampMs - aircallCursorEvent(right).timestampMs,
    );

    const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 };
    const failures: string[] = [];

    for (const call of calls) {
      const event = aircallCursorEvent(call);
      if (!isAfterCursor(cursor, event)) continue;
      try {
        const outcome = await processAircallTouchpoint(call);
        results[outcome] += 1;
      } catch (error) {
        failures.push(`Call ${call.id}: ${errorMessage(error)}`);
        console.error(
          `[event] aircall call ${call.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs.
      cursor = advanceCursor(cursor, event);
    }

    cursor = advanceCursorTo(cursor, upperBoundMs);
    await saveSyncCursor(cursor);
    console.log(
      `[run] aircall sync: ${calls.length} call(s) in window, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${failures.length} failed and passed over, cursor now ${new Date(cursor.timestampMs).toISOString()}`,
    );
    const body = {
      success: failures.length === 0,
      callsFound: calls.length,
      ...results,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    return serverError("Aircall touchpoint sync error", error);
  }
}
