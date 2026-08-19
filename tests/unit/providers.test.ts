import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchAircallCalls, parseAircallWebhook } from "../../lib/aircall.ts";
import {
  fetchHeyReachConversations,
  heyReachMessageId,
  parseHeyReachConversation,
  stopLeadInActiveCampaigns,
} from "../../lib/heyreach.ts";
import { fetchInstantlyEmails, parseInstantlyEmail } from "../../lib/instantly.ts";
import { installFetchMock, jsonResponse } from "./test-utils.ts";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.AIRCALL_API_ID = "id";
  process.env.AIRCALL_API_TOKEN = "token";
  process.env.INSTANTLY_API_KEY = "instantly";
  process.env.HEYREACH_API_KEY = "heyreach";
});

afterEach(() => {
  for (const name of ["AIRCALL_API_ID", "AIRCALL_API_TOKEN", "INSTANTLY_API_KEY", "HEYREACH_API_KEY"]) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const aircallCall = {
  id: 42,
  status: "done",
  direction: "outbound",
  raw_digits: "+15555550123",
  started_at: 1_700_000_000,
  ended_at: 1_700_000_120,
  duration: 120,
  tags: [{ name: "Interested" }],
  contact: {
    first_name: "Ada",
    last_name: "Lovelace",
    company_name: "Analytical Engines",
    emails: [{ value: "ada@example.com" }],
  },
};

const instantlyEmail = {
  id: "email-1",
  timestamp_created: "2026-08-19T11:54:36.149Z",
  timestamp_email: "2026-08-19T11:53:36.149Z",
  ue_type: 2,
  is_auto_reply: 0,
  lead: "ada@example.com",
  subject: "Re: Hello",
  body: { text: "Interested", html: "<p>Interested</p>" },
  thread_id: "thread-1",
};

const heyReachConversation = {
  id: "conversation-1",
  linkedInAccountId: 12,
  lastMessageAt: "2026-08-19T12:00:00.000Z",
  correspondentProfile: {
    linkedin_id: "linkedin-1",
    profileUrl: "https://linkedin.com/in/ada",
    firstName: "Ada",
    lastName: "Lovelace",
    companyName: "Analytical Engines",
  },
  messages: [
    { createdAt: "2026-08-19T12:00:00.000Z", body: "Hello", subject: null, sender: "LEAD" },
  ],
};

describe("Aircall client", () => {
  test("parses the documented webhook envelope and call fields", () => {
    const webhook = parseAircallWebhook({
      event: "call.tagged",
      timestamp: 1_700_000_121,
      token: "webhook-token",
      data: aircallCall,
    });
    expect(webhook.call.rawDigits).toBe("+15555550123");
    expect(webhook.call.contact?.email).toBe("ada@example.com");
    expect(webhook.call.tags).toEqual([{ name: "Interested" }]);
  });

  test("follows Aircall next_page_link pagination", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({ calls: [aircallCall], meta: { next_page_link: "https://api.aircall.io/v1/calls?page=2" } })
        : jsonResponse({ calls: [], meta: { next_page_link: null } }),
    );
    try {
      expect(await fetchAircallCalls(1_699_999_000_000, 1_700_001_000_000)).toHaveLength(1);
      expect(mock.calls).toHaveLength(2);
      expect(new Headers(mock.calls[0]?.init?.headers).get("authorization")).toBe("Basic aWQ6dG9rZW4=");
    } finally {
      mock.restore();
    }
  });
});

describe("Instantly client", () => {
  test("parses the current v2 email schema", () => {
    expect(parseInstantlyEmail(instantlyEmail)).toMatchObject({
      id: "email-1",
      emailType: "received",
      leadEmail: "ada@example.com",
      bodyText: "Interested",
    });
  });

  test("uses documented timestamp, lead, ordering, and cursor parameters", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({ items: [instantlyEmail], next_starting_after: "next" })
        : jsonResponse({ items: [], next_starting_after: null }),
    );
    try {
      const emails = await fetchInstantlyEmails({
        fromMs: Date.parse("2026-08-19T00:00:00.000Z"),
        toMs: Date.parse("2026-08-20T00:00:00.000Z"),
        leadEmail: "ada@example.com",
      });
      expect(emails).toHaveLength(1);
      const firstUrl = new URL(mock.calls[0]?.input ?? "");
      expect(firstUrl.searchParams.get("lead")).toBe("ada@example.com");
      expect(firstUrl.searchParams.get("sort_order")).toBe("asc");
      expect(firstUrl.searchParams.has("min_timestamp_created")).toBe(true);
      expect(new URL(mock.calls[1]?.input ?? "").searchParams.get("starting_after")).toBe("next");
    } finally {
      mock.restore();
    }
  });
});

describe("HeyReach client", () => {
  test("parses the GetConversationsV3 schema and creates stable message IDs", async () => {
    const conversation = parseHeyReachConversation(heyReachConversation);
    const message = conversation.messages[0];
    expect(message).toBeDefined();
    const first = await heyReachMessageId(conversation, message!);
    const second = await heyReachMessageId(conversation, message!);
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
  });

  test("uses V3 cursor pagination and date filters", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({ items: [heyReachConversation], totalCount: 1, hasNextPage: true, nextCursor: "cursor-2" })
        : jsonResponse({ items: [], totalCount: 1, hasNextPage: false, nextCursor: null }),
    );
    try {
      expect(await fetchHeyReachConversations({ fromMs: 1_700_000_000_000, toMs: 1_700_001_000_000 })).toHaveLength(1);
      const firstBody = JSON.parse(String(mock.calls[0]?.init?.body));
      const secondBody = JSON.parse(String(mock.calls[1]?.init?.body));
      expect(firstBody).toMatchObject({ limit: 100, cursor: null });
      expect(secondBody.cursor).toBe("cursor-2");
    } finally {
      mock.restore();
    }
  });

  test("mocks destructive campaign stops and only targets active leads", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({
            items: [
              { campaignId: 10, campaignStatus: "IN_PROGRESS", leadStatus: "InSequence" },
              { campaignId: 11, campaignStatus: "FINISHED", leadStatus: "Finished" },
            ],
          })
        : new Response(null, { status: 200 }),
    );
    try {
      expect(
        await stopLeadInActiveCampaigns("https://linkedin.com/in/ada", "ada@example.com"),
      ).toBe(1);
      expect(mock.calls).toHaveLength(2);
      expect(mock.calls[0]?.input).toEndWith("/campaign/GetCampaignsForLead");
      expect(mock.calls[1]?.input).toEndWith("/campaign/StopLeadInCampaign");
      expect(JSON.parse(String(mock.calls[1]?.init?.body))).toEqual({
        campaignId: 10,
        leadMemberId: null,
        leadUrl: "https://linkedin.com/in/ada",
      });
    } finally {
      mock.restore();
    }
  });
});
