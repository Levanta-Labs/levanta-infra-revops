import { AIRCALL_BASE, aircallAuthHeader, credentialHint } from "./endpoints.js";
import {
  arrayValue,
  isJsonObject,
  numberValue,
  objectValue,
  responseJson,
  stringValue,
} from "./json.js";

//=====================================================================================================
//Interfaces
//=====================================================================================================

export interface AircallTag {
  readonly name: string;
}

export interface AircallContact {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
}

export interface AircallCall {
  readonly id: number;
  readonly status: string;
  readonly direction: string | null;
  readonly rawDigits: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly duration: number;
  readonly tags: readonly AircallTag[];
  readonly contact: AircallContact | null;
}

export interface AircallWebhook {
  readonly event: string;
  readonly timestamp: number;
  readonly token: string;
  readonly call: AircallCall;
}



/**
 * Aircall reports a number as `raw_digits`, punctuated for display ("+1 949-735-4000"), while Attio stores and
 * matches on E.164 ("+19497354000"), so a lookup keyed on the raw value misses. Every raw_digits carries its
 * leading "+" - across a 300-call sample no number arrived without one - so normalising is dropping everything
 * that is not a digit and putting the "+" back.
 */
export function toE164(rawDigits: string | null): string | null {
  if (!rawDigits) return null;
  const digits = rawDigits.replace(/\D/g, "");
  return digits ? `+${digits}` : null;
}

function parseTag(value: unknown): AircallTag | null {
  if (!isJsonObject(value)) return null;
  const name = stringValue(value.name);
  return name ? { name } : null;
}

function contactEmail(contact: Record<string, unknown>): string | null {
  const direct = stringValue(contact.email);
  if (direct) return direct;
  for (const candidate of arrayValue(contact, "emails")) {
    if (typeof candidate === "string" && candidate) return candidate;
    if (isJsonObject(candidate)) {
      const value = stringValue(candidate.value) ?? stringValue(candidate.email);
      if (value) return value;
    }
  }
  return null;
}

//====================================================================================================
//parce functions, turn aircall raw api pull into usable data
//====================================================================================================

function parseContact(value: unknown): AircallContact | null {
  if (!isJsonObject(value)) return null;
  return {
    firstName: stringValue(value.first_name),
    lastName: stringValue(value.last_name),
    companyName: stringValue(value.company_name),
    email: contactEmail(value),
  };
}

export function parseAircallCall(value: unknown): AircallCall {
  if (!isJsonObject(value)) throw new Error("Aircall returned an invalid call");
  const id = numberValue(value.id);
  const startedAt = numberValue(value.started_at);
  if (id === null || startedAt === null) {
    throw new Error("Aircall call is missing id or started_at");
  }
  return {
    id,
    status: stringValue(value.status) ?? "unknown",
    direction: stringValue(value.direction),
    rawDigits: stringValue(value.raw_digits),
    startedAt,
    endedAt: numberValue(value.ended_at),
    duration: numberValue(value.duration) ?? 0,
    tags: arrayValue(value, "tags")
      .map(parseTag)
      .filter((tag): tag is AircallTag => tag !== null),
    contact: parseContact(value.contact),
  };
}

export function parseAircallWebhook(value: unknown): AircallWebhook {
  if (!isJsonObject(value)) throw new Error("Aircall webhook payload must be an object");
  const event = stringValue(value.event);
  const timestamp = numberValue(value.timestamp);
  const token = stringValue(value.token);
  if (!event || timestamp === null || !token) {
    throw new Error("Aircall webhook is missing event, timestamp, or token");
  }
  return { event, timestamp, token, call: parseAircallCall(value.data) };
}

export async function fetchAircallCalls(fromMs: number, toMs: number): Promise<readonly AircallCall[]> {
  const calls: AircallCall[] = [];
  const first = new URL(`${AIRCALL_BASE}/calls`);
  first.searchParams.set("from", String(Math.floor(fromMs / 1_000)));
  first.searchParams.set("to", String(Math.floor(toMs / 1_000)));
  first.searchParams.set("order", "asc");
  first.searchParams.set("per_page", "50");
  let nextUrl: string | null = first.toString();

  while (nextUrl) {
    const response = await fetch(nextUrl, { headers: { Authorization: aircallAuthHeader() } });
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(`Aircall API error ${response.status}: ${JSON.stringify(body)}${credentialHint("aircall", response.status)}`);
    }
    if (!isJsonObject(body)) throw new Error("Aircall calls response is invalid");
    calls.push(...arrayValue(body, "calls").map(parseAircallCall));
    const meta = objectValue(body, "meta");
    nextUrl = stringValue(meta?.next_page_link);
  }
  return calls.filter((call) => call.status === "done" && call.endedAt !== null);
}
