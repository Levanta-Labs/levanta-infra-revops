import { expect, test } from "bun:test";
import { companyCounterSlug, LISTS, personCounterSlug } from "../../lib/attio.js";
import type { Provider } from "../../lib/providers.js";
import {
  AIRCALL_BASE,
  aircallAuthHeader,
  ATTIO_BASE,
  attioHeaders,
  HEYREACH_BASE,
  heyreachHeaders,
  INSTANTLY_BASE,
  instantlyAuthHeader,
  supabaseBaseUrl,
  supabaseHeaders,
} from "../../lib/endpoints.js";
import { optionalEnv } from "../../lib/env.js";
import {
  companyValuesFor,
  dealValuesFor,
  interestedLead,
  personValuesFor,
  toArrBucket,
  toEmployeeRange,
} from "../../lib/interested.js";
import { arrayValue, isJsonObject, responseJson, stringValue } from "../../lib/json.js";

const liveTest = process.env.RUN_LIVE_TESTS === "1" ? test : test.skip;

const PROVIDERS: readonly Provider[] = ["aircall", "instantly", "heyreach"];

async function expectOk(label: string, response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(`${label} read-only smoke test failed with HTTP ${response.status}`);
  }
  expect(response.ok).toBe(true);
}

/** Collects one string field from every element of an Attio `data` array. */
async function valuesFrom(path: string, response: Response, field: string): Promise<ReadonlySet<string>> {
  await expectOk(`Attio ${path}`, response);
  const body = await responseJson(response);
  if (!isJsonObject(body)) throw new Error(`Attio ${path} returned no object`);
  const values = new Set<string>();
  for (const entry of arrayValue(body, "data")) {
    if (!isJsonObject(entry)) continue;
    const value = stringValue(entry[field]);
    if (value) values.add(value);
  }
  if (values.size === 0) throw new Error(`Attio ${path} returned no ${field} values`);
  return values;
}

async function attioValues(path: string, field: string): Promise<ReadonlySet<string>> {
  return valuesFrom(path, await fetch(`${ATTIO_BASE}${path}`, { headers: attioHeaders() }), field);
}

//=============================================================================================================
//Credentials. Each provider is asked for the smallest page it will serve, which proves the key is accepted.
//=============================================================================================================

liveTest("reads the Supabase cursor table", async () => {
  const url = new URL("/rest/v1/Attio_Integrations_Touchpoint_Cursors", supabaseBaseUrl());
  url.searchParams.set("select", "sync_key,cursor_timestamp");
  url.searchParams.set("limit", "1");
  await expectOk("Supabase", await fetch(url, { headers: supabaseHeaders() }));
});

liveTest("identifies the Attio token", async () => {
  await expectOk("Attio", await fetch(`${ATTIO_BASE}/self`, { headers: attioHeaders() }));
});

liveTest("reads one Aircall calls page", async () => {
  await expectOk(
    "Aircall",
    await fetch(`${AIRCALL_BASE}/calls?per_page=1&order=desc`, {
      headers: { Authorization: aircallAuthHeader() },
    }),
  );
});

liveTest("reads one Instantly email preview", async () => {
  await expectOk(
    "Instantly",
    await fetch(`${INSTANTLY_BASE}/emails?limit=1&preview_only=true`, {
      headers: { Authorization: instantlyAuthHeader() },
    }),
  );
});

liveTest("reads one HeyReach conversation page", async () => {
  await expectOk(
    "HeyReach",
    await fetch(`${HEYREACH_BASE}/inbox/GetConversationsV3`, {
      method: "POST",
      headers: heyreachHeaders(),
      body: JSON.stringify({ limit: 1, cursor: null, filters: {} }),
    }),
  );
});

//=============================================================================================================
//Schema. Every configured slug is checked against the live Attio schema, so a wrong counter slug or a renamed
//list is caught here instead of on the first touchpoint that happens to reach it in production.
//=============================================================================================================

liveTest("every configured Person counter slug exists on the people object", async () => {
  const slugs = await attioValues("/objects/people/attributes", "api_slug");
  for (const provider of PROVIDERS) {
    const configured = personCounterSlug(provider);
    if (!slugs.has(configured)) {
      throw new Error(
        `ATTIO_PERSON_${provider.toUpperCase()}_COUNTER_SLUG is "${configured}", which is not an attribute on the Attio people object`,
      );
    }
    expect(slugs.has(configured)).toBe(true);
  }
});

