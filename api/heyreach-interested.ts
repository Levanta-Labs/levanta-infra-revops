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
  personLabel,
  type CreatePersonValues,
  type PersonNameInput,
} from "../lib/attio.js";
import {
  fetchHeyReachConversations,
  stopLeadInActiveCampaigns,
  type HeyReachMessage,
} from "../lib/heyreach.js";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js";
import { describeShape, isJsonObject, stringValue, type JsonObject } from "../lib/json.js";

export interface HeyReachInterestedFields {
  readonly profileUrl: string | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
}

//The relay's payload shape is not under our control and it differs by event type: a reply event nests the lead
//under `lead`, while the auto-tag events (lead auto tagged positive and its siblings) arrive flat, with the
//container name folded into every key - `leadProfileUrl` rather than `lead.profileUrl`. So keys are compared on
//their letters and digits alone, which makes `profileUrl`, `profile_url`, and `ProfileURL` one name, and every name
//below is accepted with a `lead` prefix as well.
//
//Only the lead is ever read, never the sending LinkedIn account that a HeyReach body also carries: matching on that
//URL would attach the touchpoint to the wrong person, or invent a Person record for our own sender. A container
//whose name mentions the sending side is skipped along with everything nested beneath it.

const PROFILE_URL_NAMES = ["profileUrl", "linkedInUrl", "linkedInProfileUrl", "publicProfileUrl", "linkedIn"] as const;
const EMAIL_NAMES = ["email", "emailAddress", "workEmail", "businessEmail"] as const;
const FIRST_NAME_NAMES = ["firstName", "givenName"] as const;
const LAST_NAME_NAMES = ["lastName", "surname", "familyName"] as const;
const COMPANY_NAMES = ["companyName", "company", "organization", "organizationName", "currentCompany"] as const;

const LEAD_CONTAINER_NAMES = [
  "lead",
  "leadProfile",
  "data",
  "body",
  "payload",
  "profile",
  "correspondentProfile",
  "contact",
  "person",
  "prospect",
] as const;

const SENDING_ACCOUNT_HINTS = ["account", "sender", "mailbox", "owner", "user", "seat", "member"] as const;

/** The letters and digits of a key, so one entry covers every casing and separator a relay might spell it with. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The accepted spellings of `names`: each on its own, and with the `lead` prefix a flattened payload adds. */
function keySet(names: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const name of names) {
    const normalized = normalizeKey(name);
    keys.add(normalized);
    keys.add(`lead${normalized}`);
  }
  return keys;
}

const PROFILE_URL_KEYS = keySet(PROFILE_URL_NAMES);
const EMAIL_KEYS = keySet(EMAIL_NAMES);
const FIRST_NAME_KEYS = keySet(FIRST_NAME_NAMES);
const LAST_NAME_KEYS = keySet(LAST_NAME_NAMES);
const COMPANY_KEYS = keySet(COMPANY_NAMES);
const LEAD_CONTAINER_KEYS: ReadonlySet<string> = new Set(LEAD_CONTAINER_NAMES.map(normalizeKey));

function namesSendingAccount(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENDING_ACCOUNT_HINTS.some((hint) => normalized.includes(hint));
}

//A bound on the walk below, so a payload that arrives deeply nested or self-referential cannot spin.
const MAX_CANDIDATES = 32;

