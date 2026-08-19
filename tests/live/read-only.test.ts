import { expect, test } from "bun:test";

const liveTest = process.env.RUN_LIVE_TESTS === "1" ? test : test.skip;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Live test requires ${name}`);
  return value;
}

async function expectOk(label: string, response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(`${label} read-only smoke test failed with HTTP ${response.status}`);
  }
  expect(response.ok).toBe(true);
}

liveTest("reads the Supabase cursor table", async () => {
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || required("SUPABASE_SERVICE_ROLE_KEY");
  const url = new URL(
    "/rest/v1/Attio_Integrations_Touchpoint_Cursors",
    required("SUPABASE_URL"),
  );
  url.searchParams.set("select", "sync_key,cursor_timestamp");
  url.searchParams.set("limit", "1");
  const headers: Record<string, string> = { apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  await expectOk("Supabase", await fetch(url, { headers }));
});

liveTest("identifies the Attio token", async () => {
  await expectOk(
    "Attio",
    await fetch("https://api.attio.com/v2/self", {
      headers: { Authorization: `Bearer ${required("ATTIO_API_KEY")}` },
    }),
  );
});

liveTest("reads one Aircall calls page", async () => {
  const credentials = Buffer.from(
    `${required("AIRCALL_API_ID")}:${required("AIRCALL_API_TOKEN")}`,
  ).toString("base64");
  await expectOk(
    "Aircall",
    await fetch("https://api.aircall.io/v1/calls?per_page=1&order=desc", {
      headers: { Authorization: `Basic ${credentials}` },
    }),
  );
});

liveTest("reads one Instantly email preview", async () => {
  await expectOk(
    "Instantly",
    await fetch("https://api.instantly.ai/api/v2/emails?limit=1&preview_only=true", {
      headers: { Authorization: `Bearer ${required("INSTANTLY_API_KEY")}` },
    }),
  );
});

liveTest("reads one HeyReach conversation page", async () => {
  await expectOk(
    "HeyReach",
    await fetch("https://api.heyreach.io/api/public/inbox/GetConversationsV3", {
      method: "POST",
      headers: {
        "X-API-KEY": required("HEYREACH_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit: 1, cursor: null, filters: {} }),
    }),
  );
});
