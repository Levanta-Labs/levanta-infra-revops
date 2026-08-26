import {
  addPersonToList,
  blankPersonValues,
  createNote,
  createPerson,
  defaultDealOwner,
  ensureInterestedDeal,
  findPersonByEmail,
  findPersonByLinkedIn,
  LEAD_SOURCE_LABELS,
  LISTS,
  patchPerson,
  type CreatePersonValues,
  type PersonNameInput,
} from "../lib/attio.js";
import {
  fetchHeyReachConversations,
  stopLeadInActiveCampaigns,
  type HeyReachMessage,
} from "../lib/heyreach.js";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js";
import { describeShape, isJsonObject, objectValue, stringValue, type JsonObject } from "../lib/json.js";

export interface HeyReachInterestedFields {
  readonly profileUrl: string | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
}

//The relay's payload shape is not under our control, so accept the conventional spellings of each field. Only the
//lead container is searched, never the whole payload: a HeyReach body also carries the *sending* LinkedIn account,
//and matching on that URL would attach the touchpoint to the wrong person or invent a Person record for it.

const LEAD_CONTAINERS = ["lead", "data", "body", "profile", "correspondentProfile"] as const;

const PROFILE_URL_KEYS = [
  "profileUrl",
  "profile_url",
  "linkedInUrl",
  "linkedinUrl",
  "linkedin_url",
  "linkedInProfileUrl",
  "linkedin_profile_url",
] as const;

const EMAIL_KEYS = ["email", "emailAddress", "email_address"] as const;
const FIRST_NAME_KEYS = ["firstName", "first_name"] as const;
const LAST_NAME_KEYS = ["lastName", "last_name"] as const;
const COMPANY_KEYS = ["companyName", "company_name", "company"] as const;

/** The nested object the lead's fields live on, or the payload itself when it is already flat. */
function leadObject(payload: JsonObject): JsonObject {
  for (const key of LEAD_CONTAINERS) {
    const nested = objectValue(payload, key);
    if (nested) return nested;
  }
  return payload;
}

function firstOf(source: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = stringValue(source[key]);
    if (value) return value;
  }
  return null;
}

export function parseHeyReachInterestedWebhook(value: unknown): HeyReachInterestedFields {
  if (!isJsonObject(value)) throw new Error("HeyReach webhook payload must be an object");
  const lead = leadObject(value);
  const fields = {
    profileUrl: firstOf(lead, PROFILE_URL_KEYS),
    email: firstOf(lead, EMAIL_KEYS),
    firstName: firstOf(lead, FIRST_NAME_KEYS),
    lastName: firstOf(lead, LAST_NAME_KEYS),
    companyName: firstOf(lead, COMPANY_KEYS),
  };
  if (!fields.profileUrl && !fields.email) {
    //Report the structure, never the values, so the next occurrence names the fields to map instead of needing a
    //guess about what the relay sent.
    const shape = describeShape(value);
    console.error(
      `[route] heyreach-interested: rejected - no lead identifier found. Looked for ${PROFILE_URL_KEYS.join(", ")} and ${EMAIL_KEYS.join(", ")} on the lead object. Payload shape was ${shape}`,
    );
    throw new Error(
      `HeyReach webhook payload is missing profileUrl and email. Payload shape was ${shape}`,
    );
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
    console.log(
      `[route] heyreach-interested: handling ${fields.profileUrl ?? fields.email ?? "a lead with no identifier"}`,
    );
    let person = await findPersonByLinkedIn(fields.profileUrl);
    if (!person) person = await findPersonByEmail(fields.email);
    if (!person) person = await createPerson(personValues(fields));

    const personId = person.id.record_id;
    const dealId = await ensureInterestedDeal(
      person,
      dealName(fields),
      defaultDealOwner(),
    );
    const conversations = fields.profileUrl
      ? await fetchHeyReachConversations({ profileUrl: fields.profileUrl })
      : [];
    const messages = conversations.flatMap((conversation) => conversation.messages);
    const history = formatHeyReachThread(messages);
    const title = LEAD_SOURCE_LABELS.heyreach;
    await createNote("people", personId, title, history);
    await createNote("deals", dealId, title, history);
    await patchPerson(
      personId,
      blankPersonValues(person, { ...personValues(fields), lead_source: title }),
    );
    await addPersonToList(personId, LISTS.DNC);
    const campaignsStopped = await stopLeadInActiveCampaigns(fields.profileUrl, fields.email);
    console.log(
      `[route] heyreach-interested: completed - person ${personId}, deal ${dealId}, ${messages.length} message(s) summarised, ${campaignsStopped} campaign(s) stopped`,
    );
    return json({ success: true, personId, dealId, campaignsStopped });
  } catch (error) {
    return serverError("HeyReach interested webhook error", error);
  }
}
