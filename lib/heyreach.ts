import { credentialHint, HEYREACH_BASE, heyreachHeaders } from "./endpoints.js";
import {
  arrayValue,
  booleanValue,
  isJsonObject,
  numberValue,
  responseJson,
  stringValue,
} from "./json.js";

//Interface==================================================================

export interface HeyReachMessage {
  readonly createdAt: string;
  readonly body: string;
  readonly subject: string | null;
  readonly sender: string | null;
}

export interface HeyReachProfile {
  readonly linkedInId: string | null;
  readonly profileUrl: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
}

export interface HeyReachConversation {
  readonly id: string;
  readonly linkedInAccountId: number;
  readonly lastMessageAt: string;
  readonly profile: HeyReachProfile;
  readonly messages: readonly HeyReachMessage[];
}

export interface HeyReachConversationQuery {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly profileUrl?: string;
}

//===========================================================================

function parseMessage(value: unknown): HeyReachMessage {
  if (!isJsonObject(value)) throw new Error("HeyReach returned an invalid message");
  const createdAt = stringValue(value.createdAt);
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("HeyReach message is missing a valid createdAt timestamp");
  }
  return {
    createdAt,
    body: stringValue(value.body) ?? "",
    subject: stringValue(value.subject),
    sender: stringValue(value.sender),
  };
}

function parseProfile(value: unknown): HeyReachProfile {
  if (!isJsonObject(value)) throw new Error("HeyReach conversation is missing correspondentProfile");
  const profileUrl = stringValue(value.profileUrl);
  if (!profileUrl) throw new Error("HeyReach correspondent profile is missing profileUrl");
  return {
    linkedInId: stringValue(value.linkedin_id),
    profileUrl,
    firstName: stringValue(value.firstName),
    lastName: stringValue(value.lastName),
    companyName: stringValue(value.companyName),
  };
}

export function parseHeyReachConversation(value: unknown): HeyReachConversation {
  if (!isJsonObject(value)) throw new Error("HeyReach returned an invalid conversation");
  const id = stringValue(value.id);
  const linkedInAccountId = numberValue(value.linkedInAccountId);
  const lastMessageAt = stringValue(value.lastMessageAt);
  if (!id || linkedInAccountId === null || !lastMessageAt) {
    throw new Error("HeyReach conversation is missing id, account, or timestamp");
  }
  return {
    id,
    linkedInAccountId,
    lastMessageAt,
    profile: parseProfile(value.correspondentProfile),
    messages: arrayValue(value, "messages").map(parseMessage),
  };
}

//---------------------------------------------------------------------------------------------------------
//Reads conversations with their full message lists, paginated. Two callers: the touchpoint cron passes a time
//window, the interested webhook passes one profile URL.
//FLOW: 1. POST a page with the query folded into the filters block. 2. parse items. 3. follow nextCursor while
//hasNextPage. 4. a truncated page (hasNextPage with no cursor) throws rather than silently returning less.
//[PERF] HeyReach applies from/to with DAY granularity, not to the minute: any `from` inside today returns every
//conversation touched since UTC midnight, each with its full message list, however narrow the window asked for.
//A five-minute run therefore routinely receives messages hours or days old, and the volume grows through the
//day. Rounding always goes DOWN to the start of the day, so the result over-includes and no message can slip
//past a window boundary. Deduplication is the per-message cursor check in the sync handler, not this filter.
//USES: heyreachHeaders, credentialHint (endpoints.ts); responseJson, arrayValue, booleanValue (json.ts).
//---------------------------------------------------------------------------------------------------------
export async function fetchHeyReachConversations(
  query: HeyReachConversationQuery,
): Promise<readonly HeyReachConversation[]> {
  const conversations: HeyReachConversation[] = [];
  let cursor: string | null = null;

  do {
    const response = await fetch(`${HEYREACH_BASE}/inbox/GetConversationsV3`, {
      method: "POST",
      headers: heyreachHeaders(),
      body: JSON.stringify({
        limit: 100,
        cursor,
        ...(query.fromMs !== undefined ? { from: new Date(query.fromMs).toISOString() } : {}),
        ...(query.toMs !== undefined ? { to: new Date(query.toMs).toISOString() } : {}),
        //Every filter must be present even when unused; the API rejects a partial filters block.
        filters: {
          linkedInAccountIds: [],
          campaignIds: [],
          searchString: "",
          leadLinkedInId: null,
          leadProfileUrl: query.profileUrl ?? null,
          tags: [],
          latestAutoTagNames: [],
          seen: null,
        },
      }),
    });
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(`HeyReach API error ${response.status}: ${JSON.stringify(body)}${credentialHint("heyreach", response.status)}`);
    }
    if (!isJsonObject(body)) throw new Error("HeyReach conversations response is invalid");
    conversations.push(...arrayValue(body, "items").map(parseHeyReachConversation));
    const hasNextPage = booleanValue(body.hasNextPage) ?? false;
    cursor = hasNextPage ? stringValue(body.nextCursor) : null;
    if (hasNextPage && !cursor) throw new Error("HeyReach response omitted nextCursor");
  } while (cursor);

  return conversations;
}

