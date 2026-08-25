import {
  companyCounterSlug,
  createNote,
  findPersonByLinkedIn,
  incrementCounter,
  isPersonInList,
  LISTS,
  personCompanyId,
  personCounterSlug,
  personDisplayName,
} from "../../lib/attio.js";
import {
  advanceCursor,
  advanceCursorTo,
  getSyncCursor,
  isAfterCursor,
  saveSyncCursor,
  type CursorEvent,
} from "../../lib/cursors.js";
import {
  fetchHeyReachConversations,
  heyReachMessageId,
  type HeyReachConversation,
  type HeyReachMessage,
} from "../../lib/heyreach.js";
import { isAuthorizedCron, json, serverError } from "../../lib/http.js";
import { errorMessage } from "../../lib/json.js";

const SYNC_KEY = "heyreach-touchpoints";

type ProcessingOutcome = "processed" | "skipped" | "not_tam";

export interface HeyReachTouchpointEvent {
  readonly conversation: HeyReachConversation;
  readonly message: HeyReachMessage;
  readonly cursor: CursorEvent;
}

export async function heyReachTouchpointEvents(
  conversations: readonly HeyReachConversation[],
): Promise<readonly HeyReachTouchpointEvent[]> {
  const events: HeyReachTouchpointEvent[] = [];
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      events.push({
        conversation,
        message,
        cursor: {
          id: await heyReachMessageId(conversation, message),
          timestampMs: Date.parse(message.createdAt),
        },
      });
    }
  }
  return events.sort((left, right) => left.cursor.timestampMs - right.cursor.timestampMs);
}

export async function processHeyReachTouchpoint(
  event: HeyReachTouchpointEvent,
): Promise<ProcessingOutcome> {
  const person = await findPersonByLinkedIn(event.conversation.profile.profileUrl);
  if (!person) {
    console.log(
      `[event] heyreach message ${event.cursor.id}: skipped - no Attio person has ${event.conversation.profile.profileUrl}`,
    );
    return "skipped";
  }
  const personId = person.id.record_id;
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM))) {
    console.log(
      `[event] heyreach message ${event.cursor.id}: skipped - person ${personId} is not on the Master TAM list`,
    );
    return "not_tam";
  }

  const profile = event.conversation.profile;
  const leadName = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || "HeyReach conversation";
  const title = `${event.message.subject ?? leadName} — ${event.message.createdAt}`;
  const body = event.message.body || "(no message content)";
  await createNote("people", personId, title, body);
  await incrementCounter("people", personId, personCounterSlug("heyreach"));

  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      title,
      `HeyReach message with ${personDisplayName(person) ?? leadName}:\n\n${body}`,
    );
    await incrementCounter("companies", companyId, companyCounterSlug("heyreach"));
  }
  return "processed";
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedCron(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const upperBoundMs = Date.now();
    let cursor = await getSyncCursor(SYNC_KEY, upperBoundMs);
    const conversations = await fetchHeyReachConversations({
      fromMs: cursor.timestampMs,
      toMs: upperBoundMs,
    });
    const events = await heyReachTouchpointEvents(conversations);
    const results: Record<ProcessingOutcome, number> = { processed: 0, skipped: 0, not_tam: 0 };
    const failures: string[] = [];

    for (const event of events) {
      if (!isAfterCursor(cursor, event.cursor)) continue;
      try {
        const outcome = await processHeyReachTouchpoint(event);
        results[outcome] += 1;
      } catch (error) {
        failures.push(`Message ${event.cursor.id}: ${errorMessage(error)}`);
        console.error(
          `[event] heyreach message ${event.cursor.id}: FAILED and passed over - ${errorMessage(error)}. Whatever it already wrote stays as it is, and it will not be attempted again.`,
        );
      }
      //The cursor advances whether or not the touchpoint succeeded. A failed event is passed over after one
      //attempt rather than blocking every later event on this and all future runs.
      cursor = advanceCursor(cursor, event.cursor);
    }

    cursor = advanceCursorTo(cursor, upperBoundMs);
    await saveSyncCursor(cursor);
    console.log(
      `[run] heyreach sync: ${conversations.length} conversation(s) and ${events.length} message(s) in window, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${failures.length} failed and passed over, cursor now ${new Date(cursor.timestampMs).toISOString()}`,
    );
    const body = {
      success: failures.length === 0,
      conversationsScanned: conversations.length,
      messagesFound: events.length,
      ...results,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    return serverError("HeyReach touchpoint sync error", error);
  }
}
