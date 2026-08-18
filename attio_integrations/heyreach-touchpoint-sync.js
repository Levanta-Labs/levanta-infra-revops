// api/cron/heyreach-touchpoint-sync.js
//
// Vercel Cron function — polls HeyReach for new messages across all
// conversations since the last run. For each message: skips it unless the
// matched person is on the Master TAM List, then creates a NEW note (not
// appended) on the Person and their associated Company — titled with the
// thread name + date, body is the message itself — and increments the
// `number_of_dms` counter on both.
//
// ── SETUP ────────────────────────────────────────────────────────────────
// vercel.json cron entry:
//   { "crons": [{ "path": "/api/cron/heyreach-touchpoint-sync", "schedule": "*/5 * * * *" }] }
// Env vars:
//   HEYREACH_API_KEY   HeyReach API key
//   ATTIO_API_KEY      Attio API token (Bearer)
//
// ── TODO (Damian) ──────────────────────────────────────────────────────
// 1. Checkpoint storage is IN-MEMORY ONLY — same pending decision as the
//    other pollers.
// 2. get_conversations has no since-filter (confirmed earlier) — this
//    pulls ALL conversations every run and filters by timestamp client-side.
// 3. Field paths are best-guess, confirm against a real response.
// 4. Company counter attribute assumed to be `number_of_dms` once added.
// ────────────────────────────────────────────────────────────────────────

import {
  findPersonByLinkedIn,
  findPersonByEmail,
  isPersonInList,
  createNote,
  incrementCounter,
  personDisplayName,
  personCompanyId,
  LISTS,
  PERSON_COUNTER_SLUGS,
  COMPANY_COUNTER_SLUGS,
} from "../../lib/attio.js";

const HEYREACH_BASE = "https://api.heyreach.io/api/public";
const HEYREACH_API_KEY = process.env.HEYREACH_API_KEY;
const FALLBACK_LOOKBACK_MINUTES = 10;

let _inMemoryCheckpoint = null;
async function getCheckpoint() {
  if (_inMemoryCheckpoint) return _inMemoryCheckpoint;
  return Date.now() - FALLBACK_LOOKBACK_MINUTES * 60 * 1000;
}
async function setCheckpoint(ts) {
  _inMemoryCheckpoint = ts;
}

function heyreachHeaders() {
  return { "X-API-KEY": HEYREACH_API_KEY, "Content-Type": "application/json" };
}

async function fetchAllConversations() {
  const conversations = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const res = await fetch(
      `${HEYREACH_BASE}/inbox/get_conversations?offset=${offset}&limit=${limit}`,
      { headers: heyreachHeaders() }
    );
    if (!res.ok) throw new Error(`HeyReach API error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const batch = json.conversations ?? json.data ?? [];
    conversations.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return conversations;
}

async function processMessage(conversation, message) {
  const profileUrl = conversation.leadProfileUrl ?? conversation.lead?.profileUrl ?? null;
  const email = conversation.leadEmail ?? conversation.lead?.email ?? null;

  let person = await findPersonByLinkedIn(profileUrl);
  if (!person) person = await findPersonByEmail(email);
  if (!person) {
    console.warn("No matching Attio person for HeyReach message", message.id, profileUrl || email);
    return "skipped";
  }

  const personId = person.id.record_id;
  const inTam = await isPersonInList(personId, LISTS.MASTER_TAM);
  if (!inTam) return "not_tam";

  const threadName =
    conversation.threadName ?? conversation.leadName ?? conversation.lead?.fullName ?? "HeyReach conversation";
  const messageDate = new Date(message.timestamp ?? message.sentAt).toISOString();
  const title = `${threadName} — ${messageDate}`;
  const body = message.text ?? message.body ?? "(no message content)";

  await createNote("people", personId, title, body);
  await incrementCounter("people", personId, PERSON_COUNTER_SLUGS.heyreach);

  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      title,
      `HeyReach message with ${personDisplayName(person) ?? threadName}:\n\n${body}`
    );
    await incrementCounter("companies", companyId, COMPANY_COUNTER_SLUGS.heyreach);
  }

  return "processed";
}

export default async function handler(req, res) {
  try {
    const sinceMs = await getCheckpoint();
    const conversations = await fetchAllConversations();

    const results = { processed: 0, skipped: 0, not_tam: 0 };
    for (const conversation of conversations) {
      for (const message of conversation.messages ?? []) {
        const ts = new Date(message.timestamp ?? message.sentAt).getTime();
        if (!ts || ts <= sinceMs) continue;
        try {
          const outcome = await processMessage(conversation, message);
          results[outcome] = (results[outcome] ?? 0) + 1;
        } catch (err) {
          console.error("Error processing HeyReach message", message.id, err);
          results.skipped++;
        }
      }
    }

    const newCheckpoint = Date.now();
    await setCheckpoint(newCheckpoint);

    return res.status(200).json({
      success: true,
      conversationsScanned: conversations.length,
      ...results,
      newCheckpoint,
    });
  } catch (err) {
    console.error("HeyReach touchpoint sync error:", err);
    return res.status(500).json({ error: err.message });
  }
}
