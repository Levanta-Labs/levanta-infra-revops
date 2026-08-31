import { findPersonByEmail, findPersonByPhone } from "./attio.js";
import type { AircallCall } from "./aircall.js";
import { toE164 } from "./phone.js";
import { requiredCsvEnv } from "./env.js";
import { interestedLead, recordInterestedLead, type InterestedLead } from "./interested.js";

//=============================================================================================================
//The Aircall interested workflow. Driven only by the touchpoint cron, which finds tagged calls by polling.
//
//There was formerly a /api/aircall-interested webhook route as well. It was removed: Aircall applies the
//outcome tag after the call ends, so the payload the webhook received usually carried no tag yet, and the poll
//had to cover the gap regardless. Keeping both meant every tagged call was recorded twice.
//
//Nothing here touches HTTP - the module is pure workflow so the cron can call it directly.
//=============================================================================================================

export interface AircallInterestedFields {
  readonly email: string | null;
  //The dialled number first, then any other number on the contact. All E.164.
  readonly phones: readonly string[];
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly information: string | null;
  readonly direction: string | null;
  readonly duration: number;
  readonly tags: readonly string[];
  readonly occurredAt: number;
}

export function extractAircallFields(call: AircallCall, occurredAt: number): AircallInterestedFields {
  //Normalised here rather than at the lookup, so the number written back to Attio is E.164 too. The dialled
  //number leads because it is the one that identified this person; the contact's others follow.
  const dialled = toE164(call.rawDigits);
  const phones = [dialled, ...(call.contact?.phoneNumbers ?? [])].filter(
    (phone): phone is string => phone !== null,
  );
  return {
    email: call.contact?.email ?? null,
    phones: [...new Set(phones)],
    firstName: call.contact?.firstName ?? null,
    lastName: call.contact?.lastName ?? null,
    companyName: call.contact?.companyName ?? null,
    information: call.contact?.information ?? null,
    direction: call.direction,
    duration: call.duration,
    tags: call.tags.map((tag) => tag.name),
    occurredAt,
  };
}

//---------------------------------------------------------------------------------------------------------
//The call as the shared workflow sees it. Aircall supplies the least of the three providers by a wide margin:
//no LinkedIn URL, job title, industry, headcount, or revenue exists anywhere in its API, and a name or company
//appears only when the dialled number was already in Aircall's address book - which for a cold campaign it
//usually is not. The remaining fields are left null and the mapping simply writes less.
//---------------------------------------------------------------------------------------------------------
//USES: interestedLead (lib/interested.ts). Pure.
export function aircallLead(fields: AircallInterestedFields): InterestedLead {
  return interestedLead("aircall", {
    emails: fields.email ? [fields.email] : [],
    phones: fields.phones,
    firstName: fields.firstName,
    lastName: fields.lastName,
    companyName: fields.companyName,
    description: fields.information,
    occurredAtMs: fields.occurredAt * 1_000,
  });
}

