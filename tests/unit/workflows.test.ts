import { describe, expect, test } from "bun:test";
import {
  buildCallHistorySummary,
  extractAircallFields,
} from "../../api/aircall-interested.js";
import { aircallCursorEvent } from "../../api/cron/aircall-touchpoint-sync.js";
import { heyReachTouchpointEvents } from "../../api/cron/heyreach-touchpoint-sync.js";
import { instantlyCursorEvent } from "../../api/cron/instantly-touchpoint-sync.js";
import {
  formatHeyReachThread,
  parseHeyReachInterestedWebhook,
} from "../../api/heyreach-interested.js";
import {
  formatInstantlyThread,
  parseInstantlyInterestedWebhook,
} from "../../api/instantly-interested.js";
import { parseAircallCall } from "../../lib/aircall.js";
import { parseHeyReachConversation } from "../../lib/heyreach.js";
import { parseInstantlyEmail } from "../../lib/instantly.js";

describe("interested workflows", () => {
  test("extracts and formats an Aircall interaction deterministically", () => {
    const call = parseAircallCall({
      id: 1,
      status: "done",
      direction: "outbound",
      raw_digits: "+15555550123",
      started_at: 1_700_000_000,
      ended_at: 1_700_000_120,
      duration: 120,
      tags: [{ name: "Booked" }],
      contact: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
    });
    const fields = extractAircallFields(call, 1_700_000_121);
    expect(buildCallHistorySummary(fields)).toContain("Duration: 2 min");
    expect(buildCallHistorySummary(fields)).toContain("Tags: Booked");
  });

  test("parses the documented Instantly interested event", () => {
    const fields = parseInstantlyInterestedWebhook({
      event_type: "lead_interested",
      lead_email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      companyName: "Analytical Engines",
      campaign_name: "Outbound",
    });
    expect(fields).toMatchObject({ eventType: "lead_interested", email: "ada@example.com" });
  });

  test("formats Instantly email history in chronological order", () => {
    const newer = parseInstantlyEmail({
      id: "2",
      timestamp_created: "2026-08-19T12:00:00Z",
      timestamp_email: "2026-08-19T12:00:00Z",
      ue_type: 2,
      lead: "ada@example.com",
      subject: "Re: Hello",
      body: { text: "Reply" },
    });
    const older = parseInstantlyEmail({
      id: "1",
      timestamp_created: "2026-08-19T11:00:00Z",
      timestamp_email: "2026-08-19T11:00:00Z",
      ue_type: 1,
      lead: "ada@example.com",
      subject: "Hello",
      body: { text: "Opening" },
    });
    expect(formatInstantlyThread([newer, older], "Campaign").indexOf("Opening")).toBeLessThan(
      formatInstantlyThread([newer, older], "Campaign").indexOf("Reply"),
    );
  });

  test("accepts both top-level and nested HeyReach webhook payloads", () => {
    expect(parseHeyReachInterestedWebhook({ lead: { profileUrl: "https://linkedin.com/in/ada" } }).profileUrl)
      .toBe("https://linkedin.com/in/ada");
    expect(parseHeyReachInterestedWebhook({ linkedInUrl: "https://linkedin.com/in/grace" }).profileUrl)
      .toBe("https://linkedin.com/in/grace");
  });

  test("formats HeyReach history", () => {
    expect(formatHeyReachThread([
      { createdAt: "2026-08-19T12:00:00Z", body: "Hello", subject: null, sender: "ME" },
    ])).toContain("Hello");
  });
});

describe("sync event identities", () => {
  test("uses the source Aircall ID and completion timestamp", () => {
    const call = parseAircallCall({ id: 42, status: "done", started_at: 100, ended_at: 150 });
    expect(aircallCursorEvent(call)).toEqual({ id: "42", timestampMs: 150_000 });
  });

  test("uses Instantly's source email ID and creation timestamp", () => {
    const email = parseInstantlyEmail({
      id: "email-1",
      timestamp_created: "2026-08-19T12:00:00Z",
      timestamp_email: "2026-08-19T11:59:00Z",
      ue_type: 3,
      lead: "ada@example.com",
      body: {},
    });
    expect(instantlyCursorEvent(email)).toEqual({
      id: "email-1",
      timestampMs: Date.parse("2026-08-19T12:00:00Z"),
    });
  });

  test("creates deterministic HeyReach events for messages without source IDs", async () => {
    const conversation = parseHeyReachConversation({
      id: "conversation-1",
      linkedInAccountId: 1,
      lastMessageAt: "2026-08-19T12:00:00Z",
      correspondentProfile: { profileUrl: "https://linkedin.com/in/ada" },
      messages: [{ createdAt: "2026-08-19T12:00:00Z", body: "Hello", sender: "ME" }],
    });
    const events = await heyReachTouchpointEvents([conversation]);
    expect(events).toHaveLength(1);
    expect(events[0]?.cursor.id).toHaveLength(64);
  });
});
