import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addPersonToList,
  blankPersonValues,
  createNote,
  findPersonByEmail,
  incrementCounter,
  parseAttioPerson,
  patchPerson,
} from "../../lib/attio.ts";
import { installFetchMock, jsonResponse } from "./test-utils.ts";

const originalKey = process.env.ATTIO_API_KEY;

const person = {
  id: { record_id: "person-1" },
  values: {
    associated_deals: [{ target_record_id: "deal-1", target_object: "deals" }],
    company: [{ target_record_id: "company-1", target_object: "companies" }],
    name: [{ full_name: "Ada Lovelace" }],
  },
};

const parsedPerson = {
  ...person,
  populatedAttributes: new Set(["associated_deals", "company", "name"]),
};

beforeEach(() => { process.env.ATTIO_API_KEY = "attio-test"; });
afterEach(() => {
  if (originalKey === undefined) delete process.env.ATTIO_API_KEY;
  else process.env.ATTIO_API_KEY = originalKey;
});

describe("Attio record parsing", () => {
  test("returns the explicitly typed person fields", () => {
    expect(parseAttioPerson(person)).toEqual(parsedPerson);
  });

  test("rejects records without a record ID", () => {
    expect(() => parseAttioPerson({ values: {} })).toThrow("missing id or values");
  });

  test("treats empty attribute arrays as unpopulated", () => {
    const parsed = parseAttioPerson({
      id: { record_id: "person-2" },
      values: { email_addresses: [], name: [{ full_name: "Ada" }] },
    });
    expect(parsed.populatedAttributes.has("name")).toBe(true);
    expect(parsed.populatedAttributes.has("email_addresses")).toBe(false);
  });
});

describe("filling only blank person attributes", () => {
  const existing = parseAttioPerson({
    id: { record_id: "person-1" },
    values: {
      name: [{ full_name: "Ada Lovelace" }],
      email_addresses: [],
      lead_source: [{ value: "Instantly Cold Outreach" }],
    },
  });

  test("fills a blank attribute from the third party", () => {
    expect(
      blankPersonValues(existing, { email_addresses: ["ada@example.com"] }),
    ).toEqual({ email_addresses: ["ada@example.com"] });
  });

  test("never overwrites an attribute Attio already holds", () => {
    expect(
      blankPersonValues(existing, {
        name: [{ first_name: "A", last_name: "L", full_name: "A. Lovelace" }],
        lead_source: "Aircall Cold Outreach",
      }),
    ).toEqual({});
  });

  test("fills blanks and preserves populated attributes in the same call", () => {
    expect(
      blankPersonValues(existing, {
        email_addresses: ["ada@example.com"],
        linkedin: "https://linkedin.com/in/ada",
        name: [{ first_name: "A", last_name: "L", full_name: "A. Lovelace" }],
        lead_source: "Aircall Cold Outreach",
      }),
    ).toEqual({
      email_addresses: ["ada@example.com"],
      linkedin: "https://linkedin.com/in/ada",
    });
  });

  test("skips the Attio write entirely when nothing is blank", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await patchPerson("person-1", {});
      expect(mock.calls).toHaveLength(0);
    } finally {
      mock.restore();
    }
  });
});

describe("Attio API helpers", () => {
  test("uses an exact shorthand email filter", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: [person] }));
    try {
      expect(await findPersonByEmail("ada@example.com")).toEqual(parsedPerson);
      expect(JSON.parse(String(mock.calls[0]?.init?.body))).toEqual({
        filter: { email_addresses: "ada@example.com" },
        limit: 1,
      });
    } finally {
      mock.restore();
    }
  });

  test("creates markdown notes with Attio's required format", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await createNote("people", "person-1", "Title", "**Body**");
      expect(JSON.parse(String(mock.calls[0]?.init?.body)).data).toMatchObject({ format: "markdown" });
    } finally {
      mock.restore();
    }
  });

  test("idempotently upserts list membership", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await addPersonToList("person-1", "dnc");
      expect(mock.calls[0]?.init?.method).toBe("PUT");
      expect(JSON.parse(String(mock.calls[0]?.init?.body)).data).toMatchObject({ entry_values: {} });
    } finally {
      mock.restore();
    }
  });

  test("reads and increments numeric counters", async () => {
    const mock = installFetchMock((_url, _init, index) =>
      index === 0
        ? jsonResponse({ data: { values: { number_of_calls: [{ value: 2 }] } } })
        : jsonResponse({ data: {} }),
    );
    try {
      await incrementCounter("people", "person-1", "number_of_calls");
      expect(JSON.parse(String(mock.calls[1]?.init?.body))).toEqual({
        data: { values: { number_of_calls: 3 } },
      });
    } finally {
      mock.restore();
    }
  });
});
