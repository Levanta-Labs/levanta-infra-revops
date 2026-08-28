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

//---------------------------------------------------------------------------------------------------------
//Flattens conversations into one chronological message stream with a stable ID per message.
//HeyReach gives messages no ID of their own, so heyReachMessageId (lib/heyreach.ts) hashes the conversation
//ID, timestamp, sender, subject, and body into one. Identical content in the same conversation at the same
//instant collapses to one event, which is the correct outcome.
//[PERF] Hashing is per message and the fetch returns whole days, so callers skip spent conversations first.
//---------------------------------------------------------------------------------------------------------
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

//---------------------------------------------------------------------------------------------------------
//Records one LinkedIn message as a touchpoint on the Person and, when linked, the Company.
//FLOW: 1. match a Person on the correspondent's profile URL. 2. require Master TAM membership. 3. note plus
//counter on the Person. 4. note plus counter on the Company when one is linked.
//USES: findPersonByLinkedIn, isPersonInList, createNote, incrementCounter, personCompanyId, personCounterSlug,
//companyCounterSlug (lib/attio.ts).
//---------------------------------------------------------------------------------------------------------
export async function processHeyReachTouchpoint(
  event: HeyReachTouchpointEvent,
): Promise<ProcessingOutcome> {
  //The correspondent is the lead. The sending LinkedIn account is never matched on - that would attach the
  //touchpoint to our own sender.
  const person = await findPersonByLinkedIn(event.conversation.profile.profileUrl);
  if (!person) {
    console.log(
      `[event] heyreach message ${event.cursor.id}: skipped - no Attio person has ${event.conversation.profile.profileUrl}`,
    );
    return "skipped";
  }
  const personId = person.id.record_id;
  const personName = personLabel(person);
  //Master TAM is the gate on counting anything: off-list people are read but never written to.
  if (!(await isPersonInList(personId, LISTS.MASTER_TAM, personName))) {
    console.log(
      `[event] heyreach message ${event.cursor.id}: skipped - person ${personName} is not on the Master TAM list`,
    );
    return "not_tam";
  }

  const profile = event.conversation.profile;
  const leadName = `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim() || "HeyReach conversation";
  const title = `${event.message.subject ?? leadName} — ${event.message.createdAt}`;
  const body = event.message.body || "(no message content)";
  await createNote("people", personId, title, body, personName);
  await incrementCounter("people", personId, personCounterSlug("heyreach"), personName);

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

//---------------------------------------------------------------------------------------------------------
//Vercel Cron entry point, every five minutes.
//FLOW: 1. isAuthorizedCron (lib/http.ts). 2. getSyncCursor (lib/cursors.ts). 3. fetchHeyReachConversations
//(lib/heyreach.ts). 4. heyReachTouchpointEvents flattens them to a chronological message stream. 5. per
//message, skip anything at or below the mark, else processHeyReachTouchpoint. 6. advance the mark. 7. park at
//(now - CURSOR_GRACE_MS) and persist.
//[PERF] HeyReach applies from/to with DAY granularity, so a five-minute run receives every conversation
//touched since UTC midnight, each with its full message list, and hashes every message before the cursor
//rejects it. Cost grows through the day. Skipping conversations with no activity past the mark would avoid
//most of it; deliberately not done, so the per-message check in step 5 absorbs the whole load.
//[STABILITY] A failed message is counted and passed over, never retried - its earlier writes are committed.
//---------------------------------------------------------------------------------------------------------
export async function GET(request: Request): Promise<Response> {
  //[SECURITY] Runs before any external call, so an unauthorized request costs nothing.
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
      //Everything at or below the mark was handled on an earlier run - this is the authoritative guard.
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

    //[STABILITY] Park short of now. A message HeyReach has not yet published is picked up next run, not skipped.
    cursor = advanceCursorTo(cursor, upperBoundMs - CURSOR_GRACE_MS);
    await saveSyncCursor(cursor);
    console.log(
      `[run] heyreach sync: ${conversations.length} conversation(s) and ${events.length} message(s) returned, ${results.processed} processed, ${results.skipped} skipped, ${results.not_tam} not on TAM, ${failures.length} failed and passed over, cursor now ${new Date(cursor.timestampMs).toISOString()}`,
    );
    const body = {
      success: failures.length === 0,
      conversationsScanned: conversations.length,
      messagesFound: events.length,
      ...results,
      failed: failures.length,
      cursorTimestamp: new Date(cursor.timestampMs).toISOString(),
      //[DEBUG] Errors are returned as well as logged, so a manual run reports failures without a log search.
      ...(failures.length > 0 ? { errors: failures } : {}),
    };
    return json(body, failures.length > 0 ? 500 : 200);
  } catch (error) {
    return serverError("HeyReach touchpoint sync error", error);
  }
}
