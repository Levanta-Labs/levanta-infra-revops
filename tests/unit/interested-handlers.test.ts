import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST as instantlyInterested } from "../../api/instantly-interested.js";
import { POST as outfoundInterested } from "../../api/outfound-interested.js";
import { historyNoteCalls, installFetchMock, jsonResponse, type FetchCall } from "./test-utils.js";

const envNames = [
  "ATTIO_API_KEY",
  "ATTIO_DEFAULT_DEAL_OWNER",
  "INSTANTLY_API_KEY",
  "INSTANTLY_WEBHOOK_SECRET",
  "OUTFOUND_API_KEY",
  "OUTFOUND_WEBHOOK_SECRET",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  process.env.INSTANTLY_API_KEY = "instantly-key";
  process.env.INSTANTLY_WEBHOOK_SECRET = "hook-secret";
  process.env.OUTFOUND_API_KEY = "outfound-key";
  process.env.OUTFOUND_WEBHOOK_SECRET = "hook-secret";
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

//---------------------------------------------------------------------------------------------------------
//Mocks a found Person whose listed attributes already hold a value in Attio, plus every other call the shared
//workflow makes: the company lookup, the deal read-back, the notes, and the suppression across all platforms.
//`populated` is the Person's attribute values as Attio would return them - an empty array meaning blank.
//---------------------------------------------------------------------------------------------------------
function mockAttio(populated: Record<string, unknown>) {
  return installFetchMock((url, init) => {
    const method = init?.method ?? "GET";
    if (url.includes("objects/people/records/query")) {
      return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: populated }] });
    }
    //No company matches, so the workflow either creates one or records none.
    if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
    if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
    if (url.includes("objects/companies/records")) {
      return jsonResponse({ data: { id: { record_id: "company-1" }, values: { name: [{ value: "Engines Ltd" }] } } });
    }
    //Covers both the read-back of a reused deal and the creation of a new one.
    if (url.includes("objects/deals/records")) {
      return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
    }
    if (url.includes("/notes")) return jsonResponse({ data: {} });
    if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
    if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
    if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
    if (url.includes("api.heyreach.io")) return jsonResponse({ items: [], hasNextPage: false });
    if (url.includes("/prospects/lookup/conversations")) {
      return jsonResponse({
        lead_email: "ada@example.com",
        enrichment: {
          title: "CTO",
          person_linkedin: "https://www.linkedin.com/in/ada",
          company: { company_name: "Engines Ltd", company_domain: "engines.example", headcount: "51-200" },
        },
        clients: [
          {
            recent_conversations: [
              { id: "c1", thread_hash: "t1", conversation_type: "Received", subject: "Re: hello", body: "Yes, interested.", timestamp_email: "2026-08-19T11:00:00Z" },
            ],
          },
        ],
      });
    }
    if (url.includes("/mark-as-dnc")) return jsonResponse({ updated_count: 1 });
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

  test("never overwrites attributes Attio already holds, save for lead source", async () => {
    //Every attribute the mapping can produce for this lead, already holding a value. The address matches the
    //one the webhook carries, so even the multiselect merge has nothing to add.
    const mock = mockAttio({
      email_addresses: [{ email_address: "ada@example.com" }],
      name: [{ full_name: "A. L. Byron" }],
      lead_source: [{ value: "Aircall Cold Outreach" }],
      job_title: [{ value: "Countess" }],
      description: [{ value: "Wrote the first program" }],
      location: [{ value: "London" }],
      linkedin: [{ value: "https://linkedin.com/in/byron" }],
      campaign_name: [{ value: "An earlier campaign" }],
      date_added: [{ value: "2020-01-01" }],
      associated_deals: [{ target_record_id: "deal-1" }],
    });
    try {
      const response = await instantlyInterested(interestedRequest(leadInterested));
      expect(response.status).toBe(200);
      //Every candidate attribute is already populated, so the only thing written is the one slug this run is
      //entitled to restate - see ALWAYS_OVERWRITE (lib/interested.ts). The Aircall label Attio held is replaced
      //by the channel that actually produced this event, and nothing else moves.
      const patches = personPatches(mock.calls);
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String(patches[0]?.init?.body)).data.values).toEqual({
        lead_source: "Instantly Cold Outreach - Automated",
      });
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
      expect(values.lead_source).toBe("Instantly Cold Outreach - Automated");
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
      const noteParents = historyNoteCalls(mock.calls).map(
        (call) => JSON.parse(String(call.init?.body)).data.parent_object,
      );
      expect(noteParents).toEqual(["people", "deals"]);
    } finally {
      mock.restore();
    }
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

//=============================================================================================================
//Outfound. The route deliberately has NO category filter - which categories fire is configured on Outfound's
//side - so what is asserted here is that everything authenticated is recorded, whatever the category says.
//=============================================================================================================

