// api/cron/instantly-touchpoint-sync.js
//
// Vercel Cron function — polls Instantly for emails (sent + replies) since
// the last run. For each: skips it unless the matched person is on the
// Master TAM List, then creates a NEW note (not appended) on the Person
// and their associated Company — titled with the thread/subject + date,
// body is the email content — and increments the `number_of_emails`
// counter on both.
//
// ── SETUP ────────────────────────────────────────────────────────────────
// vercel.json cron entry:
//   { "crons": [{ "path": "/api/cron/instantly-touchpoint-sync", "schedule": "*/5 * * * *" }] }
// Env vars:
//   INSTANTLY_API_KEY   Instantly API key
//   ATTIO_API_KEY        Attio API token (Bearer)
//
// ── TODO (Damian) ──────────────────────────────────────────────────────
// 1. Checkpoint storage is IN-MEMORY ONLY — same pending decision as the
//    other two pollers (Vercel KV / Attio field / Redis, with Zack).
// 2. TRACKED_EVENT_TYPES below only counts sent + replied, skipping
//    opens/clicks — carried over from the original Zap design intent to
//    avoid noise from low-signal events. Say if you want opens/clicks
//    logged too now that cost no longer scales with volume.
// 3. Field paths (email.lead_email, email.subject, etc.) are best-guess —
//    confirm against a real /api/v2/emails response.
// 4. Company counter attribute assumed to be `number_of_emails` once added.
// ────────────────────────────────────────────────────────────────────────

import {
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

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const FALLBACK_LOOKBACK_MINUTES = 10;

// Only these event types count as a touchpoint worth logging.
const TRACKED_EVENT_TYPES = ["sent", "replied"];

let _inMemoryCheckpoint = null;
async function getCheckpoint() {
  if (_inMemoryCheckpoint) return _inMemoryCheckpoint;
  return Date.now() - FALLBACK_LOOKBACK_MINUTES * 60 * 1000;
}
async function setCheckpoint(ts) {
  _inMemoryCheckpoint = ts;
}

async function fetchEmailsSince(sinceMs) {
  const emails = [];
  let startingAfter = null;
  while (true) {
    const url = new URL(`${INSTANTLY_BASE}/emails`);
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${INSTANTLY_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Instantly API error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const batch = json.items ?? json.emails ?? [];
    emails.push(...batch);

    const last = batch[batch.length - 1];
    const lastTs = last ? new Date(last.timestamp).getTime() : null;
    if (!last || batch.length < 100 || (lastTs && lastTs <= sinceMs)) break;
    startingAfter = last.id;
  }
  return emails.filter((e) => {
    const ts = new Date(e.timestamp).getTime();
    return ts > sinceMs && TRACKED_EVENT_TYPES.includes(e.event_type ?? e.type);
  });
}

async function processEmail(email) {
  const leadEmail = email.lead_email ?? email.to ?? null;
  if (!leadEmail) {
    console.warn("Skipping Instantly email with no lead email", email.id);
    return "skipped";
  }

  const person = await findPersonByEmail(leadEmail);
  if (!person) {
    console.warn("No matching Attio person for Instantly email", email.id, leadEmail);
    return "skipped";
  }

  const personId = person.id.record_id;
  const inTam = await isPersonInList(personId, LISTS.MASTER_TAM);
  if (!inTam) return "not_tam";

  const dateStr = new Date(email.timestamp).toISOString();
  const subject = email.subject ?? "(no subject)";
  const title = `${subject} — ${dateStr}`;
  const body = email.body_text ?? email.content ?? "(no content)";

  await createNote("people", personId, title, body);
  await incrementCounter("people", personId, PERSON_COUNTER_SLUGS.instantly);

  const companyId = personCompanyId(person);
  if (companyId) {
    await createNote(
      "companies",
      companyId,
      title,
      `Instantly email with ${personDisplayName(person) ?? leadEmail}:\n\n${body}`
    );
    await incrementCounter("companies", companyId, COMPANY_COUNTER_SLUGS.instantly);
  }

  return "processed";
}

export default async function handler(req, res) {
  try {
    const sinceMs = await getCheckpoint();
    const emails = await fetchEmailsSince(sinceMs);

    const results = { processed: 0, skipped: 0, not_tam: 0 };
    for (const email of emails) {
      try {
        const outcome = await processEmail(email);
        results[outcome] = (results[outcome] ?? 0) + 1;
      } catch (err) {
        console.error("Error processing Instantly email", email.id, err);
        results.skipped++;
      }
    }

    const newCheckpoint = Date.now();
    await setCheckpoint(newCheckpoint);

    return res.status(200).json({ success: true, emailsFound: emails.length, ...results, newCheckpoint });
  } catch (err) {
    console.error("Instantly touchpoint sync error:", err);
    return res.status(500).json({ error: err.message });
  }
}