//---------------------------------------------------------------------------------------------------------
//Every object worth searching for the lead, best candidate first.
//FLOW: breadth-first walk from the payload root, sorting each nested object into one of two buckets by the key
//that held it: a recognised lead container, or anything else. Returns containers, then the payload itself
//(a flat body keeps the lead's fields at the top level), then the remainder.
//[SECURITY] Any key naming the sending side is skipped along with everything beneath it, so the walk cannot
//return our own LinkedIn sender and cause a Person record to be created for it.
//[STABILITY] `seen` plus MAX_CANDIDATES bound the walk; a self-referential or deeply nested body cannot spin.
//---------------------------------------------------------------------------------------------------------
function leadCandidates(payload: JsonObject): readonly JsonObject[] {
  const containers: JsonObject[] = [];
  const others: JsonObject[] = [];
  const queue: JsonObject[] = [payload];
  const seen = new Set<JsonObject>([payload]);

  while (queue.length > 0 && containers.length + others.length < MAX_CANDIDATES) {
    const current = queue.shift();
    if (!current) break;
    for (const [key, value] of Object.entries(current)) {
      if (namesSendingAccount(key)) continue;
      //Arrays are containers, not a level of nesting: search their entries directly.
      for (const child of Array.isArray(value) ? value : [value]) {
        if (!isJsonObject(child) || seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
        if (LEAD_CONTAINER_KEYS.has(normalizeKey(key))) containers.push(child);
        else others.push(child);
      }
    }
  }
  return [...containers, payload, ...others];
}

function firstOf(source: JsonObject, keys: ReadonlySet<string>): string | null {
  for (const [key, value] of Object.entries(source)) {
    if (!keys.has(normalizeKey(key))) continue;
    const text = stringValue(value);
    if (text) return text;
  }
  return null;
}

function readFields(source: JsonObject): HeyReachInterestedFields {
  return {
    profileUrl: firstOf(source, PROFILE_URL_KEYS),
    email: firstOf(source, EMAIL_KEYS),
    firstName: firstOf(source, FIRST_NAME_KEYS),
    lastName: firstOf(source, LAST_NAME_KEYS),
    companyName: firstOf(source, COMPANY_KEYS),
  };
}

//---------------------------------------------------------------------------------------------------------
//Extracts the lead from a payload whose shape is not under our control.
//FLOW: 1. leadCandidates ranks the objects to try. 2. readFields reads all five fields off one candidate.
//3. first candidate carrying a profile URL or an email wins. 4. none -> log the shape and throw.
//All five fields come from the SAME object, so a name is never read off one record and pinned to another.
//---------------------------------------------------------------------------------------------------------
export function parseHeyReachInterestedWebhook(value: unknown): HeyReachInterestedFields {
  if (!isJsonObject(value)) throw new Error("HeyReach webhook payload must be an object");
  for (const candidate of leadCandidates(value)) {
    const fields = readFields(candidate);
    if (fields.profileUrl || fields.email) return fields;
  }
  //[DEBUG][SECURITY] describeShape reports keys and types only, never values, so an unmapped payload can be
  //diagnosed from the log without recording anybody's name, address, or message text.
  const shape = describeShape(value);
  console.error(
    `[route] heyreach-interested: rejected - no lead identifier found. Looked for ${PROFILE_URL_NAMES.join(", ")} and ${EMAIL_NAMES.join(", ")} - each also accepted with a lead prefix, in any casing - on every object except the sending account. Payload shape was ${shape}`,
  );
  throw new Error(
    `HeyReach webhook payload is missing profileUrl and email. Payload shape was ${shape}`,
  );
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

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. The relay posts here when a lead replies or is auto-tagged positive.
//
//FLOW:
// 1. hasWebhookSecret (lib/http.ts) - compare x-webhook-secret against HEYREACH_WEBHOOK_SECRET.
// 2. parseHeyReachInterestedWebhook - walk the payload for the lead, whatever shape it arrived in.
// 3. Resolve the person: LinkedIn URL first, then email, then create (lib/attio.ts).
// 4. ensureInterestedDeal - reuses any deal already linked to the person, creates one only when none exists.
// 5. fetchHeyReachConversations (lib/heyreach.ts) for the thread, rendered by formatHeyReachThread.
// 6. Note on the person and on the deal, patchPerson with blankPersonValues, add to the DNC list.
// 7. stopLeadInActiveCampaigns - the only provider-side write in the codebase; ends outbound sequencing.
//
//[SECURITY] Step 1 precedes the body read, so an unauthenticated caller never reaches the parser.
//[STABILITY] Steps 4-7 are separate calls with no transaction. A throw partway leaves earlier writes
//committed and returns 500; a relay retry would then repeat them, adding duplicate notes.
//KNOWN GAP: step 7 no-ops when the payload carried no profile URL, because StopLeadInCampaign is driven by
//leadUrl. Such a lead is recorded and DNC-listed in Attio but stays in its HeyReach sequence.
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "HEYREACH_WEBHOOK_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const fields = parseHeyReachInterestedWebhook(await requestJson(request));
    console.log(
      `[route] heyreach-interested: handling ${fields.profileUrl ?? fields.email ?? "a lead with no identifier"}`,
    );
    //URL first: it is the identifier HeyReach always carries and the one Attio stores for LinkedIn.
    let person = await findPersonByLinkedIn(fields.profileUrl);
    if (!person) person = await findPersonByEmail(fields.email);
    if (!person) person = await createPerson(personValues(fields));

    const personId = person.id.record_id;
    const personName = personLabel(person);
    const dealId = await ensureInterestedDeal(
      person,
      dealName(fields),
      defaultDealOwner(),
    );
    //Thread lookup is keyed on the profile URL only; an email-only lead gets a note saying no history was found.
    const conversations = fields.profileUrl
      ? await fetchHeyReachConversations({ profileUrl: fields.profileUrl })
      : [];
    const messages = conversations.flatMap((conversation) => conversation.messages);
    const history = formatHeyReachThread(messages);
    const title = LEAD_SOURCE_LABELS.heyreach;
    await createNote("people", personId, title, history, personName);
    await createNote("deals", dealId, title, history);
    //blankPersonValues strips any attribute Attio already holds, so this can only fill gaps.
    await patchPerson(
      personId,
      blankPersonValues(person, { ...personValues(fields), lead_source: title }),
      personName,
    );
    await addPersonToList(personId, LISTS.DNC, personName);
    //Last, so a failure to stop sequencing cannot cost the CRM record that was already written above.
    const campaignsStopped = await stopLeadInActiveCampaigns(fields.profileUrl, fields.email);
    console.log(
      `[route] heyreach-interested: completed - person ${personName}, deal ${dealId}, ${messages.length} message(s) summarised, ${campaignsStopped} campaign(s) stopped`,
    );
    return json({ success: true, personId, dealId, campaignsStopped });
  } catch (error) {
    return serverError("HeyReach interested webhook error", error);
  }
}