export function buildCallHistorySummary(fields: AircallInterestedFields): string {
  const durationMinutes = Math.round(fields.duration / 60);
  return [
    `**Aircall interaction — ${new Date(fields.occurredAt * 1_000).toISOString()}**`,
    `- Direction: ${fields.direction ?? "unknown"}`,
    `- Duration: ${durationMinutes} min`,
    fields.tags.length > 0 ? `- Tags: ${fields.tags.join(", ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export type InterestedResult =
  | { readonly status: "done"; readonly personId: string; readonly dealId: string }
  | { readonly status: "no_contact_details" };

/** The configured interested tags, lowercased for comparison. Read once per run, never per call. */
export function interestedTagSet(): ReadonlySet<string> {
  return new Set(requiredCsvEnv("AIRCALL_INTERESTED_TAGS").map((tag) => tag.toLowerCase()));
}

/** The interested tags carried by this call, as Aircall spells them. Empty means the call is not interested. */
export function matchedInterestedTags(call: AircallCall, interested: ReadonlySet<string>): readonly string[] {
  return call.tags.map((tag) => tag.name).filter((tag) => interested.has(tag.toLowerCase()));
}

/**
 * Who the call was with, for a log line. Aircall attaches a contact only to a number already in its address book,
 * which for a dialled campaign is usually neither, so the number stands in when there is no name.
 */
export function callSubject(call: AircallCall): string {
  const contact = call.contact;
  const named = [contact?.firstName, contact?.lastName].filter((part) => part).join(" ");
  const who = named || contact?.companyName || null;
  const phone = toE164(call.rawDigits);
  return [who, phone].filter((part) => part).join(" ") || "no contact and no number on the call";
}

//---------------------------------------------------------------------------------------------------------
//[DEBUG] Emits one decision line per call examined and returns the matching tags.
//Every call produces a line, match or miss, so a run that records nothing interested reads as "these calls,
//these tags, no match" rather than as silence. Silence is indistinguishable from the check never running.
//The configured set is printed only on a miss, which is where "compared against what?" is the open question.
//USES: matchedInterestedTags, callSubject (this module).
//---------------------------------------------------------------------------------------------------------
export function logInterestedDecision(
  call: AircallCall,
  interested: ReadonlySet<string>,
): readonly string[] {
  const tags = call.tags.map((tag) => tag.name);
  const matched = matchedInterestedTags(call, interested);
  const label = `[interested] poll call ${call.id} (${callSubject(call)})`;
  if (matched.length > 0) {
    console.log(`${label}: INTERESTED - matched ${JSON.stringify(matched)} of ${JSON.stringify(tags)}`);
  } else if (tags.length === 0) {
    console.log(`${label}: not interested - the call carries no tags at all`);
  } else {
    console.log(
      `${label}: not interested - ${JSON.stringify(tags)} matches none of ${JSON.stringify([...interested])}`,
    );
  }
  return matched;
}

//---------------------------------------------------------------------------------------------------------
//Records an interested call in Attio. Called by the touchpoint cron once a call's tags have matched.
//FLOW: 1. flatten the call (extractAircallFields). 2. bail if there is no email and no phone - nothing to
//match or create on. 3. hand the rest to recordInterestedLead (lib/interested.ts), which is the same sequence
//every provider runs. Aircall's own contributions to it are only these: how a person is looked up (email, then
//the dialled number), and what the note says.
//occurredAt is epoch SECONDS - the call's ended_at.
//[STABILITY] recordInterestedLead makes a series of API calls with no transaction. A throw partway leaves the
//earlier writes committed; the cron catches it, counts the failure, and moves to the next call.
//USES: extractAircallFields, aircallLead, buildCallHistorySummary (this module); findPersonByEmail,
//findPersonByPhone (lib/attio.ts); recordInterestedLead (lib/interested.ts).
//---------------------------------------------------------------------------------------------------------
export async function processAircallInterested(
  call: AircallCall,
  occurredAt: number,
): Promise<InterestedResult> {
  const fields = extractAircallFields(call, occurredAt);
  //The dialled number, which is also the one a lookup can match on.
  const phone = fields.phones[0] ?? null;
  //No identifier at all: creating a person would produce an unmatchable blank record, so stop here.
  if (!fields.email && !phone) {
    console.warn(
      `[interested] poll call ${call.id}: rejected - the call carried neither an email nor a phone number, so no person can be matched or created`,
    );
    return { status: "no_contact_details" };
  }

  const outcome = await recordInterestedLead({
    lead: aircallLead(fields),
    subject: `poll call ${call.id}`,
    //Email first: it is the stronger identifier. Phone is the fallback for a dialled number Aircall knows
    //nothing about, which for a cold campaign is the usual case.
    findPerson: async () => (await findPersonByEmail(fields.email)) ?? (await findPersonByPhone(phone)),
    //Aircall's history is the call itself - there is no thread to fetch, so this costs no request.
    history: async () => buildCallHistorySummary(fields),
  });
  return { status: "done", personId: outcome.personId, dealId: outcome.dealId };
}
