import { HEYREACH_BASE, heyreachHeaders } from "./endpoints.js";
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
      throw new Error(`HeyReach API error ${response.status}: ${JSON.stringify(body)}`);
    }
    if (!isJsonObject(body)) throw new Error("HeyReach conversations response is invalid");
    conversations.push(...arrayValue(body, "items").map(parseHeyReachConversation));
    const hasNextPage = booleanValue(body.hasNextPage) ?? false;
    cursor = hasNextPage ? stringValue(body.nextCursor) : null;
    if (hasNextPage && !cursor) throw new Error("HeyReach response omitted nextCursor");
  } while (cursor);

  return conversations;
}

export async function heyReachMessageId(
  conversation: HeyReachConversation,
  message: HeyReachMessage,
): Promise<string> {
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
    throw new Error(`HeyReach campaign lookup failed ${response.status}: ${JSON.stringify(body)}`);
  }
  if (!isJsonObject(body)) throw new Error("HeyReach campaigns response is invalid");
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
        `HeyReach failed to stop lead in campaign ${campaign.campaignId} (${stopResponse.status}): ${await stopResponse.text()}`,
      );
    }
  }
  return campaigns.length;
}
