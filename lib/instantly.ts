import { credentialHint, INSTANTLY_BASE, instantlyAuthHeader } from "./endpoints.js";
import {
  arrayValue,
  errorMessage,
  isJsonObject,
  objectValue,
  responseJson,
  stringValue,
  type JsonObject,
} from "./json.js";

export type InstantlyEmailType = "received" | "sent" | "scheduled" | "unknown";

//---------------------------------------------------------------------------------------------------------
//Single transport for every Instantly call. Nothing else in this module calls fetch.
//FLOW: 1. prefix with INSTANTLY_BASE. 2. attach the bearer under any caller override. 3. parse the body.
//4. non-2xx -> throw, with credentialHint naming INSTANTLY_API_KEY on a 401/403.
//[SECURITY] The key is read from env per request by instantlyAuthHeader and never cached in module state.
//---------------------------------------------------------------------------------------------------------
async function instantlyFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${INSTANTLY_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: instantlyAuthHeader(),
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new Error(
      `Instantly API error ${response.status}: ${JSON.stringify(body)}${credentialHint("instantly", response.status)}`,
    );
  }
  return body;
}

//Interfaces=======================================================================================

export interface InstantlyEmail {
  readonly id: string;
  readonly timestampCreated: string;
  readonly timestampEmail: string;
  readonly emailType: InstantlyEmailType;
  readonly leadEmail: string | null;
  readonly isAutoReply: boolean;
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly threadId: string | null;
}

//=================================================================================================

function parseEmailType(value: unknown): InstantlyEmailType {
  if (value === 1 || value === 3) return "sent";
  if (value === 2) return "received";
  if (value === 4) return "scheduled";
  return "unknown";
}

export function parseInstantlyEmail(value: unknown): InstantlyEmail {
  if (!isJsonObject(value)) throw new Error("Instantly returned an invalid email");
  const id = stringValue(value.id);
  const timestampCreated = stringValue(value.timestamp_created);
  const timestampEmail = stringValue(value.timestamp_email) ?? timestampCreated;
  const leadEmail = stringValue(value.lead);
  if (!id || !timestampCreated || !timestampEmail) {
    throw new Error("Instantly email is missing id or timestamp");
  }
  if (!Number.isFinite(Date.parse(timestampCreated)) || !Number.isFinite(Date.parse(timestampEmail))) {
    throw new Error("Instantly email has an invalid timestamp");
  }
  const body = objectValue(value, "body");
  return {
    id,
    timestampCreated,
    timestampEmail,
    emailType: parseEmailType(value.ue_type),
    leadEmail,
    isAutoReply: value.is_auto_reply === 1,
    subject: stringValue(value.subject),
    bodyText: stringValue(body?.text),
    threadId: stringValue(value.thread_id),
  };
}

export interface InstantlyEmailQuery {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly leadEmail?: string;
}

//---------------------------------------------------------------------------------------------------------
//Reads emails, paginated. Two callers with different shapes of query: the touchpoint cron passes a time
//window, the interested webhook passes a lead address and no bounds (the whole thread for that lead).
//FLOW: 1. build a page from whichever query fields are set. 2. GET. 3. parse items. 4. follow
//next_starting_after until absent.
//Filters are on timestamp_created, which is also what the cron keys its cursor on, so window and cursor agree.
//USES: instantlyAuthHeader, credentialHint (endpoints.ts); responseJson, arrayValue (json.ts).
//---------------------------------------------------------------------------------------------------------
export async function fetchInstantlyEmails(
  query: InstantlyEmailQuery,
): Promise<readonly InstantlyEmail[]> {
  const emails: InstantlyEmail[] = [];
  let startingAfter: string | null = null;

  do {
    //Ascending, so the caller's cursor advances monotonically as it walks the result.
    const params = new URLSearchParams({ limit: "100", sort_order: "asc" });
    //Minus one millisecond: the bound is treated as exclusive, and an email sitting exactly on the cursor
    //timestamp must still be returned. The caller's isAfterCursor check discards it if it was already handled.
    if (query.fromMs !== undefined) {
      params.set("min_timestamp_created", new Date(Math.max(0, query.fromMs - 1)).toISOString());
    }
    if (query.toMs !== undefined) {
      params.set("max_timestamp_created", new Date(query.toMs).toISOString());
    }
    if (query.leadEmail) params.set("lead", query.leadEmail);
    if (startingAfter) params.set("starting_after", startingAfter);

    const body = await instantlyFetch(`/emails?${params}`);
    if (!isJsonObject(body)) throw new Error("Instantly emails response is invalid");
    emails.push(...arrayValue(body, "items").map(parseInstantlyEmail));
    startingAfter = stringValue(body.next_starting_after);
  } while (startingAfter);

  return emails;
}

//=============================================================================================================
//The lead record, and the blocklist.
//
//The lead_interested webhook body is thin - an event type, an address, and sometimes a name. Everything worth
//enriching Attio with (job title, LinkedIn URL, phone, industry, headcount, revenue, location, company address)
//lives on the lead record instead, under the custom-variable payload, so the interested route reads it back.
//=============================================================================================================

export interface InstantlyLead {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly jobTitle: string | null;
  readonly phone: string | null;
  readonly companyName: string | null;
  readonly companyDomain: string | null;
  readonly website: string | null;
  readonly linkedin: string | null;
  readonly location: string | null;
  readonly companyAddress: string | null;
  readonly industry: string | null;
  readonly employeeCount: string | null;
  readonly annualRevenue: string | null;
}