/**
 * A stable per-message ID. HeyReach gives messages none, and the cursor needs one to tell events apart at the
 * same timestamp, so the identity is a SHA-256 of the fields that define the message. Deterministic across
 * runs, which is what makes it usable as a duplicate key; two byte-identical messages in one conversation at
 * one instant collapse to a single event.
 */
export async function heyReachMessageId(
  conversation: HeyReachConversation,
  message: HeyReachMessage,
): Promise<string> {
  //NUL-joined so no combination of field values can produce the same input as a different combination.
  const input = [
    conversation.id,
    message.createdAt,
    message.sender ?? "",
    message.subject ?? "",
    message.body,
  ].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface HeyReachCampaign {
  readonly campaignId: number;
  readonly campaignStatus: string;
  readonly leadStatus: string;
}

function parseCampaign(value: unknown): HeyReachCampaign {
  if (!isJsonObject(value)) throw new Error("HeyReach returned an invalid campaign");
  const campaignId = numberValue(value.campaignId);
  const campaignStatus = stringValue(value.campaignStatus);
  const leadStatus = stringValue(value.leadStatus);
  if (campaignId === null || !campaignStatus || !leadStatus) {
    throw new Error("HeyReach campaign is missing required fields");
  }
  return { campaignId, campaignStatus, leadStatus };
}

//---------------------------------------------------------------------------------------------------------
//Ends outbound sequencing for a lead who has said yes. The only provider-side write in the codebase.
//FLOW: 1. no profile URL -> 0, see below. 2. list the lead's campaigns. 3. keep those where both the campaign
//and the lead's place in it are still live. 4. stop each. 5. return how many were stopped.
//[STABILITY] A failed stop throws and is not retried; the caller has already written the CRM record.
//KNOWN GAP: step 1 returns early because StopLeadInCampaign is driven by leadUrl, which an email-only lead
//does not supply. The lookup at step 2 would accept the email; the stop at step 4 would not. Such a lead stays
//in sequence. Closing this needs the leadMemberId from the step-2 response, which parseCampaign discards.
//---------------------------------------------------------------------------------------------------------
export async function stopLeadInActiveCampaigns(
  profileUrl: string | null,
  email: string | null,
): Promise<number> {
  if (!profileUrl) return 0;
  const response = await fetch(`${HEYREACH_BASE}/campaign/GetCampaignsForLead`, {
    method: "POST",
    headers: heyreachHeaders(),
    body: JSON.stringify({ email, linkedinId: null, profileUrl, offset: 0, limit: 100 }),
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new Error(`HeyReach campaign lookup failed ${response.status}: ${JSON.stringify(body)}${credentialHint("heyreach", response.status)}`);
  }
  if (!isJsonObject(body)) throw new Error("HeyReach campaigns response is invalid");
  //Both dimensions must be live. A paused campaign still counts: it can be resumed and would resume messaging.
  //A lead already finished or replied-out of a campaign has nothing left to stop.
  const activeCampaignStatuses = new Set(["IN_PROGRESS", "PAUSED", "STARTING"]);
  const activeLeadStatuses = new Set(["Pending", "InSequence", "Paused"]);
  const campaigns = arrayValue(body, "items")
    .map(parseCampaign)
    .filter(
      (campaign) =>
        activeCampaignStatuses.has(campaign.campaignStatus) &&
        activeLeadStatuses.has(campaign.leadStatus),
    );

  for (const campaign of campaigns) {
    const stopResponse = await fetch(`${HEYREACH_BASE}/campaign/StopLeadInCampaign`, {
      method: "POST",
      headers: heyreachHeaders(),
      body: JSON.stringify({ campaignId: campaign.campaignId, leadMemberId: null, leadUrl: profileUrl }),
    });
    if (!stopResponse.ok) {
      throw new Error(
        `HeyReach failed to stop lead in campaign ${campaign.campaignId} (${stopResponse.status}): ${await stopResponse.text()}${credentialHint("heyreach", stopResponse.status)}`,
      );
    }
  }
  return campaigns.length;
}
