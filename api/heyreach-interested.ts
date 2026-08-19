import {
  addPersonToList,
  createNote,
  createPerson,
  ensureInterestedDeal,
  findPersonByEmail,
  findPersonByLinkedIn,
  LEAD_SOURCE_LABELS,
  LISTS,
  patchPerson,
  type CreatePersonValues,
  type PersonNameInput,
} from "../lib/attio.ts";
import { requiredEnv } from "../lib/env.ts";
import {
  fetchHeyReachConversations,
  stopLeadInActiveCampaigns,
  type HeyReachMessage,
} from "../lib/heyreach.ts";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.ts";
import { isJsonObject, objectValue, stringValue } from "../lib/json.ts";

export interface HeyReachInterestedFields {
  readonly profileUrl: string | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
}

export function parseHeyReachInterestedWebhook(value: unknown): HeyReachInterestedFields {
  if (!isJsonObject(value)) throw new Error("HeyReach relay payload must be an object");
  const lead = objectValue(value, "lead") ?? value;
  const fields = {
    profileUrl: stringValue(lead.profileUrl) ?? stringValue(lead.linkedInUrl),
    email: stringValue(lead.email),
    firstName: stringValue(lead.firstName),
    lastName: stringValue(lead.lastName),
    companyName: stringValue(lead.companyName),
  };
  if (!fields.profileUrl && !fields.email) {
    throw new Error("HeyReach relay payload is missing profileUrl and email");
  }
  return fields;
}

export function formatHeyReachThread(messages: readonly HeyReachMessage[]): string {
  if (messages.length === 0) return "No message history found.";
  return [...messages]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((message) => `**${message.createdAt}**\n${message.body}`)
    .join("\n\n---\n\n");
}

function personValues(fields: HeyReachInterestedFields): CreatePersonValues {
  const values: {
    linkedin?: string;
    email_addresses?: readonly string[];
    name?: readonly PersonNameInput[];
  } = {};
  if (fields.profileUrl) values.linkedin = fields.profileUrl;
  if (fields.email) values.email_addresses = [fields.email];
  if (fields.firstName || fields.lastName) {
    const firstName = fields.firstName ?? "";
    const lastName = fields.lastName ?? "";
    values.name = [{ first_name: firstName, last_name: lastName, full_name: `${firstName} ${lastName}`.trim() }];
  }
  return values;
}

function dealName(fields: HeyReachInterestedFields): string {
  if (fields.companyName) return `${fields.companyName} - Interested`;
  return `${fields.firstName ?? ""} ${fields.lastName ?? ""}`.trim() || "New Interested Deal";
}

export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "HEYREACH_WEBHOOK_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const fields = parseHeyReachInterestedWebhook(await requestJson(request));
    let person = await findPersonByLinkedIn(fields.profileUrl);
    if (!person) person = await findPersonByEmail(fields.email);
    if (!person) person = await createPerson(personValues(fields));

    const personId = person.id.record_id;
    const dealId = await ensureInterestedDeal(
      person,
      dealName(fields),
      requiredEnv("ATTIO_DEFAULT_DEAL_OWNER"),
    );
    const conversations = fields.profileUrl
      ? await fetchHeyReachConversations({ profileUrl: fields.profileUrl })
      : [];
    const messages = conversations.flatMap((conversation) => conversation.messages);
    const history = formatHeyReachThread(messages);
    const title = LEAD_SOURCE_LABELS.heyreach;
    await createNote("people", personId, title, history);
    await createNote("deals", dealId, title, history);
    await patchPerson(personId, { lead_source: title });
    await addPersonToList(personId, LISTS.DNC);
    const campaignsStopped = await stopLeadInActiveCampaigns(fields.profileUrl, fields.email);
    return json({ success: true, personId, dealId, campaignsStopped });
  } catch (error) {
    return serverError("HeyReach interested webhook error", error);
  }
}
