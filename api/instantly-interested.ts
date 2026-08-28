import {
  addPersonToList,
  blankPersonValues,
  createNote,
  createPerson,
  defaultDealOwner,
  ensureInterestedDeal,
  findPersonByEmail,
  LEAD_SOURCE_LABELS,
  LISTS,
  patchPerson,
  personLabel,
  type CreatePersonValues,
  type PersonNameInput,
} from "../lib/attio.js";
import { hasWebhookSecret, json, requestJson, serverError } from "../lib/http.js";
import { fetchInstantlyEmails, type InstantlyEmail } from "../lib/instantly.js";
import { isJsonObject, stringValue } from "../lib/json.js";

export interface InstantlyInterestedFields {
  readonly eventType: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly campaignName: string | null;
}

/** Instantly sends a flat v2 body. event_type and lead_email are required; the rest is best-effort enrichment. */
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

/** Renders the thread oldest-first so the note reads top to bottom. Sorted on timestampEmail, not creation order. */
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
  //email_addresses is always present; parse guarantees it. name is omitted entirely when both parts are absent,
  //because blankPersonValues keys off presence.
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

//---------------------------------------------------------------------------------------------------------
//Webhook entry point. Instantly posts here when a lead is marked interested.
//
//FLOW:
// 1. hasWebhookSecret (lib/http.ts) - compare the x-webhook-secret header against INSTANTLY_WEBHOOK_SECRET.
// 2. parseInstantlyInterestedWebhook - require event_type and lead_email.
// 3. Ignore anything that is not lead_interested; Instantly sends opens and replies to the same URL.
// 4. Resolve the person by email (lib/attio.ts), creating one when there is no match.
// 5. ensureInterestedDeal - reuses any deal already linked to the person, creates one only when none exists.
// 6. fetchInstantlyEmails (lib/instantly.ts) for the full thread, rendered by formatInstantlyThread.
// 7. Note on the person and on the deal, patchPerson with blankPersonValues, add to the DNC list.
//
//[SECURITY] Step 1 precedes the body read, so an unauthenticated caller never reaches the parser.
//[STABILITY] Steps 5-7 are separate Attio calls with no transaction. A throw partway leaves earlier writes
//committed and returns 500; Instantly's retry would then repeat them, adding duplicate notes.
//---------------------------------------------------------------------------------------------------------
export async function POST(request: Request): Promise<Response> {
  if (!hasWebhookSecret(request, "INSTANTLY_WEBHOOK_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const fields = parseInstantlyInterestedWebhook(await requestJson(request));
    //[DEBUG] Named rather than silent, so an untracked event type is visible as a decision in the log.
    if (fields.eventType !== "lead_interested") {
      console.log(
        `[route] instantly-interested: skipped - event ${JSON.stringify(fields.eventType)} is not "lead_interested"`,
      );
      return json({ skipped: true, reason: "event not tracked" });
    }
    console.log(`[route] instantly-interested: handling lead_interested for ${fields.email}`);

    let person = await findPersonByEmail(fields.email);
    if (!person) person = await createPerson(personValues(fields));
    const personId = person.id.record_id;
    const personName = personLabel(person);
    const dealId = await ensureInterestedDeal(
      person,
      dealName(fields),
      defaultDealOwner(),
    );
    //Unbounded by time - the whole thread for this lead, paginated. Bounded in practice by one lead's volume.
    const emails = await fetchInstantlyEmails({ leadEmail: fields.email });
    const history = formatInstantlyThread(emails, fields.campaignName);
    const title = LEAD_SOURCE_LABELS.instantly;
    await createNote("people", personId, title, history, personName);
    await createNote("deals", dealId, title, history);
    //blankPersonValues strips any attribute Attio already holds, so this can only fill gaps.
    await patchPerson(
      personId,
      blankPersonValues(person, { ...personValues(fields), lead_source: title }),
      personName,
    );
    await addPersonToList(personId, LISTS.DNC, personName);
    console.log(
      `[route] instantly-interested: completed - person ${personName}, deal ${dealId}, ${emails.length} email(s) summarised`,
    );
    return json({ success: true, personId, dealId });
  } catch (error) {
    return serverError("Instantly interested webhook error", error);
  }
}
