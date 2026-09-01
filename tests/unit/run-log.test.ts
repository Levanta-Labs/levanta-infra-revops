import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { recordInterestedLead, interestedLead } from "../../lib/interested.js";
import { runLogArtifact, withRunLog } from "../../lib/run-log.js";
import { installFetchMock, jsonResponse, type FetchCall } from "./test-utils.js";

//=============================================================================================================
//The run transcript (lib/run-log.ts). Additive diagnostics, so what is asserted here is that it records the
//run faithfully AND that it cannot damage one: outside a scope it is inert, and inside one every way it can
//fail is swallowed.
//=============================================================================================================

const envNames = ["ATTIO_API_KEY", "ATTIO_DEFAULT_DEAL_OWNER", "INSTANTLY_API_KEY", "HEYREACH_API_KEY"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.ATTIO_API_KEY = "attio-key";
  process.env.ATTIO_DEFAULT_DEAL_OWNER = "owner@example.com";
  process.env.INSTANTLY_API_KEY = "instantly-key";
  process.env.HEYREACH_API_KEY = "heyreach-key";
});

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

//The Person as Attio returns it after the run - the state the transcript reads back and reports.
const PERSON_AFTER = {
  id: { record_id: "person-1" },
  values: {
    name: [{ first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace" }],
    email_addresses: [{ email_address: "ada@example.com" }],
    phone_numbers: [{ original_phone_number: "+15555550123" }],
    company: [{ target_record_id: "company-1" }],
    job_title: [{ value: "Engineer" }],
    lead_source: [{ option: { title: "Instantly Cold Outreach - Automated" } }],
    //Holds nothing, so it must not appear in either state.
    linkedin: [],
  },
};

//---------------------------------------------------------------------------------------------------------
//Every Attio and platform call one interested run makes. `found` is what the person lookup returns - null for
//a lead Attio has never seen, which is the branch that must report no previous state.
//---------------------------------------------------------------------------------------------------------
function mockRun(found: Record<string, unknown> | null) {
  return installFetchMock((url, init) => {
    const method = init?.method ?? "GET";
    if (url.includes("objects/people/records/query")) {
      return jsonResponse({ data: found ? [{ id: { record_id: "person-1" }, values: found }] : [] });
    }
    if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
    if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
    //The transcript's own read-back of the person, and the create when the lookup found nobody.
    if (url.includes("objects/people/records")) return jsonResponse({ data: PERSON_AFTER });
    if (url.includes("objects/companies/records")) {
      return jsonResponse({ data: { id: { record_id: "company-1" }, values: { name: [{ value: "Engines Ltd" }] } } });
    }
    if (url.includes("objects/deals/records")) return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
    if (url.includes("/notes")) return jsonResponse({ data: {} });
    if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
    if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
    if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
    if (url.includes("api.heyreach.io")) return jsonResponse({ items: [], hasNextPage: false });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function run(overrides: { readonly findsPerson: boolean; readonly history?: () => Promise<string> }) {
  return recordInterestedLead({
    lead: interestedLead("instantly", {
      emails: ["ada@example.com"],
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: "Engines Ltd",
      occurredAtMs: Date.UTC(2026, 8, 1),
    }),
    subject: "run-log test",
    findPerson: async () =>
      overrides.findsPerson
        ? ({
            id: { record_id: "person-1" },
            rawValues: { name: [{ full_name: "Ada Lovelace" }], company: [{ target_record_id: "company-1" }] },
            populatedAttributes: new Set(["name", "company"]),
            values: { associated_deals: [], company: [{ target_record_id: "company-1" }], name: [{ full_name: "Ada Lovelace" }] },
          })
        : null,
    history: overrides.history ?? (async () => "the thread"),
  });
}

/** The transcript note, which is the only note titled "run logs ...". Null when the run posted none. */
function transcript(calls: readonly FetchCall[]): { title: string; content: string; parent: string } | null {
  for (const call of calls) {
    if (!call.input.includes("/notes")) continue;
    const body = JSON.parse(String(call.init?.body)) as {
      data: { title: string; content: string; parent_object: string };
    };
    if (body.data.title.startsWith("run logs")) {
      return { title: body.data.title, content: body.data.content, parent: body.data.parent_object };
    }
  }
  return null;
}

describe("run transcript", () => {
  test("posts one note to the person, titled for the platform that reported the interest", async () => {
    const mock = mockRun({ name: [{ full_name: "Ada Lovelace" }] });
    try {
      await run({ findsPerson: true });
      const note = transcript(mock.calls);
      expect(note?.parent).toBe("people");
      expect(note?.title).toBe("run logs for automated integration (Instantly marked as interested)");
    } finally {
      mock.restore();
    }
  });

  test("reports a person Attio already held, and the state it held", async () => {
    const mock = mockRun({ name: [{ full_name: "Ada Lovelace" }] });
    try {
      await run({ findsPerson: true });
      const content = transcript(mock.calls)?.content ?? "";
      expect(content).toContain("Record did exist before run.");
      const previous = content.slice(content.indexOf("**Previous state**"), content.indexOf("**Run logs**"));
      expect(previous).toContain("name: Ada Lovelace");
    } finally {
      mock.restore();
    }
  });

  test("reports no previous state for a person the run created", async () => {
    const mock = mockRun(null);
    try {
      await run({ findsPerson: false });
      const content = transcript(mock.calls)?.content ?? "";
      expect(content).toContain("Record did not exist before run.");
      expect(content.slice(content.indexOf("**Previous state**"), content.indexOf("**Run logs**"))).toContain("none");
    } finally {
      mock.restore();
    }
  });

  test("reads the person back afterwards and renders every attribute type it holds", async () => {
    const mock = mockRun({ name: [{ full_name: "Ada Lovelace" }] });
    try {
      await run({ findsPerson: true });
      const content = transcript(mock.calls)?.content ?? "";
      const after = content.slice(content.indexOf("**State after run**"));
      expect(after).toContain("name: Ada Lovelace");
      expect(after).toContain("email addresses: ada@example.com");
      expect(after).toContain("phone numbers: +15555550123");
      expect(after).toContain("job title: Engineer");
      expect(after).toContain("lead source: Instantly Cold Outreach - Automated");
      //The run's own company, so the reference reads as a name rather than the record id it is stored as.
      expect(after).toContain("company: Engines Ltd");
      //Attributes holding nothing are omitted, so what changed is not buried.
      expect(after).not.toContain("linkedin");
    } finally {
      mock.restore();
    }
  });

  test("carries the run's own log lines, which nothing had to be instrumented to produce", async () => {
    const mock = mockRun({ name: [{ full_name: "Ada Lovelace" }] });
    try {
      await run({ findsPerson: true });
      const content = transcript(mock.calls)?.content ?? "";
      const logs = content.slice(content.indexOf("**Run logs**"), content.indexOf("**State after run**"));
      //Printed by lib/attio.ts and lib/interested.ts respectively - neither knows this feature exists.
      expect(logs).toContain('[action] note added to deals deal-1 ("Instantly Cold Outreach")');
      expect(logs).toContain("[interested] run-log test: completed");
      //Timestamped, so the transcript reads as a sequence rather than a heap.
      expect(logs).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}] \[action]/);
    } finally {
      mock.restore();
    }
  });

  test("still posts the transcript when the run fails partway", async () => {
    const mock = mockRun({ name: [{ full_name: "Ada Lovelace" }] });
    try {
      //A throw after the person is resolved: the run is lost, but its transcript is exactly what is wanted.
      await expect(
        run({ findsPerson: true, history: async () => { throw new Error("the thread could not be fetched"); } }),
      ).rejects.toThrow("the thread could not be fetched");
      expect(transcript(mock.calls)?.parent).toBe("people");
    } finally {
      mock.restore();
    }
  });

  test("a failure posting the transcript does not fail the run", async () => {
    const mock = installFetchMock((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: { name: [{ full_name: "Ada" }] } }] });
      }
      if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
      if (url.includes("objects/people/records")) return jsonResponse({ data: PERSON_AFTER });
      if (url.includes("objects/companies/records")) {
        return jsonResponse({ data: { id: { record_id: "company-1" }, values: {} } });
      }
      if (url.includes("objects/deals/records")) return jsonResponse({ data: { id: { record_id: "deal-1" }, values: {} } });
      //Every note is refused, the transcript's included.
      if (url.includes("/notes")) return jsonResponse({ error: "nope" }, 500);
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
      if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
      if (url.includes("api.heyreach.io")) return jsonResponse({ items: [], hasNextPage: false });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      //The history note raises first, so the run fails on its own account - what matters is that the
      //transcript's own 500 is not what surfaces, and does not replace it.
      await expect(run({ findsPerson: true })).rejects.not.toThrow("run logs");
    } finally {
      mock.restore();
    }
  });

  test("collects nothing outside a run, so the touchpoint crons are untouched", async () => {
    //lib/attio.ts is equally the crons' code. Their prints happen with no scope open and must go nowhere.
    console.log("[event] a touchpoint print, outside any interested run");
    expect(runLogArtifact(null)).toBeNull();
  });

  test("keeps overlapping runs' lines apart, as the Aircall sync's several leads per invocation are", async () => {
    //Two scopes open at once, interleaved across an await, each seeing only its own prints.
    const [first, second] = await Promise.all([
      withRunLog("aircall", async () => {
        console.log("belongs to the first run");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return runLogArtifact(null)?.body ?? "";
      }),
      withRunLog("heyreach", async () => {
        console.log("belongs to the second run");
        return runLogArtifact(null)?.body ?? "";
      }),
    ]);
    expect(first).toContain("belongs to the first run");
    expect(first).not.toContain("belongs to the second run");
    expect(second).toContain("belongs to the second run");
    expect(second).not.toContain("belongs to the first run");
  });

  test("restores the console it replaced, including one a caller had already swapped", async () => {
    const swapped = (): void => {};
    const original = console.log;
    console.log = swapped;
    try {
      await withRunLog("instantly", async () => undefined);
      expect(console.log).toBe(swapped);
    } finally {
      console.log = original;
    }
  });
});
