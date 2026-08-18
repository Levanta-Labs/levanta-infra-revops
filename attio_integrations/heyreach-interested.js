// api/heyreach-interested.js
//
// Event-driven webhook — fires when a HeyReach lead's "Prospect Tag" is
// updated to an interested-type tag. Since HeyReach's native webhook
// config can't attach the auth header Attio needs, this endpoint is meant
// to be called via an intermediary (Zapier's native "Prospect Tag Updated"
// trigger → Webhooks by Zapier → this URL), not directly from HeyReach.
//
// Matches/creates the Attio Person (LinkedIn profile first, email
// fallback), ensures an Interested-stage Deal exists (never touching an
// existing deal's attributes), logs a one-time "HeyReach Cold Outreach"
// note containing the full conversation thread on both the Person and the
// Deal, sets Lead Source, and adds the person to DNC. Also stops the lead
// in any active HeyReach campaigns via HeyReach's API, per the original
// suppression design.
//
// Always runs regardless of Master TAM List membership — that gating only
// applies to the touchpoint poller, not this webhook.
//
// ── SETUP ────────────────────────────────────────────────────────────────
// Env vars:
//   ATTIO_API_KEY             Attio API token (Bearer)
//   HEYREACH_API_KEY          HeyReach API key
//   ATTIO_DEFAULT_DEAL_OWNER  Required field on newly created deals —
//                             still a placeholder, tell me who this is.
//
// ── TODO (Damian) ──────────────────────────────────────────────────────
// 1. Confirm the intermediary payload shape once the Zapier relay is set
//    up — profileUrl/email field paths below are a guess.
// 2. fetchConversation() is best-guess against HeyReach's get_conversations
//    shape — confirm once tested.
// 3. stop_lead_in_campaign has no resume — if this ever needs to be
//    reversed it's a manual re-enrollment, same limitation flagged earlier.
// ────────────────────────────────────────────────────────────────────────

import {
  findPersonByLinkedIn,
  findPersonByEmail,
  createPerson,
  patchPerson,
  addPersonToList,
  createNote,
  ensureInterestedDeal,
  LISTS,
  LEAD_SOURCE_LABELS,
} from "../lib/attio.js";

const HEYREACH_BASE = "https://api.heyreach.io/api/public";
const HEYREACH_API_KEY = process.env.HEYREACH_API_KEY;
const DEFAULT_DEAL_OWNER = process.env.ATTIO_DEFAULT_DEAL_OWNER;

function heyreachHeaders() {
  return { "X-API-KEY": HEYREACH_API_KEY, "Content-Type": "application/json" };
}

function extractHeyReachFields(payload) {
  const lead = payload?.lead ?? payload;
  return {
    profileUrl: lead?.profileUrl ?? lead?.linkedInUrl ?? null,
    email: lead?.email ?? null,
    firstName: lead?.firstName ?? null,
    lastName: lead?.lastName ?? null,
    companyName: lead?.companyName ?? null,
    leadId: lead?.id ?? null,
  };
}

async function fetchConversation(profileUrl) {
  const res = await fetch(
    `${HEYREACH_BASE}/inbox/get_conversations?leadProfileUrl=${encodeURIComponent(profileUrl)}`,
    { headers: heyreachHeaders() }
  );
  if (!res.ok) {
    console.error(`HeyReach API error ${res.status}: ${await res.text()}`);
    return [];
  }
  const json = await res.json();
  const conversation = (json.conversations ?? json.data ?? [])[0];
  return conversation?.messages ?? [];
}

function formatThreadAsNote(messages) {
  if (!messages.length) return "No message history found.";
  return messages
    .sort((a, b) => new Date(a.timestamp ?? a.sentAt) - new Date(b.timestamp ?? b.sentAt))
    .map((m) => `**${m.timestamp ?? m.sentAt}**\n${m.text ?? m.body ?? ""}`)
    .join("\n\n---\n\n");
}

async function stopLeadInCampaigns(leadId) {
  if (!leadId) return;
  try {
    const campaignsRes = await fetch(
      `${HEYREACH_BASE}/campaigns/get_for_lead?leadId=${leadId}`,
      { headers: heyreachHeaders() }
    );
    if (!campaignsRes.ok) return;
    const { campaigns = [] } = await campaignsRes.json();
    for (const campaign of campaigns) {
      await fetch(`${HEYREACH_BASE}/campaigns/stop_lead`, {
        method: "POST",
        headers: heyreachHeaders(),
        body: JSON.stringify({ leadId, campaignId: campaign.id }),
      });
    }
  } catch (err) {
    console.error("Failed to stop HeyReach campaigns for lead", leadId, err);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const fields = extractHeyReachFields(req.body);

    if (!fields.profileUrl && !fields.email) {
      console.error("HeyReach interested webhook: no profileUrl/email in payload", req.body);
      return res.status(422).json({ error: "No profileUrl or email in payload" });
    }

    let person = await findPersonByLinkedIn(fields.profileUrl);
    if (!person) person = await findPersonByEmail(fields.email);
    if (!person) {
      const values = {};
      if (fields.profileUrl) values.linkedin = fields.profileUrl;
      if (fields.email) values.email_addresses = [fields.email];
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

    const messages = await fetchConversation(fields.profileUrl);
    const historyContent = formatThreadAsNote(messages);
    const noteTitle = LEAD_SOURCE_LABELS.heyreach;
    await createNote("people", personId, noteTitle, historyContent);
    if (dealId) await createNote("deals", dealId, noteTitle, historyContent);

    await patchPerson(personId, { lead_source: LEAD_SOURCE_LABELS.heyreach });
    await addPersonToList(personId, LISTS.DNC);
    await stopLeadInCampaigns(fields.leadId);

    return res.status(200).json({ success: true, personId, dealId });
  } catch (err) {
    console.error("HeyReach interested webhook error:", err);
    return res.status(500).json({ error: err.message });
  }
}
