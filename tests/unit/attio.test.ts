import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addPersonToList,
  createNote,
  findPersonByEmail,
  incrementCounter,
  parseAttioPerson,
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

beforeEach(() => { process.env.ATTIO_API_KEY = "attio-test"; });
afterEach(() => {
  if (originalKey === undefined) delete process.env.ATTIO_API_KEY;
  else process.env.ATTIO_API_KEY = originalKey;
});

describe("Attio record parsing", () => {
  test("returns the explicitly typed person fields", () => {
    expect(parseAttioPerson(person)).toEqual(person);
  });

  test("rejects records without a record ID", () => {
    expect(() => parseAttioPerson({ values: {} })).toThrow("missing id or values");
  });
});

describe("Attio API helpers", () => {
  test("uses an exact shorthand email filter", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: [person] }));
    try {
      expect(await findPersonByEmail("ada@example.com")).toEqual(person);
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