//The payload is a workspace's own custom variables, so its keys are whatever whoever built the campaign typed:
//"# Employees", "Annual Revenue", "Company Address", "linkedIn". Keys are therefore compared on their letters
//and digits alone, which makes "# Employees" and "employees" one name and survives a variable being renamed to
//a different casing or punctuation.
function normalizePayloadKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The first payload value whose key matches any of `names`, compared on letters and digits alone. */
function payloadValue(payload: JsonObject | null, names: readonly string[]): string | null {
  if (!payload) return null;
  const wanted = new Set(names.map(normalizePayloadKey));
  for (const [key, value] of Object.entries(payload)) {
    if (!wanted.has(normalizePayloadKey(key))) continue;
    const text = stringValue(value);
    if (text) return text;
  }
  return null;
}

//---------------------------------------------------------------------------------------------------------
//One lead record, flattened. Top-level fields win over the payload's copies of them: Instantly promotes the
//standard variables up top and keeps the raw uploaded value below, and the promoted one is the one it acts on.
//---------------------------------------------------------------------------------------------------------
export function parseInstantlyLead(value: unknown): InstantlyLead {
  if (!isJsonObject(value)) throw new Error("Instantly returned an invalid lead");
  const email = stringValue(value.email);
  if (!email) throw new Error("Instantly lead is missing an email address");
  const payload = objectValue(value, "payload");
  return {
    email,
    firstName: stringValue(value.first_name) ?? payloadValue(payload, ["firstName"]),
    lastName: stringValue(value.last_name) ?? payloadValue(payload, ["lastName"]),
    jobTitle: stringValue(value.job_title) ?? payloadValue(payload, ["jobTitle", "title"]),
    phone: stringValue(value.phone) ?? payloadValue(payload, ["phone"]),
    companyName: stringValue(value.company_name) ?? payloadValue(payload, ["companyName"]),
    companyDomain: stringValue(value.company_domain),
    website: stringValue(value.website) ?? payloadValue(payload, ["website"]),
    linkedin: payloadValue(payload, ["linkedIn", "linkedInUrl", "linkedinProfile"]),
    location: payloadValue(payload, ["location", "city"]),
    companyAddress: payloadValue(payload, ["companyAddress", "address"]),
    industry: payloadValue(payload, ["industry"]),
    employeeCount: payloadValue(payload, ["# Employees", "employees", "employeeCount", "companySize"]),
    annualRevenue: payloadValue(payload, ["Annual Revenue", "revenue", "annualRevenue"]),
  };
}

//---------------------------------------------------------------------------------------------------------
//The lead record behind an address, or null when Instantly holds none.
//FLOW: 1. free-text search on the address. 2. keep only an EXACT case-insensitive match on `email`.
//Step 2 matters: `search` is fuzzy and will happily return a different lead at the same company, whose job
//title and LinkedIn URL would then be written onto the wrong Attio person. A near miss is treated as no match.
//[STABILITY] Enrichment only. Every caller treats null as "nothing extra to add", never as a failure, so a
//lead Instantly cannot find still gets recorded from the webhook body alone.
//---------------------------------------------------------------------------------------------------------
export async function fetchInstantlyLead(email: string): Promise<InstantlyLead | null> {
  const body = await instantlyFetch("/leads/list", {
    method: "POST",
    body: JSON.stringify({ search: email, limit: 10 }),
  });
  if (!isJsonObject(body)) throw new Error("Instantly leads response is invalid");
  const wanted = email.toLowerCase();
  for (const item of arrayValue(body, "items")) {
    if (!isJsonObject(item)) continue;
    if (stringValue(item.email)?.toLowerCase() !== wanted) continue;
    const lead = parseInstantlyLead(item);
    console.log(`[lookup] instantly lead ${email}: matched, ${describeInstantlyLead(lead)}`);
    return lead;
  }
  console.log(`[lookup] instantly lead ${email}: no exact match, so nothing is enriched from Instantly`);
  return null;
}

/** [DEBUG] Which enrichment fields arrived, by name only - never their values, which are personal data. */
function describeInstantlyLead(lead: InstantlyLead): string {
  const present = Object.entries(lead)
    .filter(([key, value]) => key !== "email" && value !== null)
    .map(([key]) => key);
  return present.length > 0 ? `carrying ${present.join(", ")}` : "carrying nothing beyond the address";
}

//---------------------------------------------------------------------------------------------------------
//Adds an address to the workspace blocklist, so no campaign can mail it again.
//Part of the suppression that runs for every interested lead whatever platform reported the interest - see
//suppressInterestedLead (lib/interested.ts). A lead who said yes on the phone must stop receiving cold email.
//[STABILITY] The caller does not check whether the address is already blocked, and whether Instantly treats a
//re-block as success or as an error is NOT verified. It does not need to be: suppression collects failures
//rather than raising them, so the worst case is one logged failure on an address that was already suppressed.
//---------------------------------------------------------------------------------------------------------
export async function blockInstantlyLead(value: string): Promise<void> {
  try {
    await instantlyFetch("/block-lists-entries", {
      method: "POST",
      body: JSON.stringify({ bl_value: value }),
    });
    console.log(`[action] instantly blocklist: added ${value}`);
  } catch (error) {
    console.error(`[action] FAILED - instantly blocklist could not add ${value}: ${errorMessage(error)}`);
    throw error;
  }
}
