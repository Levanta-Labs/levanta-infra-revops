import { expect, test } from "bun:test";
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

const liveTest = process.env.RUN_LIVE_TESTS === "1" ? test : test.skip;

async function expectOk(label: string, response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(`${label} read-only smoke test failed with HTTP ${response.status}`);
  }
  expect(response.ok).toBe(true);
}

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
