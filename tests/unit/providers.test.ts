import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchAircallCalls, parseAircallCall, toE164 } from "../../lib/aircall.js";
import { callSubject, logInterestedDecision } from "../../lib/aircall-interested.js";
import {
  fetchHeyReachConversations,
  heyReachMessageId,
  parseHeyReachConversation,
  stopLeadInActiveCampaigns,
} from "../../lib/heyreach.js";
import { fetchInstantlyEmails, parseInstantlyEmail } from "../../lib/instantly.js";
import { installFetchMock, jsonResponse } from "./test-utils.js";

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
  test("parses the documented call fields", () => {
    const call = parseAircallCall(aircallCall);
    expect(call.rawDigits).toBe("+15555550123");
    expect(call.contact?.email).toBe("ada@example.com");
    expect(call.tags).toEqual([{ name: "Interested" }]);
  });

  test("normalises the punctuated raw_digits Aircall sends into the E.164 Attio matches on", () => {
    //Every shape seen across a 300-call sample, US and international.
    expect(toE164("+1 949-735-4000")).toBe("+19497354000");
    expect(toE164("+44 7812 661348")).toBe("+447812661348");
    expect(toE164("+353 87 258 4998")).toBe("+353872584998");
    expect(toE164("+19497354000")).toBe("+19497354000");
    expect(toE164(null)).toBeNull();
    expect(toE164("")).toBeNull();
  });

  test("names the call's other party for a log line, falling back to the number", () => {
    const call = (contact: unknown, rawDigits: string | null = "+1 813-919-6470") =>
      parseAircallCall({ id: 1, status: "done", started_at: 1, duration: 0, raw_digits: rawDigits, contact });

    expect(callSubject(call({ first_name: "Abhi", last_name: "Visuvasam" }))).toBe("Abhi Visuvasam +18139196470");
    //A dialled campaign call has no contact at all, which is the case the log most needs to stay readable for.
    expect(callSubject(call(null))).toBe("+18139196470");
    expect(callSubject(call({ company_name: "Schellman" }, null))).toBe("Schellman");
    expect(callSubject(call(null, null))).toBe("no contact and no number on the call");
  });

  test("logs a decision for every call the interested check sees, matched or not", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => void lines.push(String(line));
    const call = (tags: readonly string[]) =>
      parseAircallCall({
        id: 42,
        status: "done",
        started_at: 1,
        duration: 0,
        raw_digits: "+1 813-919-6470",
        tags: tags.map((name) => ({ name })),
      });
    const interested = new Set(["booked", "connected"]);
    try {
      expect(logInterestedDecision(call(["Outbound Campaign", "Booked"]), interested)).toEqual(["Booked"]);
      expect(logInterestedDecision(call(["Outbound Campaign"]), interested)).toEqual([]);
      expect(logInterestedDecision(call([]), interested)).toEqual([]);
    } finally {
      console.log = original;
    }

    //A miss is as loud as a hit, and says what the tags were compared against.
    expect(lines[0]).toBe(
      '[interested] poll call 42 (+18139196470): INTERESTED - matched ["Booked"] of ["Outbound Campaign","Booked"]',
    );
    expect(lines[1]).toBe(
      '[interested] poll call 42 (+18139196470): not interested - ["Outbound Campaign"] matches none of ["booked","connected"]',
    );
    expect(lines[2]).toBe(
      "[interested] poll call 42 (+18139196470): not interested - the call carries no tags at all",
    );
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
