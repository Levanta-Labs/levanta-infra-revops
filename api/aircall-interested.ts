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
  type CreatePersonValues,
  type PersonNameInput,
} from "../lib/attio.js";
import { parseAircallWebhook, type AircallCall } from "../lib/aircall.js";
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
    phone: call.rawDigits,
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

export async function POST(request: Request): Promise<Response> {
  try {
    const webhook = parseAircallWebhook(await requestJson(request));
    if (webhook.token !== requiredEnv("AIRCALL_WEBHOOK_TOKEN")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const interestedTags = requiredCsvEnv("AIRCALL_INTERESTED_TAGS").map((tag) => tag.toLowerCase());
    const callTags = webhook.call.tags.map((tag) => tag.name);
    const matched = callTags.filter((tag) => interestedTags.includes(tag.toLowerCase()));

    if (callTags.length === 0) {
      console.log(
        `[route] aircall-interested: skipped call ${webhook.call.id} - no tags found on the call (interested tags: ${JSON.stringify(interestedTags)})`,
      );
      return json({ skipped: true, reason: "tag not found" });
    }
    if (matched.length === 0) {
      console.log(
        `[route] aircall-interested: skipped call ${webhook.call.id} - tags not interested: ${JSON.stringify(callTags)} (interested tags: ${JSON.stringify(interestedTags)})`,
      );
      return json({ skipped: true, reason: "tag not tracked", tags: callTags });
    }
    console.log(
      `[route] aircall-interested: call ${webhook.call.id} matched interested tag(s) ${JSON.stringify(matched)}`,
    );

    const fields = extractAircallFields(webhook.call, webhook.timestamp);
    if (!fields.email && !fields.phone) {
      console.warn(
        `[route] aircall-interested: rejected call ${webhook.call.id} - payload carried neither an email nor a phone number, so no person can be matched or created`,
      );
      return json({ error: "No email or phone in payload" }, 422);
    }

    let person = await findPersonByEmail(fields.email);
    if (!person) person = await findPersonByPhone(fields.phone);
    if (!person) person = await createPerson(personValues(fields));

    const personId = person.id.record_id;
    const dealId = await ensureInterestedDeal(
      person,
      dealName(fields),
      defaultDealOwner(),
    );
    const history = buildCallHistorySummary(fields);
    const title = LEAD_SOURCE_LABELS.aircall;
    await createNote("people", personId, title, history);
    await createNote("deals", dealId, title, history);
    await patchPerson(
      personId,
      blankPersonValues(person, { ...personValues(fields), lead_source: title }),
    );
    await addPersonToList(personId, LISTS.DNC);

    console.log(`[route] aircall-interested: completed - person ${personId}, deal ${dealId}`);
    return json({ success: true, personId, dealId });
  } catch (error) {
    return serverError("Aircall interested webhook error", error);
  }
}
