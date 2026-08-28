import {
  addPersonToList,
  blankPersonValues,
  createNote,
  createPerson,
  defaultDealOwner,
  ensureInterestedDeal,
  findPersonByEmail,
  findPersonByPhone,
  LEAD_SOURCE_LABELS,
  LISTS,
  patchPerson,
  personLabel,
  type CreatePersonValues,
  type PersonNameInput,
} from "./attio.js";
import { toE164, type AircallCall } from "./aircall.js";
import { requiredCsvEnv } from "./env.js";

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
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly direction: string | null;
  readonly duration: number;
  readonly tags: readonly string[];
  readonly occurredAt: number;
}

export function extractAircallFields(call: AircallCall, occurredAt: number): AircallInterestedFields {
  return {
    email: call.contact?.email ?? null,
    //Normalised here rather than at the lookup, so the number written back to Attio is E.164 too.
    phone: toE164(call.rawDigits),
    firstName: call.contact?.firstName ?? null,
    lastName: call.contact?.lastName ?? null,
    companyName: call.contact?.companyName ?? null,
    direction: call.direction,
    duration: call.duration,
    tags: call.tags.map((tag) => tag.name),
    occurredAt,
  };
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

function personValues(fields: AircallInterestedFields): CreatePersonValues {
  const values: {
    email_addresses?: readonly string[];
    phone_numbers?: readonly string[];
    name?: readonly PersonNameInput[];
  } = {};
  //Each key is omitted rather than set null when absent, because blankPersonValues keys off presence.
  if (fields.email) values.email_addresses = [fields.email];
  if (fields.phone) values.phone_numbers = [fields.phone];
  if (fields.firstName || fields.lastName) {
    const firstName = fields.firstName ?? "";
    const lastName = fields.lastName ?? "";
    values.name = [{ first_name: firstName, last_name: lastName, full_name: `${firstName} ${lastName}`.trim() }];
  }
  return values;
}

function dealName(fields: AircallInterestedFields): string {
  if (fields.companyName) return `${fields.companyName} - Interested`;
  return `${fields.firstName ?? ""} ${fields.lastName ?? ""}`.trim() || "New Interested Deal";
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
//match or create on. 3. resolve the person: email, then phone, then create. 4. ensureInterestedDeal - reuses
//any deal already linked to the person, whatever its stage, and only creates one when none exists.
//5. note on the person and on the deal. 6. patchPerson with blankPersonValues, which fills only attributes
//Attio currently holds nothing for. 7. add to the DNC list so outbound stops contacting them.
//USES: attio.ts for every write; occurredAt is epoch SECONDS (the call's ended_at).
//[STABILITY] Steps 4-7 are separate Attio calls with no transaction. A throw partway leaves the earlier
//writes committed; the cron catches it, counts the failure, and moves to the next call.
//---------------------------------------------------------------------------------------------------------
export async function processAircallInterested(
  call: AircallCall,
  occurredAt: number,
): Promise<InterestedResult> {
  const fields = extractAircallFields(call, occurredAt);
  //No identifier at all: creating a person would produce an unmatchable blank record, so stop here.
  if (!fields.email && !fields.phone) {
    console.warn(
      `[interested] poll call ${call.id}: rejected - the call carried neither an email nor a phone number, so no person can be matched or created`,
    );
    return { status: "no_contact_details" };
  }

  //Email first: it is the stronger identifier. Phone is the fallback for a dialled number Aircall knows nothing about.
  let person = await findPersonByEmail(fields.email);
  if (!person) person = await findPersonByPhone(fields.phone);
  if (!person) person = await createPerson(personValues(fields));

  const personId = person.id.record_id;
  const personName = personLabel(person);
  const dealId = await ensureInterestedDeal(
    person,
    dealName(fields),
    defaultDealOwner(),
  );
  const history = buildCallHistorySummary(fields);
  const title = LEAD_SOURCE_LABELS.aircall;
  await createNote("people", personId, title, history, personName);
  await createNote("deals", dealId, title, history);
  //blankPersonValues strips any attribute Attio already holds, so third-party data can only fill gaps.
  await patchPerson(
    personId,
    blankPersonValues(person, { ...personValues(fields), lead_source: title }),
    personName,
  );
  await addPersonToList(personId, LISTS.DNC, personName);

  console.log(`[interested] poll call ${call.id}: completed - person ${personName}, deal ${dealId}`);
  return { status: "done", personId, dealId };
}
