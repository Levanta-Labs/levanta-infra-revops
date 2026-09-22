import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { POST as instantlyInterested } from "../../api/instantly-interested.js";
import { DEFAULT_DUPLICATE_WINDOW_MS } from "../../lib/interested.js";
import { installFetchMock, jsonResponse, noteWrites, type FetchCall } from "./test-utils.js";

//=============================================================================================================
//Declining an event that repeats one already recorded.
//
//The bug these cover: a provider delivers the same interest twice - HeyReach's webhook is registered against
//ALL campaigns, so a lead enrolled in several produces one delivery apiece - and every delivery appended its
//own note to the Person and the Deal, plus a run transcript. Attio has no note upsert and no idempotency key,
//so the only place to catch it is a read before the write.
//
//Driven through the Instantly route because its payload is the thinnest of the four; the check itself lives in
//lib/interested.ts and is shared by all of them, so the provider here is incidental.
//=============================================================================================================

const envNames = [
  "ATTIO_API_KEY",
  "ATTIO_DEFAULT_DEAL_OWNER",
  "INSTANTLY_API_KEY",
  "INSTANTLY_WEBHOOK_SECRET",
  "INTERESTED_DUPLICATE_WINDOW_MS",
] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  process.env.INSTANTLY_API_KEY = "instantly-key";
  process.env.INSTANTLY_WEBHOOK_SECRET = "hook-secret";
  delete process.env.INTERESTED_DUPLICATE_WINDOW_MS;
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const INSTANTLY_TITLE = "Instantly Cold Outreach";

function interestedRequest(): Request {
  return new Request("https://example.com/api/instantly-interested", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": "hook-secret" },
    body: JSON.stringify({
      event_type: "lead_interested",
      lead_email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      campaign_name: "Outbound",
    }),
  });
}

/** A Person Attio already holds, linked to a deal - which is the state any completed run leaves behind. */
const PERSON_WITH_DEAL = {
  name: [{ full_name: "Ada Lovelace" }],
  associated_deals: [{ target_object: "deals", target_record_id: "deal-1" }],
  company: [{ target_object: "companies", target_record_id: "company-1" }],
};

function note(title: string, agedMs: number): unknown {
  return {
    id: { workspace_id: "w", note_id: `note-${title}-${agedMs}` },
    title,
    created_at: new Date(Date.now() - agedMs).toISOString(),
  };
}

//---------------------------------------------------------------------------------------------------------
//Every call the shared workflow makes, with the note listing under the caller's control.
//`pages` is answered by offset, so a test can put a match on the second page and prove the walk reaches it.
//---------------------------------------------------------------------------------------------------------
function mockAttio(pages: (offset: number) => Response, person: Record<string, unknown> = PERSON_WITH_DEAL) {
  return installFetchMock((url, init) => {
    const method = init?.method ?? "GET";
    if (url.includes("/notes") && method === "GET") {
      return pages(Number(new URL(url).searchParams.get("offset") ?? "0"));
    }
    if (url.includes("/notes")) return jsonResponse({ data: {} });
    if (url.includes("objects/people/records/query")) {
      return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: person }] });
    }
    if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
    if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
    if (url.includes("objects/companies/records")) {
      return jsonResponse({ data: { id: { record_id: "company-1" }, values: { name: [{ value: "Engines Ltd" }] } } });
    }
    if (url.includes("objects/deals/records")) {
      return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
    }
    if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
    if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
    if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
    if (url.includes("api.heyreach.io")) return jsonResponse({ items: [], hasNextPage: false });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

const onePage = (notes: unknown[]) => () => jsonResponse({ data: notes });

function noteListings(calls: readonly FetchCall[]): readonly FetchCall[] {
  return calls.filter((call) => call.input.includes("/notes") && (call.init?.method ?? "GET") === "GET");
}

/**
 * Everything that CHANGES something, which is not the same as every POST: Attio's record query and Instantly's
 * lead list are both reads spelled as POSTs, and a lookup is exactly what a declined repeat is still allowed.
 */
function writes(calls: readonly FetchCall[]): readonly FetchCall[] {
  return calls.filter((call) => {
    const method = call.init?.method ?? "GET";
    if (method === "GET" || call.input.includes("/records/query") || call.input.includes("/leads/list")) {
      return false;
    }
    return true;
  });
}

