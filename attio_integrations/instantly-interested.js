// api/instantly-interested.js
//
// Event-driven webhook — fires on Instantly's native `lead_interested`
// event (Instantly supports webhooks directly, no Zapier relay needed).
// Matches/creates the Attio Person, ensures an Interested-stage Deal
// exists (never touching an existing deal's attributes), logs a one-time
// "Instantly Cold Outreach" note containing the full email thread on both
// the Person and the Deal, sets Lead Source, and adds the person to DNC.
//
// Always runs regardless of Master TAM List membership — that gating only
// applies to the touchpoint poller, not this webhook.
//
// ── SETUP ────────────────────────────────────────────────────────────────
// Env vars:
//   ATTIO_API_KEY             Attio API token (Bearer)
//   INSTANTLY_API_KEY         Instantly API key, used to pull the full
//                             thread at the moment of marking interested
//   ATTIO_DEFAULT_DEAL_OWNER  Required field on newly created deals —
//                             still a placeholder, tell me who this is.
//
// ── TODO (Damian) ──────────────────────────────────────────────────────
// 1. fetchEmailThread() below is a best-guess against Instantly's API
//    shape (GET /api/v2/emails?lead_email=...) — confirm endpoint/fields
//    once tested against a real account.
// 2. Confirm the exact `lead_interested` webhook payload field names
//    (payload.lead.email below is a guess).
// ────────────────────────────────────────────────────────────────────────

import {
  findPersonByEmail,
  createPerson,
  patchPerson,
  addPersonToList,
  createNote,
  ensureInterestedDeal,
  LISTS,
  LEAD_SOURCE_LABELS,
} from "../lib/attio.js";

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const DEFAULT_DEAL_OWNER = process.env.ATTIO_DEFAULT_DEAL_OWNER;

function extractInstantlyFields(payload) {
  const lead = payload?.lead ?? payload;
  return {
    email: lead?.email ?? null,
    firstName: lead?.first_name ?? null,
    lastName: lead?.last_name ?? null,
    companyName: lead?.company_name ?? null,
    campaignName: payload?.campaign_name ?? null,
  };
}

// Pulls the full email thread with this lead so the note reflects everything
// sent/received so far, not just the message that triggered "interested".
async function fetchEmailThread(email) {
  const res = await fetch(
    `${INSTANTLY_BASE}/emails?lead_email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}` } }
  );
  if (!res.ok) {
    console.error(`Instantly API error ${res.status}: ${await res.text()}`);
    return [];
  }
  const json = await res.json();
  return json?.items ?? json?.emails ?? [];
}

function formatThreadAsNote(emails, campaignName) {
  if (!emails.length) {
    return campaignName
      ? `No email history found. Campaign: ${campaignName}`
      : "No email history found.";
  }
  const lines = emails
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map((e) => `**${e.timestamp}** (${e.direction ?? "sent"})\n${e.subject ?? ""}\n\n${e.body_text ?? e.content ?? ""}`);
  return lines.join("\n\n---\n\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const fields = extractInstantlyFields(req.body);

    if (!fields.email) {
      console.error("Instantly interested webhook: no email in payload", req.body);
      return res.status(422).json({ error: "No email in payload" });
    }

    let person = await findPersonByEmail(fields.email);
    if (!person) {
      const values = { email_addresses: [fields.email] };
      if (fields.firstName || fields.lastName) {
        values.name = [{
          first_name: fields.firstName ?? "",
          last_name: fields.lastName ?? "",
          full_name: `${fields.firstName ?? ""} ${fields.lastName ?? ""}`.trim(),
        }];
      }
      person = await createPerson(values);
    }

    const personId = person.id.record_id;
    const dealName = fields.companyName
      ? `${fields.companyName} - Interested`
      : `${fields.firstName ?? ""} ${fields.lastName ?? ""}`.trim() || "New Interested Deal";

    const dealId = await ensureInterestedDeal(person, dealName, DEFAULT_DEAL_OWNER);

    const emails = await fetchEmailThread(fields.email);
    const historyContent = formatThreadAsNote(emails, fields.campaignName);
    const noteTitle = LEAD_SOURCE_LABELS.instantly;
    await createNote("people", personId, noteTitle, historyContent);
    if (dealId) await createNote("deals", dealId, noteTitle, historyContent);

    await patchPerson(personId, { lead_source: LEAD_SOURCE_LABELS.instantly });
    await addPersonToList(personId, LISTS.DNC);

    return res.status(200).json({ success: true, personId, dealId });
  } catch (err) {
    console.error("Instantly interested webhook error:", err);
    return res.status(500).json({ error: err.message });
  }
}
