import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET as aircallSync } from "../../api/cron/aircall-touchpoint-sync.js";
import { GET as heyReachSync } from "../../api/cron/heyreach-touchpoint-sync.js";
import { GET as instantlySync } from "../../api/cron/instantly-touchpoint-sync.js";
import { installFetchMock, jsonResponse } from "./test-utils.js";

const envNames = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "AIRCALL_API_ID",
  "AIRCALL_API_TOKEN",
  "AIRCALL_INTERESTED_TAGS",
  "ATTIO_DEFAULT_DEAL_OWNER",
  "INSTANTLY_API_KEY",
  "HEYREACH_API_KEY",
  "CRON_SECRET",
  "ATTIO_API_KEY",
  "ATTIO_PERSON_AIRCALL_COUNTER_SLUG",
  "ATTIO_PERSON_INSTANTLY_COUNTER_SLUG",
  "ATTIO_PERSON_HEYREACH_COUNTER_SLUG",
  "ATTIO_COMPANY_AIRCALL_COUNTER_SLUG",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.AIRCALL_API_ID = "aircall-id";
  process.env.AIRCALL_API_TOKEN = "aircall-token";
  process.env.AIRCALL_INTERESTED_TAGS = "Booked, Connected";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  process.env.INSTANTLY_API_KEY = "instantly-key";
  process.env.HEYREACH_API_KEY = "heyreach-key";
  process.env.CRON_SECRET = "cron-secret";
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_PERSON_AIRCALL_COUNTER_SLUG = "number_of_calls";
  process.env.ATTIO_PERSON_INSTANTLY_COUNTER_SLUG = "number_of_emails";
  process.env.ATTIO_PERSON_HEYREACH_COUNTER_SLUG = "number_of_dms";
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

  test("Aircall runs the interested workflow for a polled call already carrying an interested tag", async () => {
    //The tag is applied after the call, so the poll is what finds it - there is no webhook in this path at all.
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("objects/people/records/person-1/entries")) return jsonResponse({ data: [] });
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: { associated_deals: [] } }] });
      }
      if (url.includes("objects/people/records/person-1")) return jsonResponse({ data: {} });
      if (url.includes("objects/deals/records")) return jsonResponse({ data: { id: { record_id: "deal-1" } } });
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("/notes")) return jsonResponse({ data: {} });
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+1 555-555-0123",
              started_at: Math.floor(Date.now() / 1000) - 120,
              ended_at: Math.floor(Date.now() / 1000) - 60,
              duration: 42,
              tags: [{ name: "Outbound Campaign" }, { name: "Booked" }],
              contact: { id: 77, first_name: "Ada", last_name: "Lovelace", emails: [{ value: "ada@example.com" }] },
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await aircallSync(cronRequest());
      expect(await response.json()).toMatchObject({ success: true, callsFound: 1, interested: 1 });

      //A deal, a note on the person and on the deal, and the DNC listing - the full interested workflow.
      expect(mock.calls.some((call) => call.input.includes("objects/deals/records"))).toBe(true);
      expect(mock.calls.filter((call) => call.input.includes("/notes"))).toHaveLength(2);
      expect(mock.calls.some((call) => call.input.includes("/lists/dnc/entries"))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("Aircall still acts on an interested tag applied to a call the cursor has already passed", async () => {
    //The call ended six minutes ago and the cursor was saved four minutes ago, so the touchpoint side has finished
    //with it. The tag was applied since. Only the ten-minute lookback brings it back for the interested check:
    //min(cursor, now - 10m) reaches further back than the cursor alone, which is the whole point of the constant.
    const endedAt = Math.floor(Date.now() / 1000) - 360;
    const cursorSavedAt = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) {
        return jsonResponse([{ sync_key: "aircall-touchpoints", cursor_value: null, cursor_timestamp: cursorSavedAt }]);
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: { associated_deals: [] } }] });
      }
      if (url.includes("objects/people/records/person-1")) return jsonResponse({ data: {} });
      if (url.includes("objects/deals/records")) return jsonResponse({ data: { id: { record_id: "deal-1" } } });
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("/notes")) return jsonResponse({ data: {} });
      if (url.includes("api.aircall.io")) {
        //The requested window must reach back past the cursor, or this call would not be returned at all.
        const from = Number(new URL(url).searchParams.get("from")) * 1000;
        expect(from).toBeLessThan(Date.parse(cursorSavedAt));
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+1 555-555-0123",
              started_at: endedAt - 60,
              ended_at: endedAt,
              duration: 60,
              tags: [{ name: "Booked" }],
              contact: { id: 77, first_name: "Ada", last_name: "Lovelace", emails: [{ value: "ada@example.com" }] },
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const body = await (await aircallSync(cronRequest())).json();
      //Interested ran; the touchpoint did not, because the cursor is still past this call.
      expect(body).toMatchObject({
        callsFound: 1,
        callsInScope: 1,
        interested: 1,
        processed: 0,
        skipped: 0,
        not_tam: 0,
      });
      expect(mock.calls.some((call) => call.input.includes("objects/deals/records"))).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("Aircall reaches back past the longest call, because the API filters on creation time", async () => {
    //Regression: /calls filters on when a call was CREATED, but this sync places calls by when they ENDED. A
    //call lasting longer than the completion window used to be filtered out as "not done" on every run that
    //covered its start, then fell out of range before it ever looked finished - lost entirely. The requested
    //`from` must therefore sit a full call-duration margin below the oldest completion the run acts on.
    let requestedFromMs = 0;
    const startedAt = Math.floor(Date.now() / 1000) - 95 * 60; //began 95 minutes ago
    const endedAt = Math.floor(Date.now() / 1000) - 60; //ended one minute ago
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("objects/people/records/person-1/entries")) {
        return jsonResponse({ data: [{ list_id: { slug: "master_tam_list" } }] });
      }
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: { associated_deals: [] } }] });
      }
      if (url.includes("objects/people/records/person-1")) {
        //Serves both the interested patch and the counter's read-then-write.
        return init?.method === "PATCH" ? jsonResponse({}) : jsonResponse({ data: { values: { number_of_calls: [] } } });
      }
      if (url.includes("objects/deals/records")) return jsonResponse({ data: { id: { record_id: "deal-1" } } });
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("/notes")) return jsonResponse({ data: {} });
      if (url.includes("api.aircall.io")) {
        requestedFromMs = Number(new URL(url).searchParams.get("from")) * 1000;
        //Only returned because the window reaches back far enough to cover the call's start.
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+1 555-555-0123",
              started_at: startedAt,
              ended_at: endedAt,
              duration: endedAt - startedAt,
              tags: [{ name: "Booked" }],
              contact: { id: 77, first_name: "Ada", last_name: "Lovelace", emails: [{ value: "ada@example.com" }] },
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const body = await (await aircallSync(cronRequest())).json();
      //A 95-minute call that ended a minute ago is both counted and checked for its tag.
      expect(body).toMatchObject({ callsFound: 1, processed: 1, interested: 1 });
      expect(requestedFromMs).toBeLessThan(startedAt * 1000);
    } finally {
      mock.restore();
    }
  });

  test("Aircall ignores a call that ended before the window it acts on, despite the wider fetch", async () => {
    //The margin above drags in old calls purely for reach. Neither gate may act on them: the cursor blocks the
    //touchpoint, and an explicit completion floor blocks the interested check that is not cursor-gated.
    const endedAt = Math.floor(Date.now() / 1000) - 3 * 60 * 60; //finished three hours ago
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+1 555-555-0123",
              started_at: endedAt - 60,
              ended_at: endedAt,
              duration: 60,
              tags: [{ name: "Booked" }],
              contact: { id: 77, first_name: "Ada", last_name: "Lovelace", emails: [{ value: "ada@example.com" }] },
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const body = await (await aircallSync(cronRequest())).json();
      //Fetched for reach, but outside scope, so neither gate acts and the summary says so.
      expect(body).toMatchObject({ callsFound: 1, callsInScope: 0, processed: 0, interested: 0, failed: 0 });
      //No Attio call of any kind: an old call must not be re-recorded just because the fetch reached it.
      expect(mock.calls.some((call) => call.input.includes("api.attio.com"))).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("every sync parks its cursor short of now, so late-published events are not skipped", async () => {
    const saved: number[] = [];
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") {
        saved.push(Date.parse(JSON.parse(String(init.body)).cursor_timestamp));
        return new Response(null, { status: 204 });
      }
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.aircall.io")) return jsonResponse({ calls: [], meta: { next_page_link: null } });
      if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
      return jsonResponse({ items: [], totalCount: 0, hasNextPage: false, nextCursor: null });
    });
    try {
      const before = Date.now();
      await aircallSync(cronRequest());
      await instantlySync(cronRequest());
      await heyReachSync(cronRequest());
      expect(saved).toHaveLength(3);
      //CURSOR_GRACE_MS is two minutes; each mark must land at least a minute behind the run's own clock.
      for (const mark of saved) expect(mark).toBeLessThanOrEqual(before - 60_000);
    } finally {
      mock.restore();
    }
  });

  test("Aircall leaves a polled call alone when none of its tags are interested", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("objects/people/records/query")) return jsonResponse({ data: [] });
      if (url.includes("api.aircall.io")) {
        return jsonResponse({
          calls: [
            {
              id: 1,
              status: "done",
              direction: "outbound",
              raw_digits: "+1 555-555-0123",
              started_at: Math.floor(Date.now() / 1000) - 120,
              ended_at: Math.floor(Date.now() / 1000) - 60,
              duration: 42,
              tags: [{ name: "Outbound Campaign" }],
            },
          ],
          meta: { next_page_link: null },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      expect(await (await aircallSync(cronRequest())).json()).toMatchObject({ callsFound: 1, interested: 0 });
      expect(mock.calls.some((call) => call.input.includes("objects/deals/records"))).toBe(false);
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
