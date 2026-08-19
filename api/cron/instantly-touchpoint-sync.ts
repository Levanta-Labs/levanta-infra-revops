import {
  companyCounterSlug,
  createNote,
  findPersonByEmail,
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
import { isAuthorizedCron, json, serverError } from "../../lib/http.ts";
import { fetchInstantlyEmails, type InstantlyEmail } from "../../lib/instantly.ts";
import { errorMessage } from "../../lib/json.ts";

const SYNC_KEY = "instantly-touchpoints";

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

export function instantlyCursorEvent(email: InstantlyEmail): CursorEvent {
  return { id: email.id, timestampMs: Date.parse(email.timestampCreated) };
}

export async function processInstantlyTouchpoint(email: InstantlyEmail): Promise<ProcessingOutcome> {
  if (!email.leadEmail) return "skipped";
  const person = await findPersonByEmail(email.leadEmail);
  if (!person) return "skipped";
  const personId = person.id.record_id;
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM))) return "not_tam";

  const subject = email.subject ?? "(no subject)";
  const body = email.bodyText ?? "(no content)";
  const title = `${subject} — ${email.timestampEmail}`;
  await createNote("people", personId, title, body);
  await incrementCounter("people", personId, PERSON_COUNTER_SLUGS.instantly);

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
    let processingError: string | null = null;

    for (const email of emails) {
      const event = instantlyCursorEvent(email);
      if (!isAfterCursor(cursor, event)) continue;
      try {
        const outcome = await processInstantlyTouchpoint(email);
        results[outcome] += 1;
        cursor = advanceCursor(cursor, event);
      } catch (error) {
        processingError = `Email ${email.id}: ${errorMessage(error)}`;
        break;
      }
    }

    if (!processingError) cursor = advanceCursorTo(cursor, upperBoundMs);
    await saveSyncCursor(cursor);
    const body = {
      success: processingError === null,
      emailsFound: emails.length,
      ...results,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      ...(processingError ? { error: processingError } : {}),
    };
    return json(body, processingError ? 500 : 200);
  } catch (error) {
    return serverError("Instantly touchpoint sync error", error);
  }
}
