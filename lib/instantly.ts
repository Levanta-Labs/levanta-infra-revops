import { credentialHint, INSTANTLY_BASE, instantlyAuthHeader } from "./endpoints.js";
import {
  arrayValue,
  isJsonObject,
  objectValue,
  responseJson,
  stringValue,
} from "./json.js";

export type InstantlyEmailType = "received" | "sent" | "scheduled" | "unknown";

//Interfaces=======================================================================================

export interface InstantlyEmail {
  readonly id: string;
  readonly timestampCreated: string;
  readonly timestampEmail: string;
  readonly emailType: InstantlyEmailType;
  readonly leadEmail: string | null;
  readonly isAutoReply: boolean;
  readonly subject: string | null;
  readonly bodyText: string | null;
  readonly threadId: string | null;
}

//=================================================================================================

function parseEmailType(value: unknown): InstantlyEmailType {
  if (value === 1 || value === 3) return "sent";
  if (value === 2) return "received";
  if (value === 4) return "scheduled";
  return "unknown";
}

export function parseInstantlyEmail(value: unknown): InstantlyEmail {
  if (!isJsonObject(value)) throw new Error("Instantly returned an invalid email");
  const id = stringValue(value.id);
  const timestampCreated = stringValue(value.timestamp_created);
  const timestampEmail = stringValue(value.timestamp_email) ?? timestampCreated;
  const leadEmail = stringValue(value.lead);
  if (!id || !timestampCreated || !timestampEmail) {
    throw new Error("Instantly email is missing id or timestamp");
  }
  if (!Number.isFinite(Date.parse(timestampCreated)) || !Number.isFinite(Date.parse(timestampEmail))) {
    throw new Error("Instantly email has an invalid timestamp");
  }
  const body = objectValue(value, "body");
  return {
    id,
    timestampCreated,
    timestampEmail,
    emailType: parseEmailType(value.ue_type),
    leadEmail,
    isAutoReply: value.is_auto_reply === 1,
    subject: stringValue(value.subject),
    bodyText: stringValue(body?.text),
    threadId: stringValue(value.thread_id),
  };
}

export interface InstantlyEmailQuery {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly leadEmail?: string;
}

export async function fetchInstantlyEmails(
  query: InstantlyEmailQuery,
): Promise<readonly InstantlyEmail[]> {
  const emails: InstantlyEmail[] = [];
  let startingAfter: string | null = null;

  do {
    const url = new URL(`${INSTANTLY_BASE}/emails`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("sort_order", "asc");
    if (query.fromMs !== undefined) {
      url.searchParams.set("min_timestamp_created", new Date(Math.max(0, query.fromMs - 1)).toISOString());
    }
    if (query.toMs !== undefined) {
      url.searchParams.set("max_timestamp_created", new Date(query.toMs).toISOString());
    }
    if (query.leadEmail) url.searchParams.set("lead", query.leadEmail);
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const response = await fetch(url, {
      headers: { Authorization: instantlyAuthHeader() },
    });
    const body = await responseJson(response);
    if (!response.ok) {
      throw new Error(`Instantly API error ${response.status}: ${JSON.stringify(body)}${credentialHint("instantly", response.status)}`);
    }
    if (!isJsonObject(body)) throw new Error("Instantly emails response is invalid");
    emails.push(...arrayValue(body, "items").map(parseInstantlyEmail));
    startingAfter = stringValue(body.next_starting_after);
  } while (startingAfter);

  return emails;
}
