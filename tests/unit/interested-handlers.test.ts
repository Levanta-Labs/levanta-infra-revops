import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST as aircallInterested } from "../../api/aircall-interested.js";
import { POST as instantlyInterested } from "../../api/instantly-interested.js";
import { installFetchMock, jsonResponse, type FetchCall } from "./test-utils.js";

const envNames = [
  "ATTIO_API_KEY",
  "ATTIO_DEFAULT_DEAL_OWNER",
  "INSTANTLY_API_KEY",
  "INSTANTLY_WEBHOOK_SECRET",
  "AIRCALL_WEBHOOK_TOKEN",
  "AIRCALL_INTERESTED_TAGS",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  process.env.INSTANTLY_API_KEY = "instantly-key";
  process.env.INSTANTLY_WEBHOOK_SECRET = "hook-secret";
  process.env.AIRCALL_WEBHOOK_TOKEN = "aircall-token";
  process.env.AIRCALL_INTERESTED_TAGS = "Interested, Booked";
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function interestedRequest(body: unknown, secret = "hook-secret"): Request {
  return new Request("https://example.com/api/instantly-interested", {
    method: "POST",
    headers: { "x-webhook-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const leadInterested = {
  event_type: "lead_interested",
  lead_email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  campaign_name: "Outbound",
};

/** Mocks a found Person whose listed attributes already hold a value in Attio. */
function mockAttio(populated: Record<string, unknown>) {
  return installFetchMock((url) => {
    if (url.includes("objects/people/records/query")) {
      return jsonResponse({
        data: [{ id: { record_id: "person-1" }, values: populated }],
      });
    }
    if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
    if (url.includes("/notes")) return jsonResponse({ data: {} });
    if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
    if (url.includes("objects/people/records/person-1")) return jsonResponse({ data: {} });
    if (url.includes("objects/deals/records")) return jsonResponse({ data: { id: { record_id: "deal-1" } } });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function personPatches(calls: readonly FetchCall[]): readonly FetchCall[] {
  return calls.filter(
    (call) => call.input.includes("objects/people/records/person-1") && call.init?.method === "PATCH",
  );
}

describe("interested webhook handlers", () => {
  test("rejects a request without the shared webhook secret", async () => {
    const response = await instantlyInterested(interestedRequest(leadInterested, "wrong"));
    expect(response.status).toBe(401);
  });

  test("skips events that are not lead_interested without touching Attio", async () => {
    const mock = mockAttio({});
    try {
      const response = await instantlyInterested(
        interestedRequest({ ...leadInterested, event_type: "email_opened" }),
      );
      expect(await response.json()).toMatchObject({ skipped: true });
      expect(mock.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("never overwrites attributes Attio already holds", async () => {
    const mock = mockAttio({
      email_addresses: [{ email_address: "existing@example.com" }],
      name: [{ full_name: "A. L. Byron" }],
      lead_source: [{ value: "Aircall Cold Outreach" }],
      associated_deals: [{ target_record_id: "deal-1" }],
    });
    try {
      const response = await instantlyInterested(interestedRequest(leadInterested));
      expect(response.status).toBe(200);
      // Every candidate attribute is already populated, so no write is attempted at all.
      expect(personPatches(mock.calls)).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("backfills only the attributes that are blank in Attio", async () => {
    const mock = mockAttio({
      email_addresses: [{ email_address: "ada@example.com" }],
      name: [],
      associated_deals: [{ target_record_id: "deal-1" }],
    });
    try {
      const response = await instantlyInterested(interestedRequest(leadInterested));
      expect(response.status).toBe(200);

      const patches = personPatches(mock.calls);
      expect(patches).toHaveLength(1);
      const values = JSON.parse(String(patches[0]?.init?.body)).data.values;
      expect(values.lead_source).toBe("Instantly Cold Outreach");
      expect(values.name).toEqual([
        { first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace" },
      ]);
      expect(values.email_addresses).toBeUndefined();
    } finally {
      mock.restore();
    }
  });

  test("still writes history notes on both the person and the deal", async () => {
    const mock = mockAttio({
      email_addresses: [{ email_address: "ada@example.com" }],
      associated_deals: [{ target_record_id: "deal-1" }],
    });
    try {
      await instantlyInterested(interestedRequest(leadInterested));
      const noteParents = mock.calls
        .filter((call) => call.input.includes("/notes"))
        .map((call) => JSON.parse(String(call.init?.body)).data.parent_object);
      expect(noteParents).toEqual(["people", "deals"]);
    } finally {
      mock.restore();
    }
  });

  test("separates a call with no tags from a call whose tags are not interested", async () => {
    const call = (tags: readonly string[]) => ({
      event: "call.tagged",
      timestamp: 1_700_000_000,
      token: "aircall-token",
      data: {
        id: 4242,
        status: "done",
        direction: "inbound",
        raw_digits: "+15551234567",
        started_at: 1_700_000_000,
        ended_at: 1_700_000_060,
        duration: 60,
        tags: tags.map((name) => ({ name })),
      },
    });
    const request = (body: unknown) =>
      new Request("https://example.com/api/aircall-interested", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const untagged = await aircallInterested(request(call([])));
    expect(await untagged.json()).toEqual({ skipped: true, reason: "tag not found" });

    const wrongTags = await aircallInterested(request(call(["Voicemail", "Follow up"])));
    expect(await wrongTags.json()).toEqual({
      skipped: true,
      reason: "tag not tracked",
      tags: ["Voicemail", "Follow up"],
    });
  });

  test("rejects an Aircall payload carrying a bad token before reading any tag", async () => {
    const response = await aircallInterested(
      new Request("https://example.com/api/aircall-interested", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "call.tagged",
          timestamp: 1,
          token: "wrong-token",
          data: { id: 1, status: "done", started_at: 1, duration: 0, tags: [] },
        }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("adds the person to the DNC list", async () => {
    const mock = mockAttio({
      email_addresses: [{ email_address: "ada@example.com" }],
      associated_deals: [{ target_record_id: "deal-1" }],
    });
    try {
      await instantlyInterested(interestedRequest(leadInterested));
      expect(mock.calls.some((call) => call.input.includes("/lists/dnc/entries"))).toBe(true);
    } finally {
      mock.restore();
    }
  });
});
