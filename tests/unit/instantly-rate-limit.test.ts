import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GET as instantlySync } from "../../api/cron/instantly-touchpoint-sync.js";
import { POST as instantlyInterested } from "../../api/instantly-interested.js";
import {
  fetchInstantlyEmails,
  fetchInstantlyEmailWindow,
  INSTANTLY_SYNC_PAGE_LIMIT,
  InstantlyRateLimitError,
} from "../../lib/instantly.js";
import { installFetchMock, jsonResponse, notesResponse, type FetchCall } from "./test-utils.js";

//=============================================================================================================
//Instantly answers 429 at 20 requests a minute, and fetchInstantlyEmailWindow pages a hundred emails at a
//time with no pause, so any real backlog reaches the ceiling within seconds.
//
//The bug these cover: that 429 was an ordinary thrown Error. It abandoned the whole run, and because the sync
//saves its cursor AFTER the loop, the mark never moved - so the next run re-read the same window, hit the
//same ceiling at the same page, and discarded the same work. Production sat in that loop for five days with
//the cursor frozen at 2026-09-17T14:12:55Z.
//
//The invariant worth protecting is therefore not "no 429" - it is that a run which hits one still SAVES ITS
//CURSOR, because that is the only thing that makes the next run different from this one.
//=============================================================================================================

const envNames = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "INSTANTLY_API_KEY",
  "INSTANTLY_WEBHOOK_SECRET",
  "CRON_SECRET",
  "ATTIO_API_KEY",
  "ATTIO_DEFAULT_DEAL_OWNER",
  "ATTIO_PERSON_INSTANTLY_COUNTER_SLUG",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.INSTANTLY_API_KEY = "instantly-key";
  process.env.INSTANTLY_WEBHOOK_SECRET = "hook-secret";
  process.env.CRON_SECRET = "cron-secret";
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  process.env.ATTIO_PERSON_INSTANTLY_COUNTER_SLUG = "instantly_touchpoints";
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const TOO_MANY = { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded. Maximum 20 requests per minute allowed." };

function cronRequest(): Request {
  return new Request("https://example.com/api/cron/instantly-touchpoint-sync", {
    headers: { authorization: "Bearer cron-secret" },
  });
}

/** One page of `count` emails, with a next cursor unless this is the last. */
function emailPage(page: number, count: number, more: boolean): Response {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `email-${page}-${index}`,
    timestamp_created: new Date(Date.UTC(2026, 8, 17, 15, page, index)).toISOString(),
    timestamp_email: new Date(Date.UTC(2026, 8, 17, 15, page, index)).toISOString(),
    //Instantly spells the direction `ue_type`; 2 is a received reply, which is a countable touchpoint.
    ue_type: 2,
    lead: "ada@example.com",
    subject: "Re: hello",
    body: { text: "Yes, interested." },
  }));
  return jsonResponse({ items, next_starting_after: more ? `after-${page}` : null });
}

function cursorSaves(calls: readonly FetchCall[]): readonly FetchCall[] {
  return calls.filter((call) => call.input.includes("supabase.co") && call.init?.method === "POST");
}

describe("reading an Instantly window that cannot be read in one go", () => {
  test("keeps the pages it read when Instantly refuses the next one", async () => {
    let page = 0;
    const mock = installFetchMock(() => {
      if (page >= 2) return jsonResponse(TOO_MANY, 429);
      page += 1;
      return emailPage(page, 100, true);
    });
    try {
      const window = await fetchInstantlyEmailWindow({ fromMs: 0, toMs: Date.now() });
      //The whole point: 200 real emails survive the refusal instead of being discarded with it.
      expect(window.emails).toHaveLength(200);
      expect(window.stoppedBy).toBe("throttled");
      expect(window.pagesRead).toBe(2);
    } finally {
      mock.restore();
    }
  });

  test("stops itself at the page cap, short of the ceiling, when the window keeps going", async () => {
    let requests = 0;
    const mock = installFetchMock(() => {
      requests += 1;
      return emailPage(requests, 100, true);
    });
    try {
      const window = await fetchInstantlyEmailWindow(
        { fromMs: 0, toMs: Date.now() },
        INSTANTLY_SYNC_PAGE_LIMIT,
      );
      expect(window.stoppedBy).toBe("page-limit");
      expect(window.pagesRead).toBe(INSTANTLY_SYNC_PAGE_LIMIT);
      //Under Instantly's 20 a minute, with headroom left for the interested route sharing the same key.
      expect(requests).toBeLessThan(20);
    } finally {
      mock.restore();
    }
  });

  test("still raises anything that is not a rate limit", async () => {
    //A 500 says nothing about how much of the window exists. Treating the part already read as the whole of
    //it would park the cursor past emails that were never seen, losing them for good.
    const mock = installFetchMock(() => jsonResponse({ error: "boom" }, 500));
    try {
      await expect(fetchInstantlyEmailWindow({ fromMs: 0, toMs: Date.now() })).rejects.toThrow("500");
    } finally {
      mock.restore();
    }
  });

  test("refuses to hand a half-read thread to the interested note", async () => {
    //Unlike the cron there is no cursor to resume from here - the note is written once - so half a thread
    //rendered as though it were the whole is a misleading note rather than deferred work.
    let page = 0;
    const mock = installFetchMock(() => {
      if (page >= 1) return jsonResponse(TOO_MANY, 429);
      page += 1;
      return emailPage(page, 100, true);
    });
    try {
      await expect(fetchInstantlyEmails({ leadEmail: "ada@example.com" })).rejects.toBeInstanceOf(
        InstantlyRateLimitError,
      );
    } finally {
      mock.restore();
    }
  });
});

