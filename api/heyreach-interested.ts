import { findPersonByEmail, findPersonByLinkedIn } from "../lib/attio.js";
import {
  fetchHeyReachConversations,
  type HeyReachMessage,
  type HeyReachProfile,
} from "../lib/heyreach.js";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js";
import {
  interestedLead,
  recordInterestedLead,
  type InterestedLead,
} from "../lib/interested.js";
import { describeShape, isJsonObject, stringValue, type JsonObject } from "../lib/json.js";

export interface HeyReachInterestedFields {
  readonly profileUrl: string | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly campaignName: string | null;
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
const CAMPAIGN_NAMES = ["campaignName", "campaign", "sequenceName"] as const;

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
const CAMPAIGN_KEYS = keySet(CAMPAIGN_NAMES);
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
    campaignName: firstOf(source, CAMPAIGN_KEYS),
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

/** [LOGIC] Oldest first, so the note reads top to bottom. USES: nothing. Pure. */
export function formatHeyReachThread(messages: readonly HeyReachMessage[]): string {
  if (messages.length === 0) return "No message history found.";
  return [...messages]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((message) => `**${message.createdAt}**\n${message.body}`)
    .join("\n\n---\n\n");
}

//---------------------------------------------------------------------------------------------------------
//The lead as the shared workflow sees it: the webhook body, plus whatever the conversation's correspondent
//profile adds.
//That profile costs nothing extra. The route already fetches the conversation for the note, and every entry
//carries the lead's position, headline, location, company, and all three of HeyReach's address fields - which
//this route previously discarded by flat-mapping straight to `.messages`.
//Webhook values win where both carry the same field: the webhook describes the event that just happened.
//USES: interestedLead (lib/interested.ts). Pure.
//---------------------------------------------------------------------------------------------------------
export function heyReachLead(
  fields: HeyReachInterestedFields,
  profile: HeyReachProfile | null,
  occurredAtMs: number,
): InterestedLead {
  //HeyReach spells an address three ways and any of them may be the only one set. Order is confidence: what
  //the workspace entered by hand, then what HeyReach enriched, then whatever the profile itself carried.
  const emails = [
    fields.email,
    profile?.customEmailAddress ?? null,
    profile?.enrichedEmailAddress ?? null,
    profile?.emailAddress ?? null,
  ].filter((email): email is string => Boolean(email));

  return interestedLead("heyreach", {
    emails: [...new Set(emails)],
    linkedin: fields.profileUrl ?? profile?.profileUrl ?? null,
    firstName: fields.firstName ?? profile?.firstName ?? null,
    lastName: fields.lastName ?? profile?.lastName ?? null,
    jobTitle: profile?.position ?? null,
    //The headline is what the person says they do; `about` is the longer version. Either beats nothing.
    description: profile?.headline ?? profile?.about ?? null,
    location: profile?.location ?? null,
    companyName: fields.companyName ?? profile?.companyName ?? null,
    campaignName: fields.campaignName,
    occurredAtMs,
  });
}

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. The relay posts here when a lead replies or is auto-tagged positive.
//
//FLOW:
// 1. hasWebhookSecret (lib/http.ts) - compare x-webhook-secret against HEYREACH_WEBHOOK_SECRET.
// 2. parseHeyReachInterestedWebhook - walk the payload for the lead, whatever shape it arrived in.
// 3. fetchHeyReachConversations (lib/heyreach.ts) for the thread, which also yields the correspondent profile
//    the mapping enriches from. Keyed on the profile URL only; an email-only lead gets neither.
// 4. recordInterestedLead (lib/interested.ts) - the sequence every provider shares. HeyReach contributes the
//    person lookup (profile URL first, then address) and the thread note.
//
//[SECURITY] Step 1 precedes the body read, so an unauthenticated caller never reaches the parser.
//[STABILITY] Step 4 is a series of calls with no transaction. A throw partway leaves earlier writes committed
//and returns 500; a relay retry would then repeat them, adding duplicate notes.
//Ending HeyReach sequencing is no longer done here: it is one channel of suppressInterestedLead, which runs
//for every interested lead whatever platform reported it. Its known gap - a lead with no profile URL cannot be
//stopped, because StopLeadInCampaign is driven by leadUrl - now reports itself as a skipped channel.
//USES: hasWebhookSecret, json, requestJson, serverError (lib/http.ts); findPersonByLinkedIn, findPersonByEmail
//(lib/attio.ts); fetchHeyReachConversations (lib/heyreach.ts); recordInterestedLead (lib/interested.ts).
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

    //Fetched before the workflow rather than inside it, because the profile it carries feeds the mapping and
    //the mapping is the workflow's input. One request either way.
    const conversations = fields.profileUrl
      ? await fetchHeyReachConversations({ profileUrl: fields.profileUrl })
      : [];
    const messages = conversations.flatMap((conversation) => conversation.messages);
    //Any conversation for this lead carries the same correspondent; the first is as good as any.
    const profile = conversations[0]?.profile ?? null;

    const outcome = await recordInterestedLead({
      lead: heyReachLead(fields, profile, Date.now()),
      subject: "heyreach-interested",
      //URL first: it is the identifier HeyReach always carries and the one Attio stores for LinkedIn.
      findPerson: async () =>
        (await findPersonByLinkedIn(fields.profileUrl)) ?? (await findPersonByEmail(fields.email)),
      history: async () => formatHeyReachThread(messages),
    });

    console.log(
      `[route] heyreach-interested: ${messages.length} message(s) summarised, ${outcome.suppression.failures.length} platform(s) failed to suppress`,
    );
    return json({
      success: true,
      personId: outcome.personId,
      dealId: outcome.dealId,
      companyId: outcome.companyId,
      suppression: outcome.suppression.outcomes,
      ...(outcome.suppression.failures.length > 0 ? { suppressionErrors: outcome.suppression.failures } : {}),
    });
  } catch (error) {
    return serverError("HeyReach interested webhook error", error);
  }
}
