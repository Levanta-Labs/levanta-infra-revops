import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseAttioRecord } from "../../lib/attio.js";
import {
  companyValuesFor,
  dealValuesFor,
  interestedDealName,
  interestedLead,
  parsePostalAddress,
  personValuesFor,
  suppressInterestedLead,
  toArrBucket,
  toDate,
  toDomain,
  toEmployeeRange,
  updateAttioAttributes,
} from "../../lib/interested.js";
import { automatedSourceLabel, leadSourceLabel } from "../../lib/providers.js";
import { installFetchMock, jsonResponse, type FetchCall } from "./test-utils.js";

const envNames = ["ATTIO_API_KEY", "INSTANTLY_API_KEY", "HEYREACH_API_KEY"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.ATTIO_API_KEY = "attio-key";
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

/** A record as Attio returns it, so populated and blank attributes are distinguished the same way. */
function record(values: Record<string, unknown>) {
  return parseAttioRecord({ id: { record_id: "record-1" }, values });
}

function patchBody(calls: readonly FetchCall[]): Record<string, unknown> {
  const patch = calls.find((call) => call.init?.method === "PATCH");
  if (!patch) throw new Error("no PATCH was made");
  return JSON.parse(String(patch.init?.body)).data.values;
}

describe("provider labels", () => {
  //These strings are written into Attio, so they are pinned: changing one changes what new records say.
  test("derives Lead Source and Deal Source from the provider", () => {
    expect(leadSourceLabel("aircall")).toBe("Aircall Cold Outreach");
    expect(leadSourceLabel("instantly")).toBe("Instantly Cold Outreach");
    expect(leadSourceLabel("heyreach")).toBe("HeyReach Cold Outreach");
    expect(automatedSourceLabel("aircall")).toBe("Aircall Cold Outreach - Automated");
    expect(automatedSourceLabel("instantly")).toBe("Instantly Cold Outreach - Automated");
    expect(automatedSourceLabel("heyreach")).toBe("HeyReach Cold Outreach - Automated");
  });
});

describe("transforms", () => {
  test("buckets a headcount at each option boundary", () => {
    expect(toEmployeeRange("1")).toBe("1-10");
    expect(toEmployeeRange("10")).toBe("1-10");
    expect(toEmployeeRange("11")).toBe("11-50");
    expect(toEmployeeRange("84")).toBe("51-250");
    expect(toEmployeeRange("250")).toBe("51-250");
    expect(toEmployeeRange("251")).toBe("251-1K");
    expect(toEmployeeRange("1,200")).toBe("1K-5K");
    expect(toEmployeeRange("250000")).toBe("100K+");
  });

  test("buckets a revenue figure at each option boundary", () => {
    expect(toArrBucket("4318000")).toBe("$1M-$10M");
    expect(toArrBucket("999999")).toBe("$0-$1M");
    expect(toArrBucket("1000000")).toBe("$1M-$10M");
    expect(toArrBucket("15959000")).toBe("$10M-$50M");
    expect(toArrBucket("50000000")).toBe("$50M-$100M");
    expect(toArrBucket("20000000000")).toBe("$10B+");
  });

  test("declines a headcount or revenue it cannot read", () => {
    expect(toEmployeeRange(null)).toBeNull();
    expect(toEmployeeRange("unknown")).toBeNull();
    expect(toEmployeeRange("0")).toBeNull();
    expect(toArrBucket("")).toBeNull();
  });

  test("reduces a website to a bare domain", () => {
    expect(toDomain("https://www.acme.com/about?x=1")).toBe("acme.com");
    expect(toDomain("acme.com")).toBe("acme.com");
    expect(toDomain("HTTP://Acme.COM")).toBe("acme.com");
    expect(toDomain("acme.com:8080")).toBe("acme.com");
  });

  //Domains is UNIQUE in Attio, so a wrong value takes a slot no other company can claim. Anything doubtful
  //must return null rather than be written.
  test("declines anything that is not a domain", () => {
    expect(toDomain(null)).toBeNull();
    expect(toDomain("")).toBeNull();
    expect(toDomain("Acme Corporation")).toBeNull();
    expect(toDomain("localhost")).toBeNull();
  });

  test("parses a full postal address into Attio's structured location", () => {
    expect(parsePostalAddress("1340 Martine Ave, Scotch Plains, New Jersey, United States, 07076")).toEqual({
      line_1: "1340 Martine Ave",
      line_2: null,
      line_3: null,
      line_4: null,
      locality: "Scotch Plains",
      region: "New Jersey",
      postcode: "07076",
      country_code: "US",
      latitude: null,
      longitude: null,
    });
  });

  test("parses an address with no postcode", () => {
    //Read from the right, so with no street line the city and region still land correctly.
    expect(parsePostalAddress("Toronto, Ontario, Canada")).toMatchObject({
      line_1: null,
      locality: "Toronto",
      region: "Ontario",
      postcode: null,
      country_code: "CA",
    });
  });

  //A guessed country would place the company on the wrong continent in every filter, so no country means no
  //location at all rather than a partial one.
  test("declines an address whose country it cannot resolve", () => {
    expect(parsePostalAddress("1 Main St, Springfield, Nowhereland, 12345")).toBeNull();
    expect(parsePostalAddress("just a city")).toBeNull();
    expect(parsePostalAddress(null)).toBeNull();
  });

  test("renders a date attribute without a time", () => {
    expect(toDate(Date.parse("2026-08-28T17:04:05Z"))).toBe("2026-08-28");
    expect(toDate(null)).toBeNull();
  });
});

describe("values a provider might spell awkwardly", () => {
  //Reading "4.3M" as the digits 43 would be wrong by six orders of magnitude - silently, and permanently,
  //because nothing downstream overwrites what these workflows write.
  test("reads a magnitude suffix rather than its digits", () => {
    expect(toArrBucket("$4.3M")).toBe("$1M-$10M");
    expect(toArrBucket("4.3M")).toBe("$1M-$10M");
    expect(toArrBucket("1.2B")).toBe("$1B-$10B");
    expect(toEmployeeRange("1.5K")).toBe("1K-5K");
  });

  //A range states two numbers; the lower bound is one the provider actually gave, not one derived from it.
  test("takes the lower bound of a range", () => {
    expect(toEmployeeRange("50-100")).toBe("11-50");
    expect(toEmployeeRange("1K-5K")).toBe("251-1K");
  });

  test("still reads the plain forms", () => {
    expect(toEmployeeRange("84 employees")).toBe("51-250");
    expect(toArrBucket("$10,500,000")).toBe("$10M-$50M");
  });

  //Domains is UNIQUE in Attio: the first company to claim "linkedin.com" takes the slot, and every company
  //after it fails. A provider putting a social page where a website belongs must not be able to cause that.
  test("refuses a social, code, or mailbox host as a company domain", () => {
    expect(toDomain("https://linkedin.com/company/acme")).toBeNull();
    expect(toDomain("https://www.facebook.com/acme")).toBeNull();
    expect(toDomain("gmail.com")).toBeNull();
    expect(toDomain("acme.github.io")).toBe("acme.github.io");
    expect(toDomain("acme.co.uk")).toBe("acme.co.uk");
  });
});

describe("what a create sends to Attio", () => {
  //createPerson and createCompany send their values verbatim, with none of the filtering updateAttioAttributes
  //does. A null on a create is an instruction to Attio about an attribute rather than silence about it, so the
  //mappers must omit the keys the provider knows nothing about.
  test("omits every attribute the provider had no value for", () => {
    const thin = interestedLead("aircall", { phones: ["+15555550123"], occurredAtMs: 1756400000000 });
    expect(personValuesFor(thin)).toEqual({
      phone_numbers: ["+15555550123"],
      date_added: "2025-08-28",
      lead_source: "Aircall Cold Outreach - Automated",
    });
    expect(companyValuesFor(interestedLead("aircall", { companyName: "Acme" }))).toEqual({ name: "Acme" });
    expect(dealValuesFor(interestedLead("aircall", {}))).toEqual({
      lead_source: "Aircall Cold Outreach - Automated",
    });
  });
});

describe("updating Attio attributes", () => {
  const lead = interestedLead("instantly", {
    emails: ["ada@example.com"],
    firstName: "Ada",
    lastName: "Lovelace",
    jobTitle: "Countess",
  });

  test("fills a blank attribute from the third party", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await updateAttioAttributes("people", record({ job_title: [] }), { job_title: "Countess" });
      expect(patchBody(mock.calls)).toEqual({ job_title: "Countess" });
    } finally {
      mock.restore();
    }
  });

  test("never overwrites an attribute Attio already holds", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await updateAttioAttributes("people", record({ job_title: [{ value: "Analyst" }] }), {
        job_title: "Countess",
      });
      //Nothing was fillable, so no request is made at all.
      expect(mock.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("fills blanks and preserves populated attributes in the same call", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await updateAttioAttributes(
        "people",
        record({ description: [{ value: "Wrote the first program" }], job_title: [] }),
        { description: "Analyst", job_title: "Countess" },
      );
      expect(patchBody(mock.calls)).toEqual({ job_title: "Countess" });
    } finally {
      mock.restore();
    }
  });

  //The deliberate exception to the rule the two tests above pin. See ALWAYS_OVERWRITE (lib/interested.ts).
  test("restates lead source over what Attio already holds", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await updateAttioAttributes(
        "people",
        record({ lead_source: [{ value: "Aircall Cold Outreach" }], job_title: [{ value: "Analyst" }] }),
        { lead_source: "Instantly Cold Outreach", job_title: "Countess" },
      );
      //Lead source is replaced by this run's channel; the job title beside it is still left alone.
      expect(patchBody(mock.calls)).toEqual({ lead_source: "Instantly Cold Outreach" });
    } finally {
      mock.restore();
    }
  });

  test("drops candidates that are absent, blank, or empty", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await updateAttioAttributes("people", record({}), {
        job_title: null,
        description: "",
        email_addresses: [],
        location: undefined,
      });
      expect(mock.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  //A PATCH replaces a multiselect wholesale, so a second address has to be sent alongside the first.
  test("adds a new address to a multiselect without dropping the existing one", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await updateAttioAttributes(
        "people",
        record({ email_addresses: [{ email_address: "ada@example.com" }] }),
        { email_addresses: ["new@example.com"] },
      );
      expect(patchBody(mock.calls)).toEqual({
        email_addresses: ["ada@example.com", "new@example.com"],
      });
    } finally {
      mock.restore();
    }
  });

  test("does not rewrite a multiselect that would gain nothing", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await updateAttioAttributes(
        "people",
        record({ email_addresses: [{ email_address: "Ada@Example.com" }] }),
        //Same address in a different case. Adding it again would duplicate it.
        { email_addresses: ["ada@example.com"] },
      );
      expect(mock.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  //The dangerous case: if the existing entries cannot be read back in full, a replacing write would delete
  //real data. The attribute is declined outright instead.
  test("leaves a multiselect alone when its existing entries cannot be read back", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await updateAttioAttributes("people", record({ email_addresses: [{ unexpected_shape: true }] }), {
        email_addresses: ["new@example.com"],
      });
      expect(mock.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });

  test("reads the record first when handed only an id", async () => {
    const mock = installFetchMock((_url, init) => {
      if (init?.method === "PATCH") return jsonResponse({ data: {} });
      return jsonResponse({ data: { id: { record_id: "deal-1" }, values: { industry: [] } } });
    });
    try {
      await updateAttioAttributes("deals", "deal-1", { industry: "Health Care" });
      expect(mock.calls[0]?.init?.method ?? "GET").toBe("GET");
      expect(patchBody(mock.calls)).toEqual({ industry: "Health Care" });
    } finally {
      mock.restore();
    }
  });

  test("maps a lead onto person, company, and deal attributes", () => {
    const full = interestedLead("instantly", {
      emails: ["ada@example.com"],
      phones: ["+15555550123"],
      firstName: "Ada",
      lastName: "Lovelace",
      jobTitle: "Countess",
      linkedin: "https://linkedin.com/in/ada",
      companyName: "Engines Ltd",
      companyDomain: "engines.example",
      employeeCount: "84",
      annualRevenue: "4318000",
      industry: "hospital & health care",
      website: "https://engines.example",
      campaignName: "Q3 Founders",
      occurredAtMs: Date.parse("2026-08-28T17:04:05Z"),
    });

    expect(personValuesFor(full, "company-1")).toMatchObject({
      email_addresses: ["ada@example.com"],
      phone_numbers: ["+15555550123"],
      job_title: "Countess",
      linkedin: "https://linkedin.com/in/ada",
      campaign_name: "Q3 Founders",
      date_added: "2026-08-28",
      //The Person carries the same "- Automated" string as the Deal below.
      lead_source: "Instantly Cold Outreach - Automated",
      company: { target_object: "companies", target_record_id: "company-1" },
      name: [{ first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace" }],
    });

    expect(companyValuesFor(full)).toMatchObject({
      name: "Engines Ltd",
      domains: ["engines.example"],
      employee_range: "51-250",
      estimated_arr_usd: "$1M-$10M",
    });

    expect(dealValuesFor(full)).toMatchObject({
      lead_source: "Instantly Cold Outreach - Automated",
      campaign_name: "Q3 Founders",
      email: "ada@example.com",
      phone_number_7: "+15555550123",
      website: "https://engines.example",
      industry: "hospital & health care",
      employees: "84",
      revenue: "4318000",
      moved_to_interested_at: "2026-08-28T17:04:05.000Z",
    });
  });

  test("omits the company link when no company was resolved", () => {
    expect(personValuesFor(lead)).not.toHaveProperty("company");
  });
});

describe("salvaging a rejected attribute write", () => {
  const candidate = { job_title: "Countess", industry: "Health Care", location: "London" };
  const blank = { job_title: [], industry: [], location: [] };

  function patchedValues(calls: readonly FetchCall[]): readonly Record<string, unknown>[] {
    return calls
      .filter((call) => call.init?.method === "PATCH")
      .map((call) => JSON.parse(String(call.init?.body)).data.values);
  }

  //One bad value must cost only itself. The person, company, deal, and notes are already committed by the time
  //attributes are written, so losing all of them over one unacceptable value is the worse outcome.
  test("writes every attribute Attio will take and drops only the one it rejects", async () => {
    const mock = installFetchMock((_url, init) => {
      const values = init?.body ? JSON.parse(String(init.body)).data.values : {};
      const slugs = Object.keys(values);
      //The batch is rejected on its content, and thereafter only `industry` is.
      if (slugs.length > 1) return jsonResponse({ error: "invalid value" }, 400);
      if (slugs.includes("industry")) return jsonResponse({ error: "invalid value" }, 400);
      return jsonResponse({ data: {} });
    });
    try {
      const result = await updateAttioAttributes("people", record(blank), candidate);
      expect(result.written).toEqual(["job_title", "location"]);
      expect(result.dropped).toEqual(["industry"]);
      //The batch, then one attempt per attribute.
      expect(patchedValues(mock.calls)).toHaveLength(4);
    } finally {
      mock.restore();
    }
  });

  test("does not fail the event when every attribute is rejected", async () => {
    const mock = installFetchMock(() => jsonResponse({ error: "invalid value" }, 400));
    try {
      const result = await updateAttioAttributes("people", record(blank), candidate);
      expect(result.written).toEqual([]);
      expect(result.dropped).toEqual(["job_title", "industry", "location"]);
    } finally {
      mock.restore();
    }
  });

  //A 5xx or a 401 is not any one attribute's fault, so retrying each of them would fail identically.
  test("does not retry attribute by attribute when the failure is not about content", async () => {
    const mock = installFetchMock(() => jsonResponse({ error: "upstream" }, 500));
    try {
      const result = await updateAttioAttributes("people", record(blank), candidate);
      expect(result.dropped).toEqual(["job_title", "industry", "location"]);
      expect(patchedValues(mock.calls)).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("costs a single request when nothing is rejected", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      const result = await updateAttioAttributes("people", record(blank), candidate);
      expect(result.written).toEqual(["job_title", "industry", "location"]);
      expect(result.dropped).toEqual([]);
      expect(patchedValues(mock.calls)).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  //The read is the exception: without knowing what the record holds there is no way to write without risking
  //an overwrite, so a failed read still raises.
  test("still raises when the record cannot be read at all", async () => {
    const mock = installFetchMock(() => jsonResponse({ error: "gone" }, 404));
    try {
      await expect(updateAttioAttributes("deals", "deal-1", candidate)).rejects.toThrow();
    } finally {
      mock.restore();
    }
  });
});

describe("naming a new deal", () => {
  //Strict convention: nothing but the company name and the suffix, so these deals sort together.
  test("names a deal after its company", () => {
    expect(interestedDealName("Engines Ltd")).toBe("Engines Ltd - Interested");
  });

  test("names an unknown company when neither Attio nor the provider has one", () => {
    expect(interestedDealName(null)).toBe("Unknown Company - Interested");
    expect(interestedDealName("")).toBe("Unknown Company - Interested");
    expect(interestedDealName("   ")).toBe("Unknown Company - Interested");
  });
});

describe("suppressing an interested lead", () => {
  const targets = {
    personId: "person-1",
    personName: "Ada Lovelace",
    email: "ada@example.com",
    profileUrl: "https://www.linkedin.com/in/ada",
  };

  test("suppresses on every platform, not only the one that reported the interest", async () => {
    const mock = installFetchMock((url) => {
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("block-lists-entries")) return jsonResponse({ data: {} });
      if (url.includes("GetCampaignsForLead")) {
        return jsonResponse({ items: [{ campaignId: 7, campaignStatus: "IN_PROGRESS", leadStatus: "InSequence" }] });
      }
      if (url.includes("StopLeadInCampaign")) return jsonResponse({});
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const result = await suppressInterestedLead(targets);
      expect(result.failures).toEqual([]);
      expect(result.outcomes.map((outcome) => [outcome.platform, outcome.status])).toEqual([
        ["attio DNC list", "suppressed"],
        ["instantly blocklist", "suppressed"],
        ["heyreach campaigns", "suppressed"],
      ]);
    } finally {
      mock.restore();
    }
  });

  //Half the platforms suppressed beats one suppressed and the rest untouched because the first threw.
  test("carries on after a platform fails, and reports it", async () => {
    const mock = installFetchMock((url) => {
      if (url.includes("/lists/dnc/entries")) return jsonResponse({ data: {} });
      if (url.includes("block-lists-entries")) return jsonResponse({ error: "boom" }, 500);
      if (url.includes("GetCampaignsForLead")) return jsonResponse({ items: [] });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
      const result = await suppressInterestedLead(targets);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("instantly blocklist");
      //The Attio listing before it and the HeyReach stop after it both still ran.
      expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
        "suppressed",
        "failed",
        "suppressed",
      ]);
    } finally {
      mock.restore();
    }
  });

  //Not a failure: the lead is simply not present on that platform to suppress.
  test("skips a platform whose identifier the lead does not carry", async () => {
    //Only the Attio listing should be reached: with no address and no profile URL there is nothing to call.
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      const result = await suppressInterestedLead({ ...targets, email: null, profileUrl: null });
      expect(result.failures).toEqual([]);
      expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
        "suppressed",
        "skipped",
        "skipped",
      ]);
    } finally {
      mock.restore();
    }
  });
});