describe("declining a repeated interested event", () => {
  test("writes nothing when the person already carries this run's note from inside the window", async () => {
    const mock = mockAttio(onePage([note(INSTANTLY_TITLE, 30_000)]));
    try {
      const response = await instantlyInterested(interestedRequest());
      const body = (await response.json()) as { duplicate?: boolean; personId?: string; dealId?: string };

      expect(response.status).toBe(200);
      expect(body.duplicate).toBe(true);
      //The ids are the existing records', so a caller still learns what the lead resolved to.
      expect(body.personId).toBe("person-1");
      expect(body.dealId).toBe("deal-1");
      //Nothing was written at all: no note, no attribute patch, no DNC entry, no blocklist call.
      expect(writes(mock.calls).map((call) => call.input)).toEqual([]);
    } finally {
      mock.restore();
    }
  });

  test("records normally when the matching note is older than the window", async () => {
    const mock = mockAttio(onePage([note(INSTANTLY_TITLE, DEFAULT_DUPLICATE_WINDOW_MS + 60_000)]));
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(false);
      //A lead who re-engages weeks later is a real second event and earns its own note.
      expect(noteWrites(mock.calls).length).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });

  test("ignores a recent note this run would not have written", async () => {
    //Another provider's note, and the run transcript, both sit on the same Person and must not silence it.
    const mock = mockAttio(
      onePage([
        note("HeyReach Cold Outreach", 30_000),
        note("run logs for automated integration (Instantly marked as interested)", 30_000),
      ]),
    );
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(false);
      expect(noteWrites(mock.calls).length).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });

  test("finds a match past the first page, because Attio documents no sort order", async () => {
    const filler = Array.from({ length: 50 }, (_, index) => note(`filler-${index}`, 30_000));
    const mock = mockAttio((offset) =>
      offset === 0 ? jsonResponse({ data: filler }) : jsonResponse({ data: [note(INSTANTLY_TITLE, 30_000)] }),
    );
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(true);
      expect(noteListings(mock.calls)).toHaveLength(2);
    } finally {
      mock.restore();
    }
  });

  test("stops paging at the bound and fails open rather than dropping the lead", async () => {
    //Every page full, so the walk never sees its end. Absence cannot be concluded, so the event is recorded.
    const full = Array.from({ length: 50 }, (_, index) => note(`filler-${index}`, 30_000));
    const mock = mockAttio(() => jsonResponse({ data: full }));
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(false);
      expect(noteListings(mock.calls)).toHaveLength(4);
      expect(noteWrites(mock.calls).length).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });

  test("records the lead when the listing itself fails", async () => {
    //A wrong "yes" discards a real interested lead; a wrong "no" writes a duplicate note. Only one is silent.
    const mock = mockAttio(() => jsonResponse({ error: "nope" }, 403));
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(false);
      expect(noteWrites(mock.calls).length).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });

  test("records the lead when a recent note sits on a person carrying no deal", async () => {
    //No completed run leaves that behind - the deal is created before the notes - so the note did not come
    //from one, and inventing a deal id for the outcome would be worse than recording the event again.
    const mock = mockAttio(onePage([note(INSTANTLY_TITLE, 30_000)]), {
      name: [{ full_name: "Ada Lovelace" }],
      associated_deals: [],
      company: [],
    });
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(false);
      expect(noteWrites(mock.calls).length).toBeGreaterThan(0);
    } finally {
      mock.restore();
    }
  });

  test("reads nothing when the window is set to zero, which turns the check off", async () => {
    process.env.INTERESTED_DUPLICATE_WINDOW_MS = "0";
    const mock = mockAttio(onePage([note(INSTANTLY_TITLE, 1_000)]));
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(false);
      expect(noteListings(mock.calls)).toEqual([]);
    } finally {
      mock.restore();
    }
  });

  test("honours a widened window from the environment", async () => {
    process.env.INTERESTED_DUPLICATE_WINDOW_MS = String(DEFAULT_DUPLICATE_WINDOW_MS * 4);
    const mock = mockAttio(onePage([note(INSTANTLY_TITLE, DEFAULT_DUPLICATE_WINDOW_MS * 2)]));
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("falls back to the default when the window is malformed", async () => {
    process.env.INTERESTED_DUPLICATE_WINDOW_MS = "soon";
    const mock = mockAttio(onePage([note(INSTANTLY_TITLE, 30_000)]));
    try {
      const response = await instantlyInterested(interestedRequest());
      //Losing the override is a tuning problem; losing the event is a data problem, so it does not throw.
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("costs a first-time lead no listing at all, because a new person carries no notes", async () => {
    const mock = installFetchMock((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("objects/people/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
      if (url.includes("objects/people/records")) {
        return jsonResponse({ data: { id: { record_id: "person-9" }, values: PERSON_WITH_DEAL } });
      }
      if (url.includes("objects/companies/records")) {
        return jsonResponse({ data: { id: { record_id: "company-1" }, values: { name: [{ value: "Engines Ltd" }] } } });
      }
      if (url.includes("objects/deals/records")) {
        return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
      }
      if (url.includes("/notes")) return jsonResponse({ data: {} });
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
      if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
      if (url.includes("api.heyreach.io")) return jsonResponse({ items: [], hasNextPage: false });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const response = await instantlyInterested(interestedRequest());
      expect(((await response.json()) as { duplicate?: boolean }).duplicate).toBe(false);
      expect(noteListings(mock.calls)).toEqual([]);
    } finally {
      mock.restore();
    }
  });
});
