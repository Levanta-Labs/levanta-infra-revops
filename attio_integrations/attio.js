// lib/attio.js
//
// Shared Attio helpers used by every workflow function (both the three
// event-driven "marked as interested" webhooks and the three periodic
// "log TAM touchpoint" cron pollers). Centralizing this avoids six copies
// of the same fetch/matching/note logic.
//
// ── TODO (Damian) ──────────────────────────────────────────────────────
// 1. COMPANY_COUNTER_SLUGS below assumes the new Company number attributes
//    you're adding will use the SAME api_slugs as the existing Person ones
//    (number_of_calls / number_of_emails / number_of_dms). Update this
//    object if you name them differently in Attio.
// 2. Attio has no atomic "increment" — incrementCounter() does a
//    read-then-write. Two touchpoints landing in the same poll run are
//    processed sequentially in-process, so this is fine for now, but if
//    this ever runs across concurrent invocations it could race. Not a
//    concern at current volume.
// ────────────────────────────────────────────────────────────────────────

const ATTIO_BASE = "https://api.attio.com/v2";
const ATTIO_API_KEY = process.env.ATTIO_API_KEY;

export const LISTS = {
  MASTER_TAM: "master_tam_list",
  DNC: "dnc",
};

// Person counter attributes (confirmed real slugs from the Attio schema).
export const PERSON_COUNTER_SLUGS = {
  aircall: "number_of_calls",
  instantly: "number_of_emails",
  heyreach: "number_of_dms",
};

// Company counter attributes — NOT YET CREATED in Attio as of this writing.
// Assumed to mirror the Person slugs once added; update if named differently.
export const COMPANY_COUNTER_SLUGS = {
  aircall: "number_of_calls",
  instantly: "number_of_emails",
  heyreach: "number_of_dms",
};

export const LEAD_SOURCE_LABELS = {
  aircall: "Aircall Cold Outreach",
  instantly: "Instantly Cold Outreach",
  heyreach: "HeyReach Cold Outreach",
};

function headers() {
  return {
    Authorization: `Bearer ${ATTIO_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function attioFetch(path, options = {}) {
  const res = await fetch(`${ATTIO_BASE}${path}`, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`Attio API error ${res.status}: ${text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ── Person matching ────────────────────────────────────────────────────
export async function findPersonByEmail(email) {
  if (!email) return null;
  const res = await attioFetch(`/objects/people/records/query`, {
    method: "POST",
    body: JSON.stringify({ filter: { email_addresses: { $eq: email } }, limit: 1 }),
  });
  return res?.data?.[0] ?? null;
}

export async function findPersonByPhone(phone) {
  if (!phone) return null;
  const res = await attioFetch(`/objects/people/records/query`, {
    method: "POST",
    body: JSON.stringify({ filter: { phone_numbers: { $eq: phone } }, limit: 1 }),
  });
  return res?.data?.[0] ?? null;
}

export async function findPersonByLinkedIn(profileUrl) {
  if (!profileUrl) return null;
  const res = await attioFetch(`/objects/people/records/query`, {
    method: "POST",
    body: JSON.stringify({ filter: { linkedin: { $eq: profileUrl } }, limit: 1 }),
  });
  return res?.data?.[0] ?? null;
}

export async function getPerson(personId) {
  const res = await attioFetch(`/objects/people/records/${personId}`);
  return res?.data;
}

export async function createPerson(values) {
  const res = await attioFetch(`/objects/people/records`, {
    method: "POST",
    body: JSON.stringify({ data: { values } }),
  });
  return res?.data;
}

export async function patchPerson(personId, values) {
  await attioFetch(`/objects/people/records/${personId}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { values } }),
  });
}

// ── List membership (Master TAM gating + DNC) ───────────────────────────
// Uses the confirmed working pattern: GET the record's list entries, then
// check the response for the target list rather than relying on Zapier's
// unreliable "find list entries by parent" search.
export async function isPersonInList(personId, listSlug) {
  const res = await attioFetch(`/objects/people/records/${personId}/entries`);
  const entries = res?.data ?? [];
  return entries.some((e) => e.list_id?.slug === listSlug || e.list_api_slug === listSlug);
}

export async function addPersonToList(personId, listSlug) {
  await attioFetch(`/lists/${listSlug}/entries`, {
    method: "POST",
    body: JSON.stringify({
      data: { parent_record_id: personId, parent_object: "people" },
    }),
  });
}

// ── Notes ────────────────────────────────────────────────────────────────
// Every call creates a brand-new note — no appending, per the current spec.
export async function createNote(parentObject, parentRecordId, title, content) {
  await attioFetch(`/notes`, {
    method: "POST",
    body: JSON.stringify({
      data: { parent_object: parentObject, parent_record_id: parentRecordId, title, content },
    }),
  });
}

// ── Counters (read-then-write, see TODO 2 above) ────────────────────────
export async function incrementCounter(objectType, recordId, attributeSlug) {
  const res = await attioFetch(`/objects/${objectType}/records/${recordId}`);
  const current = res?.data?.values?.[attributeSlug]?.[0]?.value ?? 0;
  await attioFetch(`/objects/${objectType}/records/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { values: { [attributeSlug]: current + 1 } } }),
  });
}

// ── Deals ────────────────────────────────────────────────────────────────
// Deal attributes are only ever set AT CREATION. If a deal already exists
// for the person, this returns its ID untouched — per spec, existing deals
// never get their attributes updated by these workflows.
export async function ensureInterestedDeal(person, dealNameHint, ownerEmail) {
  const associatedDeals = person.values?.associated_deals ?? [];
  if (associatedDeals.length > 0) {
    return associatedDeals[0].target_record_id;
  }

  const companyRef = person.values?.company?.[0];
  const res = await attioFetch(`/objects/deals/records`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        values: {
          name: dealNameHint || "New Interested Deal",
          stage: "Interested",
          owner: ownerEmail,
          associated_people: [
            { target_object: "people", target_record_id: person.id.record_id },
          ],
          ...(companyRef
            ? { associated_company: { target_object: "companies", target_record_id: companyRef.target_record_id } }
            : {}),
        },
      },
    }),
  });
  return res?.data?.id?.record_id;
}

export function personDisplayName(person) {
  return person?.values?.name?.[0]?.full_name ?? null;
}

export function personCompanyId(person) {
  return person?.values?.company?.[0]?.target_record_id ?? null;
}
