// api/aircall-interested.js
//
// Event-driven webhook — fires when an Aircall call outcome matches one of
// the "interested" values. Matches/creates the Attio Person, ensures an
// Interested-stage Deal exists (never touching an existing deal's
// attributes), logs a one-time "Aircall Cold Outreach" note with whatever
// call-history info Aircall has on both the Person and the Deal, sets
// Lead Source, and adds the person to the DNC list.
//
// Per the confirmed architecture: this flow always runs regardless of
// Master TAM List membership — that gating only applies to the touchpoint
// pollers, not this webhook.
//
// ── SETUP ────────────────────────────────────────────────────────────────
// Env vars:
//   ATTIO_API_KEY             Attio API token (Bearer)
//   ATTIO_DEFAULT_DEAL_OWNER  Workspace member email — REQUIRED field on
//                             newly created deals. Still a placeholder —
//                             tell me who this should be and I'll wire it in.
//   AIRCALL_WEBHOOK_SECRET    (optional) shared secret for basic verification
//
// ── TODO (Damian) ──────────────────────────────────────────────────────
// 1. TRIGGER_OUTCOMES still has 2 of 3 real values as placeholders.
// 2. extractAircallFields() payload paths are best-guess — confirm once
//    wired to a real Aircall payload.
// 3. buildCallHistorySummary() below just summarizes what's on the
//    inbound payload (direction, duration, tags) since Aircall doesn't
//    give a "thread" the way Instantly/HeyReach do. Say if you want this
//    to pull full call history from Aircall's API instead of just the
//    triggering call.
// ────────────────────────────────────────────────────────────────────────

import {
  findPersonByEmail,
  findPersonByPhone,
  createPerson,
  patchPerson,
  addPersonToList,
  createNote,
  ensureInterestedDeal,
  LISTS,
  LEAD_SOURCE_LABELS,
} from "../lib/attio.js";

const DEFAULT_DEAL_OWNER = process.env.ATTIO_DEFAULT_DEAL_OWNER;
const TRIGGER_OUTCOMES = ["booked", "PLACEHOLDER_2", "PLACEHOLDER_3"];

function extractAircallFields(payload) {
  const call = payload?.data?.call ?? payload?.call ?? payload;
  const contact = call?.contact ?? {};

  const outcome =
    call?.outcome ??
    call?.tags?.find((t) => TRIGGER_OUTCOMES.includes(t?.name))?.name ??
    null;

  return {
    outcome,
    email: contact?.email ?? call?.email ?? null,
    phone: contact?.raw_digits ?? contact?.phone_numbers?.[0]?.raw_digits ?? null,
    firstName: contact?.first_name ?? null,
    lastName: contact?.last_name ?? null,
    companyName: contact?.company_name ?? null,
    direction: call?.direction ?? null,
    duration: call?.duration ?? null,
    tags: (call?.tags ?? []).map((t) => t.name),
  };
}

function buildCallHistorySummary(fields) {
  const durationMin = fields.duration ? Math.round(fields.duration / 60) : 0;
  return [
    `**Aircall interaction — ${new Date().toISOString()}**`,
    `- Direction: ${fields.direction ?? "unknown"}`,
    `- Duration: ${durationMin} min`,
    fields.tags?.length ? `- Tags: ${fields.tags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (
    process.env.AIRCALL_WEBHOOK_SECRET &&
    req.headers["x-webhook-secret"] !== process.env.AIRCALL_WEBHOOK_SECRET
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const fields = extractAircallFields(req.body);

    if (!TRIGGER_OUTCOMES.includes(fields.outcome)) {
      return res.status(200).json({ skipped: true, reason: "outcome not tracked" });
    }
    if (!fields.email && !fields.phone) {
      console.error("Aircall interested webhook: no email/phone to match/create on", fields);
      return res.status(422).json({ error: "No email or phone in payload" });
    }

    let person = await findPersonByEmail(fields.email);
    if (!person) person = await findPersonByPhone(fields.phone);
    if (!person) {
      const values = {};
      if (fields.email) values.email_addresses = [fields.email];
      if (fields.phone) values.phone_numbers = [fields.phone];
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

    const historyContent = buildCallHistorySummary(fields);
    const noteTitle = LEAD_SOURCE_LABELS.aircall;
    await createNote("people", personId, noteTitle, historyContent);
    if (dealId) await createNote("deals", dealId, noteTitle, historyContent);

    await patchPerson(personId, { lead_source: LEAD_SOURCE_LABELS.aircall });
    await addPersonToList(personId, LISTS.DNC);

    return res.status(200).json({ success: true, personId, dealId });
  } catch (err) {
    console.error("Aircall interested webhook error:", err);
    return res.status(500).json({ error: err.message });
  }
}