function outfoundRequest(body: unknown, secret = "hook-secret"): Request {
  return new Request("https://example.com/api/outfound-interested", {
    method: "POST",
    headers: { "x-webhook-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const outfoundCategorised = {
  event_type: "Interested",
  lead_email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
  company_name: "Engines Ltd",
  campaign_name: "Q3 Outbound",
  timestamp: "2026-08-19T11:00:00.000Z",
};

describe("outfound interested webhook", () => {
  test("rejects a request whose secret does not match, before reading the body", async () => {
    const response = await outfoundInterested(outfoundRequest(outfoundCategorised, "wrong"));
    expect(response.status).toBe(401);
  });

  test("rejects a payload with no lead_email, which there is nothing to record without", async () => {
    const mock = mockAttio({});
    try {
      const response = await outfoundInterested(outfoundRequest({ event_type: "Interested" }));
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: string }).error).toContain("lead_email");
    } finally {
      mock.restore();
    }
  });

  //The point of the design: the category list lives on Outfound, so the route must not second-guess it.
  test("records every category alike, including ones no code here has heard of", async () => {
    for (const eventType of ["Interested", "Meeting Booked", "Refer Request", "Some Future Tag"]) {
      const mock = mockAttio({});
      try {
        const response = await outfoundInterested(
          outfoundRequest({ ...outfoundCategorised, event_type: eventType }),
        );
        expect(response.status).toBe(200);
        expect(((await response.json()) as { success: boolean }).success).toBe(true);
      } finally {
        mock.restore();
      }
    }
  });

  test("records a lead whose payload carries no category at all", async () => {
    const mock = mockAttio({});
    try {
      const { event_type: _eventType, ...withoutCategory } = outfoundCategorised;
      const response = await outfoundInterested(outfoundRequest(withoutCategory));
      expect(response.status).toBe(200);
    } finally {
      mock.restore();
    }
  });

  test("writes the Outfound lead source and dates the lead by Outfound's clock, not ours", async () => {
    const mock = mockAttio({});
    try {
      await outfoundInterested(outfoundRequest(outfoundCategorised));
      const patch = personPatches(mock.calls)[0];
      const values = (JSON.parse(String(patch?.init?.body)) as { data: { values: Record<string, unknown> } }).data.values;
      expect(values.lead_source).toBe("Outfound Cold Outreach - Automated");
      //The webhook's own timestamp, not Date.now() - the warehouse lags by minutes.
      expect(values.date_added).toBe("2026-08-19");
    } finally {
      mock.restore();
    }
  });

  test("notes the conversation history the lookup returned", async () => {
    const mock = mockAttio({});
    try {
      await outfoundInterested(outfoundRequest(outfoundCategorised));
      const notes = historyNoteCalls(mock.calls);
      expect(notes.length).toBeGreaterThan(0);
      const body = JSON.stringify(notes.map((note) => JSON.parse(String(note.init?.body))));
      expect(body).toContain("Yes, interested.");
    } finally {
      mock.restore();
    }
  });

  //[STABILITY] The category is deliberately confined to the Vercel log. The run transcript (lib/run-log.ts)
  //mirrors console output onto the Person, Company and Deal, so a category logged inside the run scope would
  //reach all three - which is exactly what was asked not to happen. This is what holds that line.
  test("never writes the lead category to Attio, in any note or attribute", async () => {
    const mock = mockAttio({});
    try {
      await outfoundInterested(
        outfoundRequest({ ...outfoundCategorised, event_type: "Meeting Booked" }),
      );
      //Every request body the run sent to Attio - notes, patches, creates, and the run transcript alike.
      const attioBodies = mock.calls
        .filter((call) => call.input.includes("api.attio.com"))
        .map((call) => String(call.init?.body ?? ""))
        .join(" | ");
      expect(attioBodies).not.toContain("Meeting Booked");
      //The run transcript itself is present, so this is proving absence from a note that really was written.
      expect(attioBodies).toContain("run logs for automated integration");
    } finally {
      mock.restore();
    }
  });

  //[STABILITY] The lookup supplies both the enrichment and the note, so a failure costs both - but not the event.
  test("still records the lead when the Outfound lookup fails", async () => {
    const mock = installFetchMock((url, init) => {
      if (url.includes("/prospects/lookup/conversations")) return jsonResponse({ detail: "boom" }, 500);
      const method = init?.method ?? "GET";
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: {} }] });
      }
      if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
      if (url.includes("objects/companies/records")) {
        return jsonResponse({ data: { id: { record_id: "company-1" }, values: { name: [{ value: "Engines Ltd" }] } } });
      }
      if (url.includes("objects/deals/records")) {
        return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
      }
      if (url.includes("/notes")) return jsonResponse({ data: {} });
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
      if (url.includes("api.heyreach.io")) return jsonResponse({ items: [], hasNextPage: false });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await outfoundInterested(outfoundRequest(outfoundCategorised));
      expect(response.status).toBe(200);
    } finally {
      mock.restore();
    }
  });
});
