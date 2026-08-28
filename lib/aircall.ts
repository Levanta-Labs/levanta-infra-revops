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
  //Aircall spells a contact address two ways: a scalar `email`, or an `emails` list of strings or of objects.
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
  //id and started_at are the two fields the cursor and the window depend on; absent either, the call is unusable.
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

//---------------------------------------------------------------------------------------------------------
//Reads every completed call in a window. Sole Aircall reader; the touchpoint cron is the only caller.
//FLOW: 1. build page one from fromMs/toMs. 2. follow meta.next_page_link until null. 3. parse each entry with
//parseAircallCall. 4. drop anything not finished.
//WINDOW SEMANTICS - the reason the caller over-reaches: Aircall documents from/to as filters on a call's
//CREATION date, and the Call object carries no created_at at all (only started_at, answered_at, ended_at), so
//the filter is effectively on call START. Callers key their cursor on ended_at, so fromMs must be pulled back
//by at least the longest call expected or a long call is filtered out here (not yet "done") on the run that
//covers its start and is out of range by the run that covers its end. See MAX_CALL_DURATION_MS in the cron.
//Sorting cannot substitute for this: `order` only walks created_at, and a call outside the filter is absent
//from the result set entirely, not merely out of order. No v1 endpoint filters or sorts on ended_at.
//USES: aircallAuthHeader, credentialHint (endpoints.ts); responseJson, arrayValue, objectValue (json.ts).
//---------------------------------------------------------------------------------------------------------
export async function fetchAircallCalls(fromMs: number, toMs: number): Promise<readonly AircallCall[]> {
  const calls: AircallCall[] = [];
  //Aircall takes whole seconds. Floor both bounds so the window can only widen, never clip an edge call.
  const first = new URL(`${AIRCALL_BASE}/calls`);
  first.searchParams.set("from", String(Math.floor(fromMs / 1_000)));
  first.searchParams.set("to", String(Math.floor(toMs / 1_000)));
  first.searchParams.set("per_page", "50");
  let nextUrl: string | null = first.toString();

  //[PERF] Page cost scales with the width of the window, so widening fromMs is not free - see the cron constant.
  while (nextUrl) {
    //[SECURITY] Basic credentials are rebuilt per request from env and never held in module state.
    const response = await fetch(nextUrl, { headers: { Authorization: aircallAuthHeader() } });
    const body = await responseJson(response);
    //[DEBUG] credentialHint names AIRCALL_API_ID / AIRCALL_API_TOKEN on a 401/403.
    if (!response.ok) {
      throw new Error(`Aircall API error ${response.status}: ${JSON.stringify(body)}${credentialHint("aircall", response.status)}`);
    }
    if (!isJsonObject(body)) throw new Error("Aircall calls response is invalid");
    calls.push(...arrayValue(body, "calls").map(parseAircallCall));
    //Aircall hands back an absolute URL for the next page; null ends the walk.
    const meta = objectValue(body, "meta");
    nextUrl = stringValue(meta?.next_page_link);
  }
  //A call still ringing or in progress has no completion time, so it cannot be placed on the cursor timeline.
  //It is simply omitted; a later run reads it once Aircall marks it done.
  return calls.filter((call) => call.status === "done" && call.endedAt !== null);
}
