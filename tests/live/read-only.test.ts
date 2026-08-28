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
