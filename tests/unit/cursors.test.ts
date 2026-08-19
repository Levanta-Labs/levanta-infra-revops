import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  advanceCursor,
  advanceCursorTo,
  getSyncCursor,
  initialCursor,
  isAfterCursor,
  saveSyncCursor,
} from "../../lib/cursors.ts";
import { installFetchMock, jsonResponse } from "./test-utils.ts";

const originalUrl = process.env.SUPABASE_URL;
const originalSecret = process.env.SUPABASE_SECRET_KEY;

beforeEach(() => {
  process.env.SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
});

afterEach(() => {
  if (originalUrl === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = originalUrl;
  if (originalSecret === undefined) delete process.env.SUPABASE_SECRET_KEY;
  else process.env.SUPABASE_SECRET_KEY = originalSecret;
});

describe("cursor ordering", () => {
  test("tracks every event ID sharing the boundary timestamp", () => {
    let cursor = initialCursor("sync", 700_000);
    cursor = advanceCursor(cursor, { id: "a", timestampMs: 200_000 });
    cursor = advanceCursor(cursor, { id: "b", timestampMs: 200_000 });
    expect([...cursor.eventIdsAtTimestamp]).toEqual(["a", "b"]);
    expect(isAfterCursor(cursor, { id: "a", timestampMs: 200_000 })).toBe(false);
    expect(isAfterCursor(cursor, { id: "c", timestampMs: 200_000 })).toBe(true);
    expect(isAfterCursor(cursor, { id: "older", timestampMs: 199_999 })).toBe(false);
  });

  test("advances an empty high-water mark to a completed query boundary", () => {
    const cursor = advanceCursorTo(initialCursor("sync", 700_000), 800_000);
    expect(cursor.timestampMs).toBe(800_000);
    expect(cursor.eventIdsAtTimestamp.size).toBe(0);
  });
});

describe("Supabase cursor persistence", () => {
  test("uses the fallback lookback when no row exists", async () => {
    const mock = installFetchMock(() => jsonResponse([]));
    try {
      const cursor = await getSyncCursor("aircall", 1_000_000);
      expect(cursor.timestampMs).toBe(400_000);
      expect(mock.calls[0]?.input).toContain("sync_key=eq.aircall");
      expect(new Headers(mock.calls[0]?.init?.headers).get("apikey")).toBe("sb_secret_test");
    } finally {
      mock.restore();
    }
  });

  test("reads a persisted boundary ID set", async () => {
    const mock = installFetchMock(() =>
      jsonResponse([{ sync_key: "sync", cursor_value: '["one","two"]', cursor_timestamp: "2026-01-01T00:00:00.000" }]),
    );
    try {
      const cursor = await getSyncCursor("sync");
      expect([...cursor.eventIdsAtTimestamp]).toEqual(["one", "two"]);
      expect(cursor.timestampMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    } finally {
      mock.restore();
    }
  });

  test("upserts the cursor using the primary key", async () => {
    const mock = installFetchMock(() => new Response(null, { status: 204 }));
    try {
      const cursor = advanceCursor(initialCursor("sync", 700_000), { id: "event", timestampMs: 200_000 });
      await saveSyncCursor(cursor);
      expect(mock.calls[0]?.input).toContain("on_conflict=sync_key");
      expect(mock.calls[0]?.init?.method).toBe("POST");
      expect(new Headers(mock.calls[0]?.init?.headers).get("Prefer")).toContain("merge-duplicates");
      expect(JSON.parse(String(mock.calls[0]?.init?.body))).toMatchObject({
        sync_key: "sync",
        cursor_value: '["event"]',
      });
    } finally {
      mock.restore();
    }
  });
});
