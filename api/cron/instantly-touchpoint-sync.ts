import {
  companyCounterSlug,
  createNote,
  findPersonByEmail,
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
import { isAuthorizedCron, json, serverError } from "../../lib/http.js";
import { fetchInstantlyEmails, type InstantlyEmail } from "../../lib/instantly.js";
import { errorMessage } from "../../lib/json.js";

const SYNC_KEY = "instantly-touchpoints";

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

export function instantlyCursorEvent(email: InstantlyEmail): CursorEvent {
  return { id: email.id, timestampMs: Date.parse(email.timestampCreated) };
}

export async function processInstantlyTouchpoint(email: InstantlyEmail): Promise<ProcessingOutcome> {
  if (!email.leadEmail) {
    console.log(`[event] instantly email ${email.id}: skipped - no lead email on the record`);
    return "skipped";
  }
  const person = await findPersonByEmail(email.leadEmail);
  if (!person) {
    console.log(`[event] instantly email ${email.id}: skipped - no Attio person has ${email.leadEmail}`);
    return "skipped";
  }
  const personId = person.id.record_id;
  const personName = personLabel(person);
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM, personName))) {
    console.log(`[event] instantly email ${email.id}: skipped - person ${personName} is not on the Master TAM list`);
    return "not_tam";
  }

  const subject = email.subject ?? "(no subject)";
  const body = email.bodyText ?? "(no content)";
  const title = `${subject} — ${email.timestampEmail}`;
  await createNote("people", personId, title, body, personName);
  await incrementCounter("people", personId, personCounterSlug("instantly"), personName);

  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      title,
      `Instantly email with ${personDisplayName(person) ?? email.leadEmail}:\n\n${body}`,
    );
    await incrementCounter("companies", companyId, companyCounterSlug("instantly"));
  }
  return "processed";
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const upperBoundMs = Date.now();
    let cursor = await getSyncCursor(SYNC_KEY, upperBoundMs);
    const emails = [...(await fetchInstantlyEmails({ fromMs: cursor.timestampMs, toMs: upperBoundMs }))]
      .filter(
        (email) =>
          (email.emailType === "sent" || email.emailType === "received") && !email.isAutoReply,
      )
      .sort(
        (left, right) =>
          instantlyCursorEvent(left).timestampMs - instantlyCursorEvent(right).timestampMs,
      );
    const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 };
    const failures: string[] = [];

    for (const email of emails) {
      const event = instantlyCursorEvent(email);
      if (!isAfterCursor(cursor, event)) continue;
      try {
        const outcome = await processInstantlyTouchpoint(email);
        results[outcome] += 1;
      } catch (error) {
        failures.push(`Email ${email.id}: ${errorMessage(error)}`);
        console.error(
          `[event] instantly email ${email.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs.
      cursor = advanceCursor(cursor, event);
    }

    cursor = advanceCursorTo(cursor, upperBoundMs);
    await saveSyncCursor(cursor);
    console.log(
      `[run] instantly sync: ${emails.length} email(s) in window, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${failures.length} failed and passed over, cursor now ${new Date(cursor.timestampMs).toISOString()}`,
    );
    const body = {
      success: failures.length === 0,
      emailsFound: emails.length,
      ...results,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    return serverError("Instantly touchpoint sync error", error);
  }
}
