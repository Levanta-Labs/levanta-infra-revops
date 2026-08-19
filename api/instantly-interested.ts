import {
  addPersonToList,
  createNote,
  createPerson,
  ensureInterestedDeal,
  findPersonByEmail,
  LEAD_SOURCE_LABELS,
  LISTS,
  patchPerson,
  type CreatePersonValues,
  type PersonNameInput,
} from "../lib/attio.ts";
import { requiredEnv } from "../lib/env.ts";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.ts";
import { fetchInstantlyEmails, type InstantlyEmail } from "../lib/instantly.ts";
import { isJsonObject, stringValue } from "../lib/json.ts";

export interface InstantlyInterestedFields {
  readonly eventType: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly campaignName: string | null;
}

export function parseInstantlyInterestedWebhook(value: unknown): InstantlyInterestedFields {
  if (!isJsonObject(value)) throw new Error("Instantly webhook payload must be an object");
  const eventType = stringValue(value.event_type);
  const email = stringValue(value.lead_email);
  if (!eventType || !email) throw new Error("Instantly webhook is missing event_type or lead_email");
  return {
    eventType,
    email,
    firstName: stringValue(value.firstName),
    lastName: stringValue(value.lastName),
    companyName: stringValue(value.companyName),
    campaignName: stringValue(value.campaign_name),
  };
}

export function formatInstantlyThread(
  emails: readonly InstantlyEmail[],
  campaignName: string | null,
): string {
  if (emails.length === 0) {
    return campaignName
      ? `No email history found. Campaign: ${campaignName}`
      : "No email history found.";
  }
  return [...emails]
    .sort((left, right) => Date.parse(left.timestampEmail) - Date.parse(right.timestampEmail))
    .map(
      (email) =>
        `**${email.timestampEmail}** (${email.emailType})\n${email.subject ?? ""}\n\n${email.bodyText ?? ""}`,
    )
    .join("\n\n---\n\n");
}

function personValues(fields: InstantlyInterestedFields): CreatePersonValues {
  const values: {
    email_addresses: readonly string[];
    name?: readonly PersonNameInput[];
  } = { email_addresses: [fields.email] };
  if (fields.firstName || fields.lastName) {
    const firstName = fields.firstName ?? "";
    const lastName = fields.lastName ?? "";
    values.name = [{ first_name: firstName, last_name: lastName, full_name: `${firstName} ${lastName}`.trim() }];
  }
  return values;
}

function dealName(fields: InstantlyInterestedFields): string {
  if (fields.companyName) return `${fields.companyName} - Interested`;
  return `${fields.firstName ?? ""} ${fields.lastName ?? ""}`.trim() || "New Interested Deal";
}

export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "INSTANTLY_WEBHOOK_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const fields = parseInstantlyInterestedWebhook(await requestJson(request));
    if (fields.eventType !== "lead_interested") {
      return json({ skipped: true, reason: "event not tracked" });
    }

    let person = await findPersonByEmail(fields.email);
    if (!person) person = await createPerson(personValues(fields));
    const personId = person.id.record_id;
    const dealId = await ensureInterestedDeal(
      person,
      dealName(fields),
      requiredEnv("ATTIO_DEFAULT_DEAL_OWNER"),
    );
    const emails = await fetchInstantlyEmails({ leadEmail: fields.email });
    const history = formatInstantlyThread(emails, fields.campaignName);
    const title = LEAD_SOURCE_LABELS.instantly;
    await createNote("people", personId, title, history);
    await createNote("deals", dealId, title, history);
    await patchPerson(personId, { lead_source: title });
    await addPersonToList(personId, LISTS.DNC);
    return json({ success: true, personId, dealId });
  } catch (error) {
    return serverError("Instantly interested webhook error", error);
  }
}
