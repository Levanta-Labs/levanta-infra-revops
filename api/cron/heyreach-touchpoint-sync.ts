import {
  companyCounterSlug,
  createNote,
  findPersonByLinkedIn,
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
import {
  fetchHeyReachConversations,
  heyReachMessageId,
  type HeyReachConversation,
  type HeyReachMessage,
} from "../../lib/heyreach.ts";
import { isAuthorizedCron, json, serverError } from "../../lib/http.ts";
import { errorMessage } from "../../lib/json.ts";

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
  if (!person) return "skipped";
  const personId = person.id.record_id;
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM))) return "not_tam";

  const profile = event.conversation.profile;
  const leadName = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || "HeyReach conversation";
  const title = `${event.message.subject ?? leadName} — ${event.message.createdAt}`;
  const body = event.message.body || "(no message content)";
  await createNote("people", personId, title, body);
  await incrementCounter("people", personId, PERSON_COUNTER_SLUGS.heyreach);

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
    let processingError: string | null = null;

    for (const event of events) {
      if (!isAfterCursor(cursor, event.cursor)) continue;
      try {
        const outcome = await processHeyReachTouchpoint(event);
        results[outcome] += 1;
        cursor = advanceCursor(cursor, event.cursor);
      } catch (error) {
        processingError = `Message ${event.cursor.id}: ${errorMessage(error)}`;
        break;
      }
    }

    if (!processingError) cursor = advanceCursorTo(cursor, upperBoundMs);
    await saveSyncCursor(cursor);
    const body = {
      success: processingError === null,
      conversationsScanned: conversations.length,
      messagesFound: events.length,
      ...results,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      ...(processingError ? { error: processingError } : {}),
    };
    return json(body, processingError ? 500 : 200);
  } catch (error) {
    return serverError("HeyReach touchpoint sync error", error);
  }
}
