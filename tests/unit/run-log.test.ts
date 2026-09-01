import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findPersonByEmail } from "../../lib/attio.js";
import { interestedLead, recordInterestedLead } from "../../lib/interested.js";
import { runLogArtifacts, runLogRecord, withRunLog } from "../../lib/run-log.js";
import { installFetchMock, jsonResponse, type FetchCall } from "./test-utils.js";

//=============================================================================================================
//The run transcript (lib/run-log.ts). Additive diagnostics, so what is asserted here is that it reports the
//run faithfully AND that it cannot damage one: outside a scope it is inert, inside one every way it can fail
//is swallowed, and it costs no Attio read of its own.
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

//Attio as it stands before the run: a person, a company, and a deal that all already exist. The deal is the
//interesting one - it is mid-pipeline, which is the case the transcript exists to make legible.
const PERSON_BEFORE = {
  name: [{ first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace" }],
  email_addresses: [{ email_address: "ada@example.com" }],
  company: [{ target_record_id: "company-1" }],
  associated_deals: [{ target_record_id: "deal-1" }],
  lead_source: [{ option: { title: "HeyReach Cold Outreach - Automated" } }],
  job_title: [],
};
const COMPANY_BEFORE = { name: [{ value: "Engines Ltd" }], domains: [{ domain: "engines.example" }] };
const DEAL_BEFORE = {
  name: [{ value: "Engines Ltd - Interested" }],
  stage: [{ status: { title: "Negotiation" } }],
  lead_source: [{ option: { title: "HeyReach Cold Outreach - Automated" } }],
  moved_to_interested_at: [{ value: "2026-06-14T09:31:00.000Z" }],
};

//---------------------------------------------------------------------------------------------------------
//Every call one interested run makes. `person` null is the lead Attio has never seen, and `linkedCompany`
//false the lead with no company to resolve - the two branches that change what the transcript reports.
//---------------------------------------------------------------------------------------------------------
function mockRun(options: { person?: Record<string, unknown> | null; linkedCompany?: boolean } = {}) {
  const person = options.person === undefined ? PERSON_BEFORE : options.person;
  const linkedCompany = options.linkedCompany ?? true;
  return installFetchMock((url, init) => {
    const method = init?.method ?? "GET";
    if (url.includes("objects/people/records/query")) {
      return jsonResponse({ data: person ? [{ id: { record_id: "person-1" }, values: person }] : [] });
    }
    if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
    if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
    if (url.includes("objects/companies/records/company-1")) {
      return jsonResponse({ data: { id: { record_id: "company-1" }, values: COMPANY_BEFORE } });
    }
    if (url.includes("objects/deals/records/deal-1")) {
      return jsonResponse({ data: { id: { record_id: "deal-1" }, values: DEAL_BEFORE } });
    }
    if (url.includes("objects/people/records")) {
      return jsonResponse({ data: { id: { record_id: "person-1" }, values: person ?? {} } });
    }
    if (url.includes("objects/companies/records")) {
      return jsonResponse({
        data: { id: { record_id: linkedCompany ? "company-1" : "company-2" }, values: { name: [{ value: "Engines Ltd" }] } },
      });
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

function run(options: { companyName?: string | null; history?: () => Promise<string> } = {}) {
  return recordInterestedLead({
    lead: interestedLead("instantly", {
      emails: ["ada@example.com"],
      phones: ["+15125550134"],
      firstName: "Ada",
      lastName: "Lovelace",
      jobTitle: "Head of Engineering",
      companyName: options.companyName === undefined ? "Engines Ltd" : options.companyName,
      campaignName: "Q3 Outbound",
      occurredAtMs: Date.UTC(2026, 8, 1),
    }),
    subject: "run-log test",
    findPerson: () => findPersonByEmail("ada@example.com"),
    history: options.history ?? (async () => "the thread"),
  });
}

interface Transcript {
  readonly parent: string;
  readonly recordId: string;
  readonly title: string;
  readonly content: string;
}

/** Every note titled "run logs ...", which is the transcript and nothing else. */
function transcripts(calls: readonly FetchCall[]): readonly Transcript[] {
  const found: Transcript[] = [];
  for (const call of calls) {
    if (!call.input.includes("/notes")) continue;
    const body = JSON.parse(String(call.init?.body)) as {
      data: { title: string; content: string; parent_object: string; parent_record_id: string };
    };
    if (!body.data.title.startsWith("run logs")) continue;
    found.push({
      parent: body.data.parent_object,
      recordId: body.data.parent_record_id,
      title: body.data.title,
      content: body.data.content,
    });
  }
  return found;
}

function section(content: string, heading: string, next: string | null): string {
  const start = content.indexOf(heading);
  return content.slice(start, next ? content.indexOf(next) : undefined);
}

const previousState = (content: string) => section(content, "**Previous state**", "**Run logs**");
const runLogs = (content: string) => section(content, "**Run logs**", "**State after run**");
const afterState = (content: string) => section(content, "**State after run**", null);

/** A record stub, for the scope tests that have no workflow to run. */
const STUB = { id: { record_id: "stub-1" }, rawValues: {}, populatedAttributes: new Set<string>() };

describe("run transcript", () => {
  test("posts one note per record touched, titled for the platform that reported the interest", async () => {
    const mock = mockRun();
    try {
      await run();
      const notes = transcripts(mock.calls);
      expect(notes.map((note) => note.parent)).toEqual(["people", "companies", "deals"]);
      expect(notes.map((note) => note.recordId)).toEqual(["person-1", "company-1", "deal-1"]);
      for (const note of notes) {
        expect(note.title).toBe("run logs for automated integration (Instantly marked as interested)");
      }
    } finally {
      mock.restore();
    }
  });

  test("carries one run log, identical on all three, which nothing had to be instrumented to produce", async () => {
    const mock = mockRun();
    try {
      await run();
      const notes = transcripts(mock.calls);
      const logs = notes.map((note) => runLogs(note.content));
      //Printed by lib/attio.ts and lib/interested.ts respectively - neither knows this feature exists.
      expect(logs[0]).toContain('[action] note added to deals deal-1 ("Instantly Cold Outreach")');
      expect(logs[0]).toContain("[interested] run-log test: completed");
      expect(logs[0]).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}] \[action]/);
      //One run, so one account of it. Rendering per note would let each pick up the note written before it.
      expect(logs[1]).toBe(logs[0] ?? "");
      expect(logs[2]).toBe(logs[0] ?? "");
    } finally {
      mock.restore();
    }
  });

  test("derives the state after the run instead of reading any record back", async () => {
    const mock = mockRun();
    try {
      await run();
      const reads = mock.calls.filter(
        (call) => (call.init?.method ?? "GET") === "GET" && call.input.includes("objects/"),
      );
      //Exactly the two the workflow already made for its own purposes - the linked company and the reused
      //deal. The person came from the lookup query, and nothing is read back afterwards.
      expect(reads.map((call) => call.input.split("/records/")[1])).toEqual(["company-1", "deal-1"]);

      const person = transcripts(mock.calls)[0]?.content ?? "";
      //Written this run, and reported without a read to confirm it.
      expect(afterState(person)).toContain("job title: Head of Engineering");
      expect(afterState(person)).toContain("campaign name: Q3 Outbound");
      //Labelled for what it is: what the run left, not a reading of Attio.
      expect(person).toContain("**State after run** (as this run left it)");
    } finally {
      mock.restore();
    }
  });

  test("reports what each record held before, from its own record and not the person's", async () => {
    const mock = mockRun();
    try {
      await run();
      const [person, company, deal] = transcripts(mock.calls);
      expect(previousState(person?.content ?? "")).toContain("email addresses: ada@example.com");
      expect(previousState(company?.content ?? "")).toContain("domains: engines.example");
      expect(previousState(deal?.content ?? "")).toContain("stage: Negotiation");
      //Each reports itself, so no record's note carries another's attributes.
      expect(previousState(company?.content ?? "")).not.toContain("email addresses");
      for (const note of [person, company, deal]) {
        expect(note?.content).toContain("Record did exist before run.");
      }
    } finally {
      mock.restore();
    }
  });

  test("shows a reused deal keeping its stage and date while its lead source is restated", async () => {
    //The asymmetry the transcript exists to surface: an interested event on a deal already in the pipeline
    //moves the source to this run's channel but leaves the stage and the original interested date alone.
    const mock = mockRun();
    try {
      await run();
      const deal = transcripts(mock.calls)[2]?.content ?? "";
      expect(previousState(deal)).toContain("lead source: HeyReach Cold Outreach - Automated");
      expect(afterState(deal)).toContain("lead source: Instantly Cold Outreach - Automated");
      expect(afterState(deal)).toContain("stage: Negotiation");
      expect(afterState(deal)).toContain("moved to interested at: 2026-06-14T09:31:00.000Z");
    } finally {
      mock.restore();
    }
  });

  test("reports no previous state for records the run created", async () => {
    const mock = mockRun({ person: null });
    try {
      await run();
      const [person, , deal] = transcripts(mock.calls);
      expect(person?.content).toContain("Record did not exist before run.");
      expect(previousState(person?.content ?? "")).toContain("none");
      //A person Attio has never seen has no associated deal either, so one is opened for them.
      expect(deal?.content).toContain("Record did not exist before run.");
    } finally {
      mock.restore();
    }
  });

  test("writes no company note when no company could be resolved", async () => {
    //The cold Aircall case: nothing to look a company up by and nothing to create one from.
    const mock = mockRun({ person: { name: [{ full_name: "Ada Lovelace" }] } });
    try {
      await run({ companyName: null });
      expect(transcripts(mock.calls).map((note) => note.parent)).toEqual(["people", "deals"]);
    } finally {
      mock.restore();
    }
  });

  test("still posts the transcript when the run fails partway", async () => {
    const mock = mockRun();
    try {
      await expect(
        run({ history: async () => { throw new Error("the thread could not be fetched"); } }),
      ).rejects.toThrow("the thread could not be fetched");
      //The person and the deal were both resolved before the throw, so both are owed their transcript.
      expect(transcripts(mock.calls).map((note) => note.parent)).toEqual(["people", "companies", "deals"]);
    } finally {
      mock.restore();
    }
  });

  test("a failure posting one transcript costs neither the others nor the run", async () => {
    let notes = 0;
    const mock = installFetchMock((url, init) => {
      const method = init?.method ?? "GET";
      if (url.includes("objects/people/records/query")) {
        return jsonResponse({ data: [{ id: { record_id: "person-1" }, values: PERSON_BEFORE }] });
      }
      if (url.includes("objects/companies/records/query")) return jsonResponse({ data: [] });
      if (url.includes("objects/") && method === "PATCH") return jsonResponse({ data: {} });
      if (url.includes("objects/companies/records/company-1")) {
        return jsonResponse({ data: { id: { record_id: "company-1" }, values: COMPANY_BEFORE } });
      }
      if (url.includes("objects/deals/records/deal-1")) {
        return jsonResponse({ data: { id: { record_id: "deal-1" }, values: DEAL_BEFORE } });
      }
      if (url.includes("/notes")) {
        notes += 1;
        //The history notes pass; the person's transcript is refused and the rest must still be attempted.
        return notes === 3 ? jsonResponse({ error: "nope" }, 500) : jsonResponse({ data: {} });
      }
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
      if (url.includes("api.instantly.ai")) return jsonResponse({ items: [], next_starting_after: null });
      if (url.includes("api.heyreach.io")) return jsonResponse({ items: [], hasNextPage: false });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      await run();
      expect(transcripts(mock.calls).map((note) => note.parent)).toEqual(["people", "companies", "deals"]);
    } finally {
      mock.restore();
    }
  });

  test("collects nothing outside a run, so the touchpoint crons are untouched", async () => {
    //lib/attio.ts is equally the crons' code. Their prints happen with no scope open and must go nowhere.
    console.log("[event] a touchpoint print, outside any interested run");
    expect(runLogArtifacts()).toEqual([]);
  });

  test("keeps overlapping runs' lines apart, as the Aircall sync's several leads per invocation are", async () => {
    //Two scopes open at once, interleaved across an await, each seeing only its own prints.
    const [first, second] = await Promise.all([
      withRunLog("aircall", async () => {
        runLogRecord("people", STUB, true, "First");
        console.log("belongs to the first run");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return runLogArtifacts()[0]?.body ?? "";
      }),
      withRunLog("heyreach", async () => {
        runLogRecord("people", STUB, true, "Second");
        console.log("belongs to the second run");
        return runLogArtifacts()[0]?.body ?? "";
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
