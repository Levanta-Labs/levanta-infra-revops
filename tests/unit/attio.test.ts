import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addPersonToList,
  createNote,
  findPersonByEmail,
  incrementCounter,
  isPersonInList,
  parseAttioPerson,
  patchRecord,
} from "../../lib/attio.js";
import { installFetchMock, jsonResponse } from "./test-utils.js";

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
  rawValues: person.values,
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

describe("writing attributes", () => {
  test("skips the Attio write entirely when there is nothing to write", async () => {
    const mock = installFetchMock(() => jsonResponse({ data: {} }));
    try {
      await patchRecord("people", "person-1", {});
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
        ? jsonResponse({ data: { id: { record_id: "record-1" }, values: { number_of_calls: [{ value: 2 }] } } })
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

  test("retries a 429 and succeeds, rather than losing the write", async () => {
    //The failure that prompted this: Attio 429s on "query complexity" during a busy sync run. The cron logs a
    //failed touchpoint, passes the call over and advances its cursor anyway, so an unretried 429 lost that
    //call's counter and note permanently. A refused request was never processed, so repeating it is safe.
    let attempts = 0;
    const mock = installFetchMock(() => {
      attempts += 1;
      if (attempts < 3) {
        return jsonResponse(
          { status_code: 429, type: "rate_limit_error", message: "Query complexity rate limit exceeded." },
          429,
        );
      }
      return jsonResponse({ data: [person] });
    });
    try {
      const found = await findPersonByEmail("ada@example.com");
      expect(found?.id.record_id).toBe("person-1");
      expect(attempts).toBe(3);
    } finally {
      mock.restore();
    }
  });

  test("honours Retry-After over its own backoff", async () => {
    //Attio knows when its window resets; the exponential backoff is only a guess. A 20ms header must be obeyed
    //rather than the 500ms first backoff, which is also what keeps this test fast.
    let attempts = 0;
    const started = Date.now();
    const mock = installFetchMock(() => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ message: "slow down" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0.02" },
        });
      }
      return jsonResponse({ data: [person] });
    });
    try {
      await findPersonByEmail("ada@example.com");
      expect(attempts).toBe(2);
      //Comfortably under the 500ms it would have waited had the header been ignored.
      expect(Date.now() - started).toBeLessThan(400);
    } finally {
      mock.restore();
    }
  });

  test("gives up on a 429 after the attempt limit and raises it", async () => {
    //Bounded, because the sync's run budget is finite and a permanently throttled account must surface rather
    //than absorb the whole budget in sleeps.
    let attempts = 0;
    const mock = installFetchMock(() => {
      attempts += 1;
      return new Response(JSON.stringify({ message: "nope" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    });
    try {
      await expect(findPersonByEmail("ada@example.com")).rejects.toThrow("Attio API error 429");
      expect(attempts).toBe(4);
    } finally {
      mock.restore();
    }
  });

  test("does not retry a 500 on a write, because Attio may have applied it", async () => {
    //A 5xx is ambiguous - the change may have landed before the response failed. Retrying POST /notes would
    //duplicate the note, and Attio has no idempotency key to prevent it. One attempt only.
    let attempts = 0;
    const mock = installFetchMock(() => {
      attempts += 1;
      return jsonResponse({ error: "upstream" }, 500);
    });
    try {
      await expect(createNote("people", "person-1", "Title", "Body")).rejects.toThrow("Attio API error 500");
      expect(attempts).toBe(1);
    } finally {
      mock.restore();
    }
  });

  test("does retry a 500 on a read, where there is nothing to apply twice", async () => {
    //isPersonInList is a plain GET, so a 5xx cannot have applied anything and a retry costs only the wait.
    let attempts = 0;
    const mock = installFetchMock(() => {
      attempts += 1;
      if (attempts < 2) return jsonResponse({ error: "upstream" }, 500);
      return jsonResponse({ data: [{ list_api_slug: "master_tam_list" }] });
    });
    try {
      expect(await isPersonInList("person-1", "master_tam_list")).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      mock.restore();
    }
  });
});
