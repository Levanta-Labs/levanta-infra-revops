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
  //The auto-tag events (lead auto tagged positive and its siblings) arrive flat, with the container name folded
  //into each key, which is the shape that was being rejected in production.
  //=========================================================================================================

  test("accepts a flat auto-tag payload whose keys carry a lead prefix", () => {
    const fields = parseHeyReachInterestedWebhook({
      eventType: "LEAD_AUTO_TAGGED_POSITIVE",
      campaignId: 12345,
      campaignName: "Q3 Founders",
      linkedInAccountId: 987,
      leadProfileUrl: PROFILE,
      leadEmailAddress: "ada@example.com",
      leadFirstName: "Ada",
      leadLastName: "Lovelace",
      leadCompanyName: "Engines",
    });
    expect(fields).toEqual({
      profileUrl: PROFILE,
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: "Engines",
    });
  });

  test("accepts lead-prefixed keys in snake_case too", () => {
    const fields = parseHeyReachInterestedWebhook({
      event_type: "LEAD_AUTO_TAGGED_POSITIVE",
      lead_profile_url: PROFILE,
      lead_first_name: "Ada",
    });
    expect(fields.profileUrl).toBe(PROFILE);
    expect(fields.firstName).toBe("Ada");
  });

  test("matches a key however it is cased or separated", () => {
    expect(parseHeyReachInterestedWebhook({ "Lead-Profile-URL": PROFILE }).profileUrl).toBe(PROFILE);
    expect(parseHeyReachInterestedWebhook({ lead: { LinkedInURL: PROFILE } }).profileUrl).toBe(PROFILE);
  });

  test("finds a lead container nested below the top level", () => {
    const fields = parseHeyReachInterestedWebhook({
      event: "LEAD_AUTO_TAGGED_POSITIVE",
      data: { campaign: { id: 1 }, lead: { profileUrl: PROFILE, firstName: "Ada" } },
    });
    expect(fields.profileUrl).toBe(PROFILE);
    expect(fields.firstName).toBe("Ada");
  });

  test("prefers the lead container over a sibling object that also looks like a person", () => {
    const fields = parseHeyReachInterestedWebhook({
      taggedBy: { profileUrl: "https://www.linkedin.com/in/a-teammate", firstName: "Someone" },
      lead: { profileUrl: PROFILE, firstName: "Ada" },
    });
    expect(fields.profileUrl).toBe(PROFILE);
    expect(fields.firstName).toBe("Ada");
  });

  test("takes every field from the object that identified the lead", () => {
    //A name lifted off one record and pinned to another would be worse than a missing name.
    const fields = parseHeyReachInterestedWebhook({
      lead: { profileUrl: PROFILE },
      otherPerson: { firstName: "Grace", lastName: "Hopper", companyName: "Navy" },
    });
    expect(fields.firstName).toBeNull();
    expect(fields.lastName).toBeNull();
    expect(fields.companyName).toBeNull();
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

  test("refuses flattened keys that belong to the sending account", () => {
    expect(() =>
      parseHeyReachInterestedWebhook({
        eventType: "LEAD_AUTO_TAGGED_POSITIVE",
        senderProfileUrl: "https://www.linkedin.com/in/our-own-sender",
        linkedInAccountEmailAddress: "us@ours.com",
      }),
    ).toThrow("missing profileUrl and email");
  });

  test("does not descend into the sending account however its container is spelled", () => {
    for (const container of ["linkedInAccount", "linked_in_account", "sender", "senderProfile", "mailbox"]) {
      expect(() =>
        parseHeyReachInterestedWebhook({
          event: "LEAD_AUTO_TAGGED_POSITIVE",
          [container]: { profileUrl: "https://www.linkedin.com/in/our-own-sender" },
        }),
      ).toThrow("missing profileUrl and email");
    }
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

  test("terminates on a self-referential payload instead of spinning", () => {
    const payload: Record<string, unknown> = { event: "LEAD_AUTO_TAGGED_POSITIVE" };
    payload.self = payload;
    payload.lead = { profileUrl: PROFILE, self: payload };
    expect(parseHeyReachInterestedWebhook(payload).profileUrl).toBe(PROFILE);
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
