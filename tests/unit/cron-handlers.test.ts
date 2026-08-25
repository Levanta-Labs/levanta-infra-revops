import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET as aircallSync } from "../../api/cron/aircall-touchpoint-sync.ts";
import { GET as heyReachSync } from "../../api/cron/heyreach-touchpoint-sync.ts";
import { GET as instantlySync } from "../../api/cron/instantly-touchpoint-sync.ts";
import { installFetchMock, jsonResponse } from "./test-utils.ts";

const envNames = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "AIRCALL_API_ID",
  "AIRCALL_API_TOKEN",
  "INSTANTLY_API_KEY",
  "HEYREACH_API_KEY",
  "CRON_SECRET",
  "ATTIO_API_KEY",
  "ATTIO_COMPANY_AIRCALL_COUNTER_SLUG",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.AIRCALL_API_ID = "aircall-id";
  process.env.AIRCALL_API_TOKEN = "aircall-token";
  process.env.INSTANTLY_API_KEY = "instantly-key";
  process.env.HEYREACH_API_KEY = "heyreach-key";
  process.env.CRON_SECRET = "cron-secret";
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_COMPANY_AIRCALL_COUNTER_SLUG = "number_of_calls";
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function cronRequest(): Request {
  return new Request("https://example.com/api/cron/sync", {
    headers: { Authorization: "Bearer cron-secret" },
  });
}

describe("cron handlers", () => {
  test("rejects an invalid Vercel cron secret before external calls", async () => {
    const response = await aircallSync(new Request("https://example.com", { headers: { Authorization: "Bearer wrong" } }));
    expect(response.status).toBe(401);
  });

  test("Aircall completes an empty read window and persists its high-water mark", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      return jsonResponse({ calls: [], meta: { next_page_link: null } });
    });
    try {
      const response = await aircallSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, callsFound: 0 });
      expect(mock.calls.some((call) => call.input.includes("api.aircall.io"))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("Aircall touchpoint sync increments counters and notes only the company, not the person", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("objects/people/records/person-1/entries")) {
        return jsonResponse({ data: [{ list_id: { slug: "master_tam_list" } }] });
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({
          data: [
            {
              id: { record_id: "person-1" },
              values: {
                associated_deals: [],
                company: [{ target_record_id: "company-1" }],
                name: [{ full_name: "Ada Lovelace" }],
              },
            },
          ],
        });
      }
      if (url.includes("objects/people/records/person-1")) {
        return init?.method === "PATCH" ? jsonResponse({}) : jsonResponse({ data: { values: { number_of_calls: [] } } });
      }
      if (url.includes("objects/companies/records/company-1")) {
        return init?.method === "PATCH" ? jsonResponse({}) : jsonResponse({ data: { values: { number_of_calls: [] } } });
      }
      if (url.includes("/notes")) return jsonResponse({});
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+15555550123",
              started_at: Math.floor(Date.now() / 1000) - 120,
              ended_at: Math.floor(Date.now() / 1000) - 60,
              duration: 42,
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, callsFound: 1, processed: 1 });

      const noteCalls = mock.calls.filter((call) => call.input.includes("/notes"));
      expect(noteCalls).toHaveLength(1);
      expect(String(noteCalls[0]?.init?.body)).toContain('"parent_object":"companies"');

      const personPatchCalls = mock.calls.filter(
        (call) => call.input.includes("objects/people/records/person-1") && call.init?.method === "PATCH",
      );
      expect(personPatchCalls).toHaveLength(1);
      const companyPatchCalls = mock.calls.filter(
        (call) => call.input.includes("objects/companies/records/company-1") && call.init?.method === "PATCH",
      );
      expect(companyPatchCalls).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("Instantly completes an empty read window and persists its high-water mark", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      return jsonResponse({ items: [], next_starting_after: null });
    });
    try {
      const response = await instantlySync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, emailsFound: 0 });
    } finally {
      mock.restore();
    }
  });

  test("HeyReach completes an empty read window and persists its high-water mark", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      return jsonResponse({ items: [], totalCount: 0, hasNextPage: false, nextCursor: null });
    });
    try {
      const response = await heyReachSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, messagesFound: 0 });
    } finally {
      mock.restore();
    }
  });
});
