import { supabaseBaseUrl, supabaseHeaders } from "./endpoints.js";
import {
  arrayValue,
  isJsonObject,
  responseJson,
  stringValue,
} from "./json.js";

const CURSOR_TABLE = "Attio_Integrations_Touchpoint_Cursors";
const DEFAULT_LOOKBACK_MS = 10 * 60 * 1_000;

//Interface=====================================================================================================

export interface SyncCursor {
  readonly syncKey: string;
  readonly timestampMs: number;
  readonly eventIdsAtTimestamp: ReadonlySet<string>;
}

export interface CursorEvent {
  readonly id: string;
  readonly timestampMs: number;
}

interface CursorRow {
  readonly syncKey: string;
  readonly cursorValue: string | null;
  readonly cursorTimestamp: string;
}

//============================================================================================================

function cursorEndpoint(): URL {
  return new URL(`/rest/v1/${CURSOR_TABLE}`, supabaseBaseUrl());
}

function parseBoundaryIds(cursorValue: string | null): ReadonlySet<string> {
  if (!cursorValue) return new Set();
  try {
    const parsed: unknown = JSON.parse(cursorValue);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return new Set(parsed);
    }
  } catch {
    // A pre-migration cursor may contain one plain event ID.
  }
  return new Set([cursorValue]);
}

function parseCursorTimestamp(value: string): number {
  const includesTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return Date.parse(includesTimezone ? value : `${value}Z`);
}

function parseCursorRow(value: unknown): CursorRow {
  if (!isJsonObject(value)) throw new Error("Supabase returned an invalid cursor row");
  const syncKey = stringValue(value.sync_key);
  const cursorTimestamp = stringValue(value.cursor_timestamp);
  const cursorValue = value.cursor_value === null ? null : stringValue(value.cursor_value);
  if (!syncKey || !cursorTimestamp || (value.cursor_value !== null && !cursorValue)) {
    throw new Error("Supabase cursor row is missing required fields");
  }
  return { syncKey, cursorValue, cursorTimestamp };
}

export function initialCursor(syncKey: string, nowMs = Date.now()): SyncCursor {
  return {
    syncKey,
    timestampMs: nowMs - DEFAULT_LOOKBACK_MS,
    eventIdsAtTimestamp: new Set(),
  };
}

export function isAfterCursor(cursor: SyncCursor, event: CursorEvent): boolean {
  return (
    event.timestampMs > cursor.timestampMs ||
    (event.timestampMs === cursor.timestampMs && !cursor.eventIdsAtTimestamp.has(event.id))
  );
}

export function advanceCursor(cursor: SyncCursor, event: CursorEvent): SyncCursor {
  if (event.timestampMs < cursor.timestampMs) return cursor;
  if (event.timestampMs > cursor.timestampMs) {
    return {
      syncKey: cursor.syncKey,
      timestampMs: event.timestampMs,
      eventIdsAtTimestamp: new Set([event.id]),
    };
  }
  return {
    syncKey: cursor.syncKey,
    timestampMs: cursor.timestampMs,
    eventIdsAtTimestamp: new Set([...cursor.eventIdsAtTimestamp, event.id]),
  };
}

export function advanceCursorTo(cursor: SyncCursor, timestampMs: number): SyncCursor {
  if (timestampMs <= cursor.timestampMs) return cursor;
  return { syncKey: cursor.syncKey, timestampMs, eventIdsAtTimestamp: new Set() };
}

export async function getSyncCursor(syncKey: string, nowMs = Date.now()): Promise<SyncCursor> {
  const url = cursorEndpoint();
  url.searchParams.set("sync_key", `eq.${syncKey}`);
  url.searchParams.set("select", "sync_key,cursor_value,cursor_timestamp");
  url.searchParams.set("limit", "1");

  const response = await fetch(url, { headers: supabaseHeaders() });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new Error(`Supabase cursor read failed (${response.status}): ${JSON.stringify(body)}`);
  }
  if (!isJsonObject(body) && !Array.isArray(body)) {
    throw new Error("Supabase returned an invalid cursor response");
  }
  const rows = Array.isArray(body) ? body : arrayValue(body, "data");
  if (rows.length === 0) return initialCursor(syncKey, nowMs);

  const row = parseCursorRow(rows[0]);
  const timestampMs = parseCursorTimestamp(row.cursorTimestamp);
  if (!Number.isFinite(timestampMs)) throw new Error("Supabase cursor timestamp is invalid");
  return {
    syncKey: row.syncKey,
    timestampMs,
    eventIdsAtTimestamp: parseBoundaryIds(row.cursorValue),
  };
}

export async function saveSyncCursor(cursor: SyncCursor): Promise<void> {
  const url = cursorEndpoint();
  url.searchParams.set("on_conflict", "sync_key");
  const now = new Date().toISOString();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      sync_key: cursor.syncKey,
      cursor_value: JSON.stringify([...cursor.eventIdsAtTimestamp].sort()),
      cursor_timestamp: new Date(cursor.timestampMs).toISOString(),
      last_updated_at: now,
    }),
  });
  if (!response.ok) {
    throw new Error(`Supabase cursor write failed (${response.status}): ${await response.text()}`);
  }
}
