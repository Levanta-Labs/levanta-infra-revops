import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET as heyReachSync } from "../../api/cron/heyreach-touchpoint-sync.js";
import { installFetchMock, jsonResponse, type FetchCall } from "./test-utils.js";

//=============================================================================================================
//HeyReach's from/to filter is day-granular: a five-minute window returns every conversation touched since UTC
//midnight, messages and all. These tests pin down that the per-message cursor absorbs that, so a TAM touchpoint
//is written exactly once however many times its conversation comes back.
//=============================================================================================================

const envNames = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "HEYREACH_API_KEY",
  "CRON_SECRET",
  "ATTIO_API_KEY",
  "ATTIO_PERSON_HEYREACH_COUNTER_SLUG",
  "ATTIO_COMPANY_HEYREACH_COUNTER_SLUG",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.HEYREACH_API_KEY = "heyreach-key";
  process.env.CRON_SECRET = "cron-secret";
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_PERSON_HEYREACH_COUNTER_SLUG = "number_of_dms";
  process.env.ATTIO_COMPANY_HEYREACH_COUNTER_SLUG = "number_of_dms_6";
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const PROFILE_URL = "https://www.linkedin.com/in/ada-lovelace";
/** Two minutes old: newer than the ten-minute lookback a first run starts from. */
const MESSAGE_AT = new Date(Date.now() - 2 * 60 * 1000).toISOString();
/** Eight days old, the kind of message the day-granular filter drags back in every run. */
const STALE_AT = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

/** What HeyReach actually returns for a five-minute window: the whole conversation, old messages included. */
const CONVERSATION_PAGE = {
  items: [
    {
      id: "conversation-1",
      linkedInAccountId: 77,
      lastMessageAt: MESSAGE_AT,
      correspondentProfile: {
        profileUrl: PROFILE_URL,
        firstName: "Ada",
        lastName: "Lovelace",
        companyName: "Analytical Engines",
      },
      messages: [
        { createdAt: STALE_AT, body: "an old reply", subject: null, sender: "lead" },
        { createdAt: MESSAGE_AT, body: "a fresh reply", subject: null, sender: "lead" },
      ],
    },
  ],
  totalCount: 1,
  hasNextPage: false,
  nextCursor: null,
};

const PERSON_PAGE = {
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
};

function heyReachMock(cursorRow?: unknown) {
  return installFetchMock((url, init) => {
    if (url.includes("supabase.co")) {
      if (init?.method === "POST") return new Response(null, { status: 204 });
      return jsonResponse(cursorRow === undefined ? [] : [cursorRow]);
    }
    if (url.includes("api.heyreach.io")) return jsonResponse(CONVERSATION_PAGE);
    if (url.includes("objects/people/records/query")) return jsonResponse(PERSON_PAGE);
    if (url.includes("/entries")) return jsonResponse({ data: [{ list_id: { slug: "master_tam_list" } }] });
    if (url.includes("objects/people/records/person-1")) {
      return init?.method === "PATCH"
        ? jsonResponse({})
        : jsonResponse({ data: { values: { number_of_dms: [{ value: 4 }] } } });
    }
    if (url.includes("objects/companies/records/company-1")) {
      return init?.method === "PATCH"
        ? jsonResponse({})
        : jsonResponse({ data: { values: { number_of_dms_6: [{ value: 9 }] } } });
    }
    if (url.includes("/notes")) return jsonResponse({});
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

const cronRequest = (): Request =>
  new Request("https://example.com/api/cron/heyreach-touchpoint-sync", {
    headers: { Authorization: "Bearer cron-secret" },
  });

const notes = (calls: readonly FetchCall[]): readonly FetchCall[] =>
  calls.filter((call) => call.input.includes("/notes"));
const counterWrites = (calls: readonly FetchCall[]): readonly FetchCall[] =>
  calls.filter((call) => call.input.includes("/records/") && call.init?.method === "PATCH");
const savedCursor = (calls: readonly FetchCall[]): Record<string, unknown> => {
  const writes = calls.filter((call) => call.input.includes("supabase.co") && call.init?.method === "POST");
  return JSON.parse(String(writes[writes.length - 1]?.init?.body)) as Record<string, unknown>;
};

describe("a TAM touchpoint whose conversation is re-returned every run", () => {
  test("is written once on the run that first sees it, and the stale message beside it is ignored", async () => {
    const mock = heyReachMock();
    try {
      const response = await heyReachSync(cronRequest());
      expect(response.status).toBe(200);

      // Both messages came back; only the one after the cursor was acted on.
      expect(await response.json()).toMatchObject({
        success: true,
        messagesFound: 2,
        processed: 1,
      });
      expect(notes(mock.calls)).toHaveLength(2); // one on the person, one on the company
      expect(counterWrites(mock.calls)).toHaveLength(2); // person counter and company counter
    } finally {
      mock.restore();
    }
  });

  test("is not written again on the next run, even though HeyReach returns it again", async () => {
    const first = heyReachMock();
    let carried: Record<string, unknown>;
    try {
      await heyReachSync(cronRequest());
      carried = savedCursor(first.calls);
    } finally {
      first.restore();
    }

    const second = heyReachMock({
      sync_key: "heyreach-touchpoints",
      cursor_value: carried.cursor_value,
      cursor_timestamp: carried.cursor_timestamp,
    });
    try {
      const response = await heyReachSync(cronRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        messagesFound: 2, // HeyReach hands back the same two messages
        processed: 0, // and neither is acted on
      });

      // The proof: no second note and no second counter increment.
      expect(notes(second.calls)).toHaveLength(0);
      expect(counterWrites(second.calls)).toHaveLength(0);
    } finally {
      second.restore();
    }
  });

  test("stays written once across many consecutive runs", async () => {
    let carried: Record<string, unknown> | undefined;
    let totalNotes = 0;
    let totalCounters = 0;

    for (let run = 0; run < 5; run += 1) {
      const mock = heyReachMock(
        carried === undefined
          ? undefined
          : {
              sync_key: "heyreach-touchpoints",
              cursor_value: carried.cursor_value,
              cursor_timestamp: carried.cursor_timestamp,
            },
      );
      try {
        await heyReachSync(cronRequest());
        totalNotes += notes(mock.calls).length;
        totalCounters += counterWrites(mock.calls).length;
        carried = savedCursor(mock.calls);
      } finally {
        mock.restore();
      }
    }

    // Five runs, one touchpoint: two notes and two counter increments in total, not ten.
    expect(totalNotes).toBe(2);
    expect(totalCounters).toBe(2);
  });
});