describe("the Instantly sync under a rate limit", () => {
  //-----------------------------------------------------------------------------------------------------
  //Attio answers everything with "no such person", so every email is skipped. That keeps these tests about
  //the fetch and the cursor rather than about touchpoint writing, which cron-handlers.test.ts already covers.
  //-----------------------------------------------------------------------------------------------------
  function mockSync(instantly: () => Response) {
    return installFetchMock((url, init) => {
      if (url.includes("supabase.co") && init?.method === "POST") return new Response(null, { status: 204 });
      //No stored cursor, so getSyncCursor starts from its own lookback and saveSyncCursor creates the row.
      if (url.includes("supabase.co")) return jsonResponse([]);
      if (url.includes("api.instantly.ai")) return instantly();
      if (url.includes("objects/people/records/query")) return jsonResponse({ data: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  test("saves its cursor after a throttled read instead of abandoning the run", async () => {
    //THE REGRESSION TEST. Before this, the 429 threw past saveSyncCursor and the mark never moved, so every
    //subsequent run repeated this one exactly. A saved cursor is the whole difference.
    let page = 0;
    const mock = mockSync(() => {
      if (page >= 2) return jsonResponse(TOO_MANY, 429);
      page += 1;
      return emailPage(page, 100, true);
    });
    try {
      const response = await instantlySync(cronRequest());
      const body = (await response.json()) as { success?: boolean; stopReason?: string; emailsFound?: number };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.stopReason).toBe("window-throttled");
      //The 200 emails it did read are the run's window, not a discarded loss.
      expect(body.emailsFound).toBe(200);
      expect(cursorSaves(mock.calls)).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("does not park the cursor at now when the window was short", async () => {
    //Parking claims everything up to this moment was dealt with. The emails beyond the truncation were never
    //even fetched, so parking would step over them permanently - the silent version of the original bug.
    const mock = mockSync(() => jsonResponse(TOO_MANY, 429));
    try {
      const response = await instantlySync(cronRequest());
      const body = (await response.json()) as { cursorTimestamp?: string; stopReason?: string };
      expect(body.stopReason).toBe("window-throttled");

      const saved = cursorSaves(mock.calls);
      expect(saved).toHaveLength(1);
      const sent = JSON.parse(String(saved[0]?.init?.body)) as { cursor_timestamp?: string };
      //Still at the mark this run started from - nothing was read, so nothing may be claimed.
      expect(Date.parse(String(sent.cursor_timestamp))).toBeLessThan(Date.now() - 60_000);
      expect(body.cursorTimestamp).toBe(String(sent.cursor_timestamp));
    } finally {
      mock.restore();
    }
  });

  test("reports the page cap separately from a refusal, because they want different responses", async () => {
    //Hitting the cap is a backlog draining as designed. Being refused means something else is spending this
    //key's allowance, and the cap is too high. Both truncate the window; only one is a problem.
    const mock = mockSync(() => emailPage(1, 100, true));
    try {
      const response = await instantlySync(cronRequest());
      const body = (await response.json()) as { stopReason?: string; truncated?: boolean };
      expect(body.stopReason).toBe("window-truncated");
      expect(body.truncated).toBe(true);
      expect(cursorSaves(mock.calls)).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("reads the window to its end and parks normally when nothing gets in the way", async () => {
    const mock = mockSync(() => emailPage(1, 3, false));
    try {
      const response = await instantlySync(cronRequest());
      const body = (await response.json()) as { stopReason?: string; truncated?: boolean; emailsFound?: number };
      expect(body.truncated).toBe(false);
      expect(body.stopReason).toBeUndefined();
      expect(body.emailsFound).toBe(3);
    } finally {
      mock.restore();
    }
  });
});

describe("an interested lead arriving while the sync is draining a backlog", () => {
  test("is recorded without its thread rather than lost", async () => {
    //The sync spends up to fifteen of the key's twenty requests a minute while draining, so a webhook can be
    //refused through no fault of its own. Raising would 500 the webhook and lose the lead to save a note body.
    const mock = installFetchMock((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("api.instantly.ai/api/v2/emails")) return jsonResponse(TOO_MANY, 429);
      if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
      if (url.includes("objects/people/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
      if (url.includes("objects/people/records")) {
        return jsonResponse({ data: { id: { record_id: "person-1" }, values: { associated_deals: [], company: [], name: [] } } });
      }
      if (url.includes("objects/deals/records")) {
        return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
      }
      if (url.includes("/notes")) return notesResponse(init);
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
      if (url.includes("api.heyreach.io")) return jsonResponse({ items: [], hasNextPage: false });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await instantlyInterested(
        new Request("https://example.com/api/instantly-interested", {
          method: "POST",
          headers: { "content-type": "application/json", "x-webhook-secret": "hook-secret" },
          body: JSON.stringify({
            event_type: "lead_interested",
            lead_email: "ada@example.com",
            campaign_name: "Outbound",
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, personId: "person-1" });

      //The note says the history could not be READ, which is not the same as there being none - the reader is
      //looking for the reply and needs to know it exists somewhere.
      const note = mock.calls.find(
        (call) => call.input.includes("/notes") && call.init?.method === "POST",
      );
      const body = JSON.parse(String(note?.init?.body)) as { data?: { content?: string } };
      expect(body.data?.content).toContain("could not be read");
      expect(body.data?.content).toContain("Outbound");
    } finally {
      mock.restore();
    }
  });
});
