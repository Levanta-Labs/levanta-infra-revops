import {
  addPersonToList,
  blankPersonValues,
  createNote,
  createPerson,
  defaultDealOwner,
  ensureInterestedDeal,
  findPersonByEmail,
  findPersonByPhone,
  LEAD_SOURCE_LABELS,
  LISTS,
  patchPerson,
  personLabel,
  type CreatePersonValues,
  type PersonNameInput,
} from "../lib/attio.js";
import { parseAircallWebhook, toE164, type AircallCall } from "../lib/aircall.js";
import { requiredCsvEnv, requiredEnv } from "../lib/env.js";
import { json, requestJson, serverError } from "../lib/http.js";

export interface AircallInterestedFields {
  readonly email: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly direction: string | null;
  readonly duration: number;
  readonly tags: readonly string[];
  readonly occurredAt: number;
}

export function extractAircallFields(call: AircallCall, occurredAt: number): AircallInterestedFields {
  return {
    email: call.contact?.email ?? null,
    //Normalised here rather than at the lookup, so the number written back to Attio is E.164 too.
    phone: toE164(call.rawDigits),
    firstName: call.contact?.firstName ?? null,
    lastName: call.contact?.lastName ?? null,
    companyName: call.contact?.companyName ?? null,
    direction: call.direction,
    duration: call.duration,
    tags: call.tags.map((tag) => tag.name),
    occurredAt,
  };
}

export function buildCallHistorySummary(fields: AircallInterestedFields): string {
  const durationMinutes = Math.round(fields.duration / 60);
  return [
    `**Aircall interaction — ${new Date(fields.occurredAt * 1_000).toISOString()}**`,
    `- Direction: ${fields.direction ?? "unknown"}`,
    `- Duration: ${durationMinutes} min`,
    fields.tags.length > 0 ? `- Tags: ${fields.tags.join(", ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function personValues(fields: AircallInterestedFields): CreatePersonValues {
  const values: {
    email_addresses?: readonly string[];
    phone_numbers?: readonly string[];
    name?: readonly PersonNameInput[];
  } = {};
  if (fields.email) values.email_addresses = [fields.email];
  if (fields.phone) values.phone_numbers = [fields.phone];
  if (fields.firstName || fields.lastName) {
    const firstName = fields.firstName ?? "";
    const lastName = fields.lastName ?? "";
    values.name = [{ first_name: firstName, last_name: lastName, full_name: `${firstName} ${lastName}`.trim() }];
  }
  return values;
}

function dealName(fields: AircallInterestedFields): string {
  if (fields.companyName) return `${fields.companyName} - Interested`;
  return `${fields.firstName ?? ""} ${fields.lastName ?? ""}`.trim() || "New Interested Deal";
}

//=============================================================================================================
//The interested workflow itself, kept free of anything HTTP so both callers can drive it: the webhook below, which
//reacts to a single tagged call, and the touchpoint cron, which finds tagged calls by polling. Aircall applies the
//outcome tag after the call, sometimes minutes after, so neither caller sees every tag on its own.
//=============================================================================================================

/** Which caller drove the workflow, so a log line says whether a webhook or the poll found the call. */
export type InterestedSource = "webhook" | "poll";

export type InterestedResult =
  | { readonly status: "done"; readonly personId: string; readonly dealId: string }
  | { readonly status: "no_contact_details" };

/** The configured interested tags, lowercased for comparison. Read once per request or run, never per call. */
export function interestedTagSet(): ReadonlySet<string> {
  return new Set(requiredCsvEnv("AIRCALL_INTERESTED_TAGS").map((tag) => tag.toLowerCase()));
}

/** The interested tags carried by this call, as Aircall spells them. Empty means the call is not interested. */
export function matchedInterestedTags(call: AircallCall, interested: ReadonlySet<string>): readonly string[] {
  return call.tags.map((tag) => tag.name).filter((tag) => interested.has(tag.toLowerCase()));
}

/**
 * Records an interested call in Attio: the person, the deal, a note on each, the lead source, and the DNC listing.
 * `occurredAt` is in epoch seconds - the webhook's own timestamp, or when the call ended for a polled one.
 */
export async function processAircallInterested(
  call: AircallCall,
  occurredAt: number,
  source: InterestedSource,
): Promise<InterestedResult> {
  const fields = extractAircallFields(call, occurredAt);
  if (!fields.email && !fields.phone) {
    console.warn(
      `[interested] ${source} call ${call.id}: rejected - the call carried neither an email nor a phone number, so no person can be matched or created`,
    );
    return { status: "no_contact_details" };
  }

  let person = await findPersonByEmail(fields.email);
  if (!person) person = await findPersonByPhone(fields.phone);
  if (!person) person = await createPerson(personValues(fields));

  const personId = person.id.record_id;
  const personName = personLabel(person);
  const dealId = await ensureInterestedDeal(
    person,
    dealName(fields),
    defaultDealOwner(),
  );
  const history = buildCallHistorySummary(fields);
  const title = LEAD_SOURCE_LABELS.aircall;
  await createNote("people", personId, title, history, personName);
  await createNote("deals", dealId, title, history);
  await patchPerson(
    personId,
    blankPersonValues(person, { ...personValues(fields), lead_source: title }),
    personName,
  );
  await addPersonToList(personId, LISTS.DNC, personName);

  console.log(`[interested] ${source} call ${call.id}: completed - person ${personName}, deal ${dealId}`);
  return { status: "done", personId, dealId };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const webhook = parseAircallWebhook(await requestJson(request));
    if (webhook.token !== requiredEnv("AIRCALL_WEBHOOK_TOKEN")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const callTags = webhook.call.tags.map((tag) => tag.name);
    const matched = matchedInterestedTags(webhook.call, interestedTagSet());

    if (callTags.length === 0) {
      console.log(
        `[interested] webhook call ${webhook.call.id}: skipped - no tags found on the call`,
      );
      return json({ skipped: true, reason: "tag not found" });
    }
    if (matched.length === 0) {
      console.log(
        `[interested] webhook call ${webhook.call.id}: skipped - tags not interested: ${JSON.stringify(callTags)}`,
      );
      return json({ skipped: true, reason: "tag not tracked", tags: callTags });
    }
    console.log(
      `[interested] webhook call ${webhook.call.id}: matched tag(s) ${JSON.stringify(matched)}`,
    );

    const result = await processAircallInterested(webhook.call, webhook.timestamp, "webhook");
    if (result.status === "no_contact_details") {
      return json({ error: "No email or phone in payload" }, 422);
    }
    return json({ success: true, personId: result.personId, dealId: result.dealId });
  } catch (error) {
    return serverError("Aircall interested webhook error", error);
  }
}