liveTest("every configured Company counter slug exists on the companies object", async () => {
  const slugs = await attioValues("/objects/companies/attributes", "api_slug");
  for (const provider of PROVIDERS) {
    const configured = companyCounterSlug(provider);
    if (!slugs.has(configured)) {
      throw new Error(
        `ATTIO_COMPANY_${provider.toUpperCase()}_COUNTER_SLUG is "${configured}", which is not an attribute on the Attio companies object`,
      );
    }
    expect(slugs.has(configured)).toBe(true);
  }
});

liveTest("the Master TAM and DNC lists exist", async () => {
  const slugs = await attioValues("/lists", "api_slug");
  for (const listSlug of [LISTS.MASTER_TAM, LISTS.DNC]) {
    if (!slugs.has(listSlug)) {
      throw new Error(`Attio has no list with api_slug "${listSlug}"`);
    }
    expect(slugs.has(listSlug)).toBe(true);
  }
});

liveTest("the configured deal owner is a workspace member", async () => {
  const owner = optionalEnv("ATTIO_DEFAULT_DEAL_OWNER");
  if (!owner) throw new Error("ATTIO_DEFAULT_DEAL_OWNER is not configured");

  const response = await fetch(`${ATTIO_BASE}/workspace_members`, { headers: attioHeaders() });
  if (response.status === 403) {
    //Distinguish "cannot check" from "checked and wrong". A 403 here says nothing about the configured value.
    throw new Error(
      "Cannot verify ATTIO_DEFAULT_DEAL_OWNER: the Attio token is not permitted to read workspace members. Grant it that scope or confirm the owner by hand. This is a token permission problem, not evidence that the owner is wrong.",
    );
  }
  const emails = await valuesFrom("/workspace_members", response, "email_address");
  const match = [...emails].some((email) => email.toLowerCase() === owner.toLowerCase());
  if (!match) {
    throw new Error(
      "ATTIO_DEFAULT_DEAL_OWNER does not match any Attio workspace member, so deal creation will be rejected",
    );
  }
  expect(match).toBe(true);
});

//=============================================================================================================
//The interested workflow's own schema. The counter slugs above are configured, so a typo in an environment
//variable is what could break them. These are hardcoded in lib/interested.ts instead, so what breaks them is
//somebody RENAMING an attribute in Attio - which nothing in this repo would notice until a live lead hit it.
//
//The slugs are not listed by hand here. A lead carrying every field a provider could ever supply is run through
//the real mappers, and whatever keys they produce are what the workflow would genuinely write. A slug added to
//a mapper is therefore covered by these tests the moment it is added, with no second list to keep in step.
//=============================================================================================================

/** A lead with every field populated, so the mappers emit every slug they are capable of emitting. */
const MAXIMAL_LEAD = interestedLead("instantly", {
  emails: ["ada@example.com"],
  phones: ["+15555550123"],
  firstName: "Ada",
  lastName: "Lovelace",
  linkedin: "https://www.linkedin.com/in/ada",
  jobTitle: "Head of Engineering",
  description: "A headline",
  location: "Bristol",
  companyName: "Engines Ltd",
  companyDomain: "engines.example",
  companyAddress: "12 Dock Rd, Bristol, Avon, United Kingdom, BS1 6XX",
  employeeCount: "84",
  annualRevenue: "4318000",
  industry: "information technology & services",
  website: "https://engines.example",
  campaignName: "Q3 Founders",
  occurredAtMs: Date.now(),
});

async function expectSlugsExist(object: string, slugs: readonly string[]): Promise<void> {
  const live = await attioValues(`/objects/${object}/attributes`, "api_slug");
  const missing = slugs.filter((slug) => !live.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `The interested workflow writes ${missing.join(", ")} on the Attio ${object} object, and no such attribute exists there. Either it was renamed in Attio or the mapping in lib/interested.ts is wrong.`,
    );
  }
  expect(missing).toEqual([]);
}

liveTest("every Person attribute the workflow writes exists on the people object", async () => {
  //`company` is a relationship written as a record reference; it is an attribute like any other here.
  await expectSlugsExist("people", Object.keys(personValuesFor(MAXIMAL_LEAD, "00000000-0000-0000-0000-000000000000")));
});

