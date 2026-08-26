import { describe, expect, test } from "bun:test";
import { parseHeyReachInterestedWebhook } from "../../api/heyreach-interested.js";
import { describeShape } from "../../lib/json.js";

const PROFILE = "https://www.linkedin.com/in/ada-lovelace";

describe("HeyReach interested payload shapes", () => {
  test("accepts the documented camelCase lead object", () => {
    const fields = parseHeyReachInterestedWebhook({
      lead: { profileUrl: PROFILE, firstName: "Ada", lastName: "Lovelace", companyName: "Engines" },
    });
    expect(fields).toEqual({
      profileUrl: PROFILE,
      email: null,
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: "Engines",
    });
  });

  test("accepts snake_case spellings of every field", () => {
    const fields = parseHeyReachInterestedWebhook({
      lead: {
        linkedin_url: PROFILE,
        email_address: "ada@example.com",
        first_name: "Ada",
        last_name: "Lovelace",
        company_name: "Engines",
      },
    });
    expect(fields).toEqual({
      profileUrl: PROFILE,
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: "Engines",
    });
  });

  test("finds the lead under any of the conventional containers", () => {
    for (const container of ["lead", "data", "body", "profile", "correspondentProfile"]) {
      const fields = parseHeyReachInterestedWebhook({ [container]: { profileUrl: PROFILE } });
      expect(fields.profileUrl).toBe(PROFILE);
    }
  });

  test("accepts a flat payload with no container at all", () => {
    expect(parseHeyReachInterestedWebhook({ linkedInUrl: PROFILE }).profileUrl).toBe(PROFILE);
  });

  test("takes an email alone when no profile URL is present", () => {
    const fields = parseHeyReachInterestedWebhook({ lead: { emailAddress: "ada@example.com" } });
    expect(fields.email).toBe("ada@example.com");
    expect(fields.profileUrl).toBeNull();
  });

  //=========================================================================================================
  //The safety property. A HeyReach body also carries the sending LinkedIn account. Matching on that URL would
  //attach the reply to the wrong Person, or invent a Person record for our own sender.
  //=========================================================================================================

  test("refuses a payload whose only URL belongs to the sending account", () => {
    expect(() =>
      parseHeyReachInterestedWebhook({
        event: "REPLY_RECEIVED",
        linkedInAccount: { profileUrl: "https://www.linkedin.com/in/our-own-sender", emailAddress: "us@ours.com" },
      }),
    ).toThrow("missing profileUrl and email");
  });

  test("does not reach into a nested account object inside the lead container", () => {
    expect(() =>
      parseHeyReachInterestedWebhook({
        lead: { linkedInAccount: { profileUrl: "https://www.linkedin.com/in/our-own-sender" } },
      }),
    ).toThrow("missing profileUrl and email");
  });

  test("reports the payload structure but none of its values", () => {
    const secretish = {
      event: "REPLY_RECEIVED",
      recipient: { fullName: "Ada Lovelace", contact: "ada@example.com", note: "call me on 555-0123" },
    };
    let message = "";
    try {
      parseHeyReachInterestedWebhook(secretish);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Key names, so the field can be mapped.
    expect(message).toContain("recipient");
    expect(message).toContain("fullName");
    // No values, so nobody's details land in a retained log.
    expect(message).not.toContain("Ada Lovelace");
    expect(message).not.toContain("ada@example.com");
    expect(message).not.toContain("555-0123");
  });

  test("rejects a payload that is not an object at all", () => {
    expect(() => parseHeyReachInterestedWebhook("a string")).toThrow("must be an object");
    expect(() => parseHeyReachInterestedWebhook(null)).toThrow("must be an object");
  });
});

describe("describeShape", () => {
  test("reports types and nesting without values", () => {
    expect(describeShape({ a: "x", b: 1, c: true, d: null })).toBe(
      "{ a: string, b: number, c: boolean, d: null }",
    );
  });

  test("summarises an array by its first element", () => {
    expect(describeShape({ items: [{ id: "x" }] })).toBe("{ items: [{ id: string }] }");
    expect(describeShape({ items: [] })).toBe("{ items: [] }");
  });

  test("stops descending at the depth limit instead of dumping the whole tree", () => {
    expect(describeShape({ a: { b: { c: { d: "deep" } } } })).toBe("{ a: { b: {1 key(s)} } }");
  });
});

describe("describeShape recursion safety", () => {
  test("terminates on a deeply nested array instead of exhausting the stack", () => {
    let nested: unknown = { id: "x" };
    for (let i = 0; i < 5000; i += 1) nested = [nested];
    expect(describeShape(nested)).toContain("...");
  });
});
