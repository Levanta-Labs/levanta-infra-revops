import { fetchAircallCalls, type AircallCall } from "../../lib/aircall.ts";
import {
  companyCounterSlug,
  createNote,
  findPersonByPhone,
  incrementCounter,
  isPersonInList,
  LISTS,
  PERSON_COUNTER_SLUGS,
  personCompanyId,
  personDisplayName,
} from "../../lib/attio.ts";
import {
  advanceCursor,
  advanceCursorTo,
  getSyncCursor,
  isAfterCursor,
  saveSyncCursor,
  type CursorEvent,
} from "../../lib/cursors.ts";
import { errorMessage } from "../../lib/json.ts";
import { isAuthorizedCron, json, serverError } from "../../lib/http.ts";

const SYNC_KEY = "aircall-touchpoints";

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

export function aircallCursorEvent(call: AircallCall): CursorEvent {
  return { id: String(call.id), timestampMs: (call.endedAt ?? call.startedAt) * 1_000 };
}

export async function processAircallTouchpoint(call: AircallCall): Promise<ProcessingOutcome> {
  const phone = call.rawDigits;
  if (!phone) return "skipped";

  const person = await findPersonByPhone(phone);
  if (!person) return "skipped";
  const personId = person.id.record_id;
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM))) return "not_tam";

  const timestamp = new Date((call.endedAt ?? call.startedAt) * 1_000).toISOString();
  const durationMinutes = Math.round(call.duration / 60);
  const content = `**${timestamp}**\nDirection: ${call.direction ?? "unknown"}\nDuration: ${durationMinutes} min`;
  const title = `Aircall Touchpoint — ${timestamp}`;
  await createNote("people", personId, title, content);
  await incrementCounter("people", personId, PERSON_COUNTER_SLUGS.aircall);

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
    let processingError: string | null = null;

    for (const call of calls) {
      const event = aircallCursorEvent(call);
      if (!isAfterCursor(cursor, event)) continue;
      try {
        const outcome = await processAircallTouchpoint(call);
        results[outcome] += 1;
        cursor = advanceCursor(cursor, event);
      } catch (error) {
        processingError = `Call ${call.id}: ${errorMessage(error)}`;
        break;
      }
    }

    if (!processingError) cursor = advanceCursorTo(cursor, upperBoundMs);
    await saveSyncCursor(cursor);
    const body = {
      success: processingError === null,
      callsFound: calls.length,
      ...results,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      ...(processingError ? { error: processingError } : {}),
    };
    return json(body, processingError ? 500 : 200);
  } catch (error) {
    return serverError("Aircall touchpoint sync error", error);
  }
}