liveTest("every Company attribute the workflow writes exists on the companies object", async () => {
  await expectSlugsExist("companies", Object.keys(companyValuesFor(MAXIMAL_LEAD)));
});

liveTest("every Deal attribute the workflow writes exists on the deals object", async () => {
  //name, stage, owner, and the two associations are written by ensureInterestedDeal rather than the mapper,
  //so they are named here explicitly - a create fails outright if any of them is missing.
  const created = ["name", "stage", "owner", "associated_people", "associated_company"];
  await expectSlugsExist("deals", [...created, ...Object.keys(dealValuesFor(MAXIMAL_LEAD))]);
});

//---------------------------------------------------------------------------------------------------------
//Select attributes reject any value that is not one of their options, so the bucket labels in lib/interested.ts
//have to match Attio's option titles exactly - a renamed option is a rejected write, not a wrong one.
//Every bucket is generated from a value that lands in it, so the check covers the whole range rather than a
//sample of it.
//---------------------------------------------------------------------------------------------------------
liveTest("every Employee range bucket the workflow can produce is a real option", async () => {
  const options = await attioValues("/objects/companies/attributes/employee_range/options", "title");
  const produced = ["5", "25", "84", "500", "2500", "7500", "25000", "75000", "250000"]
    .map((count) => toEmployeeRange(count))
    .filter((bucket): bucket is string => bucket !== null);
  expect(produced).toHaveLength(9);
  const missing = produced.filter((bucket) => !options.has(bucket));
  if (missing.length > 0) {
    throw new Error(`toEmployeeRange produces ${missing.join(", ")}, which Attio's Employee range no longer offers`);
  }
  expect(missing).toEqual([]);
});

liveTest("every Estimated ARR bucket the workflow can produce is a real option", async () => {
  const options = await attioValues("/objects/companies/attributes/estimated_arr_usd/options", "title");
  const produced = ["500000", "4318000", "25000000", "75000000", "150000000", "300000000", "750000000", "5000000000", "50000000000"]
    .map((amount) => toArrBucket(amount))
    .filter((bucket): bucket is string => bucket !== null);
  expect(produced).toHaveLength(9);
  const missing = produced.filter((bucket) => !options.has(bucket));
  if (missing.length > 0) {
    throw new Error(`toArrBucket produces ${missing.join(", ")}, which Attio's Estimated ARR no longer offers`);
  }
  expect(missing).toEqual([]);
});

liveTest("the Interested deal stage exists", async () => {
  const statuses = await attioValues("/objects/deals/attributes/stage/statuses", "title");
  if (!statuses.has("Interested")) {
    throw new Error(
      'Attio\'s deal pipeline has no "Interested" stage, so every deal these workflows open would be rejected',
    );
  }
  expect(statuses.has("Interested")).toBe(true);
});

//---------------------------------------------------------------------------------------------------------
//Suppression reaches two provider endpoints that nothing else in the codebase touches, so a key scoped only
//for reading campaigns and emails passes every check above and still cannot suppress anybody.
//Reads only. Whether a WRITE is permitted cannot be proven without making one, and a blocklist entry is not
//something a smoke test should leave behind.
//---------------------------------------------------------------------------------------------------------
liveTest("the Instantly blocklist is readable, so suppression has somewhere to write", async () => {
  await expectOk(
    "Instantly blocklist",
    await fetch(`${INSTANTLY_BASE}/block-lists-entries?limit=1`, {
      headers: { Authorization: instantlyAuthHeader() },
    }),
  );
});

liveTest("the Instantly lead record is readable, so an interested lead can be enriched", async () => {
  await expectOk(
    "Instantly leads",
    await fetch(`${INSTANTLY_BASE}/leads/list`, {
      method: "POST",
      headers: { Authorization: instantlyAuthHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    }),
  );
});

//=============================================================================================================
//Secrets that no external call can validate. Presence is all this can check, but a blank value here is the
//difference between a working route and a permanent 401.
//=============================================================================================================

liveTest("the request-verification secrets are configured", () => {
  const missing = ["CRON_SECRET", "INSTANTLY_WEBHOOK_SECRET", "HEYREACH_WEBHOOK_SECRET"]
    .filter((name) => optionalEnv(name) === null);
  if (missing.length > 0) {
    throw new Error(`Not configured, so the matching routes will reject every request: ${missing.join(", ")}`);
  }
  expect(missing).toEqual([]);
});
