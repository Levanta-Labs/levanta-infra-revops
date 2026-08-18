// api/cron/aircall-touchpoint-sync.js
//
// Vercel Cron function — polls Aircall for calls completed since the last
// run. For each call: skips it unless the matched person is on the Master
// TAM List, then creates a NEW note (not appended) on the Person and their
// associated Company, and increments the `number_of_calls` counter on
// both. This is the high-volume, latency-tolerant counterpart to
// api/aircall-interested.js.
//
// ── SETUP ────────────────────────────────────────────────────────────────
// vercel.json cron entry:
//   { "crons": [{ "path": "/api/cron/aircall-touchpoint-sync", "schedule": "*/5 * * * *" }] }
// Env vars:
//   AIRCALL_API_ID / AIRCALL_API_TOKEN   Aircall Basic Auth credentials
//   ATTIO_API_KEY                        Attio API token (Bearer)
//
// ── TODO (Damian) ──────────────────────────────────────────────────────
// 1. Checkpoint storage is IN-MEMORY ONLY (see getCheckpoint/setCheckpoint)
//    — same open item as before, pending your KV/Attio/Redis decision
//    with Zack. Swap in the real store before relying on this.
// 2. Unmatched calls (no Attio person found) are skipped, not created —
//    touchpoint sync assumes the contact already exists.
// 3. Aircall payload field paths are best-guess, confirm against a real
//    response.
// 4. Company counter attribute is assumed to be named `number_of_calls`
//    once you add it — update COMPANY_COUNTER_SLUGS in lib/attio.js if not.
// ────────────────────────────────────────────────────────────────────────

import {
  findPersonByPhone,
  isPersonInList,
  createNote,
  incrementCounter,
  personDisplayName,
  personCompanyId,
  LISTS,
  PERSON_COUNTER_SLUGS,
  COMPANY_COUNTER_SLUGS,
} from "../../lib/attio.js";

const AIRCALL_BASE = "https://api.aircall.io/v1";
const AIRCALL_API_ID = process.env.AIRCALL_API_ID;
const AIRCALL_API_TOKEN = process.env.AIRCALL_API_TOKEN;

const TOUCHPOINT_NOTE_TITLE = "Aircall Touchpoint";
const FALLBACK_LOOKBACK_MINUTES = 10;

let _inMemoryCheckpoint = null;
async function getCheckpoint() {
  if (_inMemoryCheckpoint) return _inMemoryCheckpoint;
  return Math.floor(Date.now() / 1000) - FALLBACK_LOOKBACK_MINUTES * 60;
}
async function setCheckpoint(ts) {
  _inMemoryCheckpoint = ts;
}

function aircallAuthHeader() {
  const token = Buffer.from(`${AIRCALL_API_ID}:${AIRCALL_API_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

async function fetchCallsSince(sinceUnixTs) {
  const calls = [];
  let url = `${AIRCALL_BASE}/calls?from=${sinceUnixTs}&order=asc&per_page=50`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: aircallAuthHeader() } });
    if (!res.ok) throw new Error(`Aircall API error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    calls.push(...(json.calls ?? []));
    url = json.meta?.next_page_link ?? null;
  }
  return calls.filter((c) => c.status === "done");
}

async function processCall(call) {
  const phone = call?.contact?.phone_numbers?.[0]?.raw_digits ?? call?.raw_digits ?? null;
  if (!phone) {
    console.warn("Skipping call with no contact phone number", call.id);
    return "skipped";
  }

  const person = await findPersonByPhone(phone);
  if (!person) {
    console.warn("No matching Attio person for call", call.id, phone);
    return "skipped";
  }

  const personId = person.id.record_id;
  const inTam = await isPersonInList(personId, LISTS.MASTER_TAM);
  if (!inTam) {
    return "not_tam";
  }

  const durationMin = call.duration ? Math.round(call.duration / 60) : 0;
  const noteContent = `**${call.ended_at ?? call.started_at}**\nDirection: ${call.direction ?? "unknown"}\nDuration: ${durationMin} min`;
  const noteTitle = `${TOUCHPOINT_NOTE_TITLE} — ${call.ended_at ?? call.started_at}`;

  await createNote("people", personId, noteTitle, noteContent);
  await incrementCounter("people", personId, PERSON_COUNTER_SLUGS.aircall);

  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      noteTitle,
      `Aircall touchpoint with ${personDisplayName(person) ?? phone}:\n\n${noteContent}`
    );
    await incrementCounter("companies", companyId, COMPANY_COUNTER_SLUGS.aircall);
  }

  return "processed";
}

export default async function handler(req, res) {
  try {
    const since = await getCheckpoint();
    const calls = await fetchCallsSince(since);

    const results = { processed: 0, skipped: 0, not_tam: 0 };
    for (const call of calls) {
      try {
        const outcome = await processCall(call);
        results[outcome] = (results[outcome] ?? 0) + 1;
      } catch (err) {
        console.error("Error processing call", call.id, err);
        results.skipped++;
      }
    }

    const newCheckpoint = Math.floor(Date.now() / 1000);
    await setCheckpoint(newCheckpoint);

    return res.status(200).json({ success: true, callsFound: calls.length, ...results, newCheckpoint });
  } catch (err) {
    console.error("Aircall touchpoint sync error:", err);
    return res.status(500).json({ error: err.message });
  }
}
