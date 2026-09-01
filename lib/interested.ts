import {
  addPersonToList,
  AttioApiError,
  createCompany,
  createNote,
  createPerson,
  defaultDealOwner,
  ensureInterestedDeal,
  fetchRecord,
  findCompanyByDomain,
  findCompanyByName,
  LISTS,
  patchRecord,
  personCompanyId,
  personLabel,
  recordDisplayName,
  type AttioObject,
  type AttioPerson,
  type AttioRecord,
  type AttioValues,
} from "./attio.js";
import { arrayValue, errorMessage, isJsonObject, stringValue } from "./json.js";
import {
  automatedSourceLabel,
  leadSourceLabel,
  THIRD_PARTY_SUPPRESSION_CHANNELS,
  type Provider,
  type SuppressionChannel,
  type SuppressionTargets,
} from "./providers.js";
//[RUN LOG] Additive diagnostics, self-contained in lib/run-log.ts. This import and the four lines it is used on
//in recordInterestedLead are the feature's entire footprint in this module.
import { runLogCompany, runLogTarget, snapshotBefore, withRunLog } from "./run-log.js";

//=============================================================================================================
//What the three interested workflows have in common.
//
//Aircall, Instantly, and HeyReach reach Attio by three different routes - a poll and two webhooks of different
//shapes - and each knows different things about a lead. What happens once the lead IS known is the same in all
//three, and this module is that part: one normalised lead shape, one mapping onto Attio attributes, one write
//path that cannot overwrite, one company resolution, one deal naming rule, and one suppression across every
//outbound platform. The provider modules keep only what is genuinely theirs - parsing their own payload, and
//rendering their own message history into a note.
//=============================================================================================================

//#region the normalised lead
//---------------------------------------------------------------------------------------------------------
//Every field any provider can supply about an interested lead. A provider that cannot supply one passes null,
//and null never reaches Attio - see updateAttioAttributes.
//No provider fills all of it. Aircall fills the least by far: a phone number, plus a name and company only when
//that number was already in its address book.
//---------------------------------------------------------------------------------------------------------
export interface InterestedLead {
  readonly provider: Provider;
  //Plural because Attio's equivalents are multiselect and providers do carry several - HeyReach alone has three
  //address fields. Order is significance, not preference: the first is what single-valued Deal attributes take.
  readonly emails: readonly string[];
  //E.164 already. Normalising at the edge rather than here is what lets one string both match Attio and be
  //written back to it.
  readonly phones: readonly string[];
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly linkedin: string | null;
  readonly jobTitle: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly companyName: string | null;
  readonly companyDomain: string | null;
  //A postal address as one string, parsed by parsePostalAddress below. Attio's location attribute is structured,
  //so an address that will not parse is dropped rather than guessed at.
  readonly companyAddress: string | null;
  //Both verbatim as the provider spelled them, because the Deal attributes are free text. The bucketed Company
  //selects are derived from them by toEmployeeRange and toArrBucket.
  readonly employeeCount: string | null;
  readonly annualRevenue: string | null;
  readonly industry: string | null;
  readonly website: string | null;
  readonly campaignName: string | null;
  //When the lead became interested, epoch milliseconds. Feeds Person Date Added and Deal Moved to Interested At.
  readonly occurredAtMs: number | null;
}

/**
 * [LOGIC] Defaults every field, so a provider's extractor names only what it actually has. Absent means null,
 * and null never reaches Attio - see updateAttioAttributes.
 * USES: nothing. Pure.
 */
export function interestedLead(
  provider: Provider,
  fields: Partial<Omit<InterestedLead, "provider">>,
): InterestedLead {
  return {
    provider,
    emails: fields.emails ?? [],
    phones: fields.phones ?? [],
    firstName: fields.firstName ?? null,
    lastName: fields.lastName ?? null,
    linkedin: fields.linkedin ?? null,
    jobTitle: fields.jobTitle ?? null,
    description: fields.description ?? null,
    location: fields.location ?? null,
    companyName: fields.companyName ?? null,
    companyDomain: fields.companyDomain ?? null,
    companyAddress: fields.companyAddress ?? null,
    employeeCount: fields.employeeCount ?? null,
    annualRevenue: fields.annualRevenue ?? null,
    industry: fields.industry ?? null,
    website: fields.website ?? null,
    campaignName: fields.campaignName ?? null,
    occurredAtMs: fields.occurredAtMs ?? null,
  };
}
//#endregion

//#region transforms
//---------------------------------------------------------------------------------------------------------
//[LOGIC] Provider values into the exact shape one Attio attribute type accepts.
//Every one returns null rather than a best guess when the input does not fit. A blank attribute is
//recoverable; a confidently wrong value is not, because nothing downstream will ever overwrite it.
//---------------------------------------------------------------------------------------------------------

//A magnitude suffix on a number: 4.3M is 4,300,000. Providers abbreviate revenue and headcount this way, and
//reading "4.3M" as the digits 43 would be wrong by six orders of magnitude - silently, and permanently.
const MAGNITUDES: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000, b: 1_000_000_000, t: 1_000_000_000_000 };

//---------------------------------------------------------------------------------------------------------
//[LOGIC] A count out of a number written any way a provider might write it.
//FLOW: 1. drop currency symbols, spaces, and thousands separators. 2. a range ("50-100", "1K-5K") keeps its
//lower bound only. 3. read the leading number, decimal point included. 4. apply a magnitude suffix if one
//follows it. 5. anything with no leading number at all -> null.
//Step 2 takes the lower bound rather than a midpoint because it is a value the provider actually stated,
//not one derived from it. Step 3 stops at the first non-numeric character, so "84 employees" reads as 84.
//USES: MAGNITUDES (this module). Pure.
//---------------------------------------------------------------------------------------------------------
function toCount(value: string | null): number | null {
  if (!value) return null;
  //Currency symbols and separators carry no quantity; stripping them first leaves a bare number to read.
  const cleaned = value.replace(/[,\s$£€]/g, "");
  //A range states two numbers. Only the first is kept - see above.
  const lowerBound = cleaned.split(/[-–—]/)[0] ?? "";
  const match = /^(\d+(?:\.\d+)?)([kmbt])?/i.exec(lowerBound);
  if (!match?.[1]) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  const magnitude = match[2] ? (MAGNITUDES[match[2].toLowerCase()] ?? 1) : 1;
  return Math.round(amount * magnitude);
}

/** [LOGIC] A headcount into one of Attio's nine Employee range options. Boundaries follow the labels exactly. */
export function toEmployeeRange(value: string | null): string | null {
  const count = toCount(value);
  if (count === null || count <= 0) return null;
  if (count <= 10) return "1-10";
  if (count <= 50) return "11-50";
  if (count <= 250) return "51-250";
  if (count <= 1_000) return "251-1K";
  if (count <= 5_000) return "1K-5K";
  if (count <= 10_000) return "5K-10K";
  if (count <= 50_000) return "10K-50K";
  if (count <= 100_000) return "50K-100K";
  return "100K+";
}

/** [LOGIC] A revenue figure in dollars into one of Attio's nine Estimated ARR options. */
export function toArrBucket(value: string | null): string | null {
  const amount = toCount(value);
  if (amount === null || amount <= 0) return null;
  if (amount < 1_000_000) return "$0-$1M";
  if (amount < 10_000_000) return "$1M-$10M";
  if (amount < 50_000_000) return "$10M-$50M";
  if (amount < 100_000_000) return "$50M-$100M";
  if (amount < 250_000_000) return "$100M-$250M";
  if (amount < 500_000_000) return "$250M-$500M";
  if (amount < 1_000_000_000) return "$500M-$1B";
  if (amount < 10_000_000_000) return "$1B-$10B";
  return "$10B+";
}

//Hosts that are never a company's own domain. A provider that puts a LinkedIn or Facebook page where a website
//belongs - which they do - would otherwise write "linkedin.com" into Attio's Domains attribute, and Domains is
//UNIQUE: the first company to claim it takes the slot, and every company after that fails to match or to save.
//One bad value here does lasting damage to records it never touched, so the list errs on the side of refusing.
const NEVER_A_COMPANY_DOMAIN: ReadonlySet<string> = new Set([
  "linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com", "youtube.com", "tiktok.com",
  "crunchbase.com", "angel.co", "wellfound.com", "github.com", "medium.com", "substack.com",
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com", "aol.com",
  "sites.google.com", "wixsite.com", "squarespace.com", "wordpress.com", "godaddysites.com",
]);

//---------------------------------------------------------------------------------------------------------
//[LOGIC] A hostname out of whatever a provider called a website, or null if it is not this company's own.
//FLOW: 1. no input -> null. 2. parse as a URL so a path, port, or query cannot survive. 3. lowercase and drop
//a leading "www.". 4. reject anything without a dot, or with whitespace. 5. reject a known non-company host.
//Step 2 adds a scheme when there is none, because a bare hostname will not parse as a URL without one.
//Step 5 is the important one - see NEVER_A_COMPANY_DOMAIN. Attio's Domains attribute is unique, so a wrong
//value is not merely wrong on this record; it takes a slot no other company can then claim.
//USES: NEVER_A_COMPANY_DOMAIN (this module). Pure.
//---------------------------------------------------------------------------------------------------------
export function toDomain(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let host: string;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  const domain = host.toLowerCase().replace(/^www\./, "");
  //A domain has a dot and no whitespace. Rejects "localhost" and a company name that arrived here by mistake.
  if (!domain.includes(".") || /\s/.test(domain)) return null;
  if (NEVER_A_COMPANY_DOMAIN.has(domain)) {
    console.warn(
      `[attio] ${JSON.stringify(domain)} was not written as a company domain: it is a social, code, or mailbox host, and Domains is unique in Attio - claiming it would block every other company that shares it`,
    );
    return null;
  }
  return domain;
}

//A country name to its ISO 3166-1 alpha-2 code, because Attio's location attribute stores the code.
//Deliberately short: it covers the countries this workspace's lead data actually contains, and an address whose
//country is not listed simply gets no structured location. Extend it as new markets appear.
const COUNTRY_CODES: Readonly<Record<string, string>> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  canada: "CA",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  ireland: "IE",
  australia: "AU",
  "new zealand": "NZ",
  germany: "DE",
  france: "FR",
  spain: "ES",
  italy: "IT",
  netherlands: "NL",
  belgium: "BE",
  switzerland: "CH",
  austria: "AT",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  poland: "PL",
  portugal: "PT",
  mexico: "MX",
  brazil: "BR",
  india: "IN",
  singapore: "SG",
  japan: "JP",
  israel: "IL",
  "south africa": "ZA",
  "united arab emirates": "AE",
};

/** Every key an Attio location value carries. Sent whole, because a partial location is rejected. */
export interface AttioLocation {
  readonly line_1: string | null;
  readonly line_2: string | null;
  readonly line_3: string | null;
  readonly line_4: string | null;
  readonly locality: string | null;
  readonly region: string | null;
  readonly postcode: string | null;
  readonly country_code: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
}

//---------------------------------------------------------------------------------------------------------
//A comma-separated postal address into Attio's structured location.
//Providers send "<street>, <city>, <region>, <country>, <postcode>" - country second to last, postcode last -
//so the address is read from the RIGHT, where the fields are positional, and whatever remains on the left
//becomes the street line.
//Returns null unless the country resolves to an ISO code. Without one Attio has no location to store, and a
//guessed country is worse than none: it would place the company on the wrong continent in every filter.
//---------------------------------------------------------------------------------------------------------
export function parsePostalAddress(value: string | null): AttioLocation | null {
  if (!value) return null;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;

  //A trailing field carrying a digit is a postcode, not a country. Dropping it first leaves the country last
  //whether or not a postcode was present.
  let postcode: string | null = null;
  const tail = parts[parts.length - 1];
  if (tail !== undefined && /\d/.test(tail) && parts.length > 3) {
    postcode = tail;
    parts.pop();
  }

  const country = parts.pop();
  const countryCode = country ? COUNTRY_CODES[country.toLowerCase()] : undefined;
  if (!countryCode) return null;

  const region = parts.pop() ?? null;
  const locality = parts.pop() ?? null;
  //Anything still to the left is street address, rejoined as it arrived.
  const line1 = parts.length > 0 ? parts.join(", ") : null;

  return {
    line_1: line1,
    line_2: null,
    line_3: null,
    line_4: null,
    locality,
    region,
    postcode,
    country_code: countryCode,
    latitude: null,
    longitude: null,
  };
}

/** An epoch-millisecond instant as an Attio timestamp, or null when the caller had no time to give. */
export function toTimestamp(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/** The same instant as an Attio date. Date-typed attributes reject a full timestamp. */
export function toDate(ms: number | null): string | null {
  const iso = toTimestamp(ms);
  return iso ? iso.slice(0, 10) : null;
}
//#endregion

//#region the write path
//---------------------------------------------------------------------------------------------------------
//Reading a scalar back OUT of a value Attio returned. Needed only for the multiselect attributes below, where
//a write has to include what is already there. Each attribute type spells its scalar differently.
//---------------------------------------------------------------------------------------------------------
type ScalarReader = (value: Record<string, unknown>) => string | null;

//The multiselect attributes these workflows write. A PATCH REPLACES an attribute rather than appending to it,
//so for these the existing entries are read and sent back alongside the new one. Every other attribute is left
//strictly alone once populated; these are the exception because a lead's second address or number is additive
//information, and skipping the write outright is what silently dropped it before.
const MULTISELECT_READERS: Readonly<Record<string, ScalarReader>> = {
  email_addresses: (value) => stringValue(value.email_address) ?? stringValue(value.original_email_address),
  phone_numbers: (value) => stringValue(value.original_phone_number) ?? stringValue(value.phone_number),
  domains: (value) => stringValue(value.domain) ?? stringValue(value.root_domain),
};

//---------------------------------------------------------------------------------------------------------
//The slugs that OVERWRITE rather than fill. The standing rule below is that Attio's own data always wins; this
//set is the deliberate exception to it, so the exception is one named list rather than a special case buried in
//the loop.
//
//WHY LEAD SOURCE IS ON IT. Every other attribute here is a fact about the person - a job title, a location -
//that a human may have corrected in the CRM and that a provider has no standing to contradict. Lead source is
//not a fact about the person; it is a statement about THIS run: the channel that just produced the interested
//signal. Filling it only when blank meant a person first seen on one platform kept that platform's label
//forever, and a later interested event on another channel was recorded everywhere except the field reporting
//reads. The value the run carries is by definition the most recent truth, so it replaces what is there.
//
//COST: a person worked across channels no longer preserves the FIRST source, only the latest. The full history
//is still recoverable - every interested event writes a note titled with its own leadSourceLabel, so the
//sequence lives on the person's and the deal's notes even though the attribute holds only the newest.
//
//Applies to the Person's `lead_source` and, through dealValuesFor, the Deal's. Both carry the same string,
//automatedSourceLabel. Companies never receive this slug.
//---------------------------------------------------------------------------------------------------------
const ALWAYS_OVERWRITE: ReadonlySet<string> = new Set(["lead_source"]);

/**
 * [LOGIC] The scalars an attribute currently holds, or null if ANY entry could not be read. All-or-nothing on
 * purpose: a partial read is what would silently delete the entries it failed to see - see mergeMultiselect.
 * USES: arrayValue, isJsonObject (lib/json.js). Pure.
 */
function existingScalars(record: AttioRecord, slug: string, read: ScalarReader): string[] | null {
  const scalars: string[] = [];
  for (const entry of arrayValue(record.rawValues, slug)) {
    if (!isJsonObject(entry)) return null;
    const scalar = read(entry);
    if (scalar === null) return null;
    scalars.push(scalar);
  }
  return scalars;
}

//---------------------------------------------------------------------------------------------------------
//Existing entries plus whichever candidates are new, or null to write nothing at all.
//[SECURITY] The null returns are the important part. This is the only place in the codebase that sends Attio a
//value it did not itself supply, and it does so on a REPLACING write: if the existing entries were read back
//even slightly wrong, the patch would delete a real address or phone number. So an attribute holding anything
//this cannot read in full is declined outright, and an attribute that would gain nothing is left untouched
//rather than rewritten to its own value.
//FLOW: 1. no reader for this slug -> decline. 2. read the existing entries; unreadable -> decline. 3. keep only
//candidates not already present, compared case-insensitively. 4. nothing new -> decline. 5. existing + new.
//[DEBUG] The decline at step 2 warns, because an attribute quietly not gaining a value is undiagnosable.
//USES: existingScalars, MULTISELECT_READERS (this module); arrayValue (lib/json.js).
//---------------------------------------------------------------------------------------------------------
function mergeMultiselect(
  record: AttioRecord,
  slug: string,
  candidate: readonly string[],
): readonly string[] | null {
  const read = MULTISELECT_READERS[slug];
  if (!read) return null;
  const existing = existingScalars(record, slug, read);
  if (existing === null) {
    console.warn(
      `[attio] ${slug} was left alone: it already holds ${arrayValue(record.rawValues, slug).length} entr(ies) that could not all be read back, and this attribute can only be written whole. Nothing was risked, but nothing was added either.`,
    );
    return null;
  }
  //Case-insensitive, because an address or domain differing only in case is the same one and must not be added
  //twice. Phone numbers are E.164 by the time they arrive, so this costs them nothing.
  const seen = new Set(existing.map((value) => value.toLowerCase()));
  const additions = candidate.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (additions.length === 0) return null;
  return [...existing, ...additions];
}

/** [LOGIC] Nothing worth writing: absent, blank, or an empty list. Distinct from a value Attio already holds. */
function isEmptyCandidate(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

//---------------------------------------------------------------------------------------------------------
//[LOGIC] The same values with every empty one removed, so a slug the provider knows nothing about is absent
//rather than present-and-null.
//This is what the mappers below return. It matters most on CREATION: createPerson and createCompany send their
//values to Attio verbatim, with none of the filtering updateAttioAttributes does, and a null or an empty array
//on a create is an instruction to Attio about an attribute rather than silence about it.
//USES: isEmptyCandidate (this module). Pure.
//---------------------------------------------------------------------------------------------------------
function withoutEmpty(values: Record<string, unknown>): AttioValues {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => !isEmptyCandidate(value)));
}

export interface AttributeWriteResult {
  /** The slugs Attio accepted. */
  readonly written: readonly string[];
  /** The slugs Attio rejected, which the event continued without. */
  readonly dropped: readonly string[];
}

//---------------------------------------------------------------------------------------------------------
//Writes the fillable attributes, salvaging as many as Attio will take.
//FLOW: 1. one PATCH with all of them, which is the normal case and the only request usually made. 2. if that
//is rejected on the CONTENT of the write - a 400 or 422 - retry them one at a time, so one value Attio will not
//accept costs only itself. 3. anything still rejected is dropped.
//A rejection that is not about content - 401, 403, 404, a 5xx, a transport failure - is not retried: the write
//is unavailable for reasons no single attribute caused, and N further attempts would fail identically.
//NEVER THROWS. Attribute enrichment is the last and least of what an interested event does; the person, the
//company, the deal, and the notes are already committed by the time it runs, and losing all of them because one
//provider value would not fit an Attio attribute is a far worse outcome than a blank field. What was dropped is
//logged, because an attribute silently missing with no record of why is undiagnosable.
//---------------------------------------------------------------------------------------------------------
//USES: patchRecord, AttioApiError (lib/attio.ts); errorMessage (lib/json.js).
//[DEBUG] Everything dropped is named individually and then counted, so a missing attribute has a cause on
//record. patchRecord logs its own FAILED line first; the [attio] line that follows says what was done about it.
async function writeSalvagingRejections(
  object: AttioObject,
  recordId: string,
  fillable: Record<string, unknown>,
  label: string,
): Promise<AttributeWriteResult> {
  const slugs = Object.keys(fillable);
  if (slugs.length === 0) {
    await patchRecord(object, recordId, {}, label);
    return { written: [], dropped: [] };
  }

  try {
    await patchRecord(object, recordId, fillable, label);
    return { written: slugs, dropped: [] };
  } catch (error) {
    //Only a complaint about the content is worth taking apart attribute by attribute.
    const isContentRejection =
      error instanceof AttioApiError && (error.status === 400 || error.status === 422);
    if (!isContentRejection) {
      console.warn(
        `[attio] ${object} ${label}: dropped ${slugs.join(", ")} - the write failed for a reason no single attribute caused (${errorMessage(error)}). The event continues without them.`,
      );
      return { written: [], dropped: slugs };
    }
    console.warn(
      `[attio] ${object} ${label}: Attio rejected the write on its content, so the ${slugs.length} attribute(s) are retried one at a time - one value it will not accept should cost only itself`,
    );
  }

  const written: string[] = [];
  const dropped: string[] = [];
  for (const slug of slugs) {
    try {
      await patchRecord(object, recordId, { [slug]: fillable[slug] }, label);
      written.push(slug);
    } catch (error) {
      dropped.push(slug);
      console.warn(
        `[attio] ${object} ${label}: dropped ${slug} - Attio would not accept the value (${errorMessage(error)}). The event continues without it.`,
      );
    }
  }
  if (dropped.length > 0) {
    console.warn(
      `[attio] ${object} ${label}: wrote ${written.length} attribute(s), dropped ${dropped.length} (${dropped.join(", ")})`,
    );
  }
  return { written, dropped };
}

//---------------------------------------------------------------------------------------------------------
//THE write path for attributes on an interested lead's records. All three interested workflows go through here.
//
//The rule it exists to enforce: third-party data fills gaps in Attio and never contradicts it. Someone who
//corrected a job title in the CRM must not find it replaced by whatever the provider still believes. The ONE
//exception is ALWAYS_OVERWRITE, where the run's own value is the newer truth by definition.
//
//FLOW: 1. `target` given as a record id -> read it, because what may be written depends on what is already
//there. 2. per candidate attribute: drop the empty ones, merge the multiselects, take the ALWAYS_OVERWRITE
//slugs whatever Attio holds, skip any other slug already populated. 3. nothing left -> no request. 4. otherwise
//write what remains, salvaging what Attio will take.
//
//USES: fetchRecord, patchRecord, recordDisplayName (lib/attio.ts); mergeMultiselect, isEmptyCandidate,
//ALWAYS_OVERWRITE, writeSalvagingRejections (this module).
//[PERF] One GET when handed an id, none when handed a record. Callers holding a record they just created or
//queried pass the record, so the common path costs a single PATCH.
//[STABILITY] Does not throw once the record is in hand - see writeSalvagingRejections. A read that fails still
//throws, because without knowing what the record holds there is no way to write without risking an overwrite.
//---------------------------------------------------------------------------------------------------------
export async function updateAttioAttributes(
  object: AttioObject,
  target: AttioRecord | string,
  candidate: AttioValues,
  recordName?: string,
): Promise<AttributeWriteResult> {
  const record = typeof target === "string" ? await fetchRecord(object, target) : target;
  const label = recordName ?? recordDisplayName(record) ?? record.id.record_id;

  const fillable: Record<string, unknown> = {};
  for (const [slug, value] of Object.entries(candidate)) {
    if (isEmptyCandidate(value)) continue;

    if (slug in MULTISELECT_READERS && Array.isArray(value)) {
      const strings = value.filter((entry): entry is string => typeof entry === "string");
      const merged = mergeMultiselect(record, slug, strings);
      if (merged) fillable[slug] = merged;
      continue;
    }
    //Populated means "Attio holds something here". A PATCH would replace the whole attribute rather than merge
    //into it, so anything already present is left strictly alone - unless the slug is one this run is entitled
    //to restate outright. See ALWAYS_OVERWRITE.
    if (!ALWAYS_OVERWRITE.has(slug) && record.populatedAttributes.has(slug)) continue;
    fillable[slug] = value;
  }

  return writeSalvagingRejections(object, record.id.record_id, fillable, label);
}
//#endregion

//#region mapping a lead onto Attio attributes
//---------------------------------------------------------------------------------------------------------
//Which provider field lands on which Attio slug. Pure, so the mapping is testable without a network, and in
//one place so a new provider inherits the whole thing by filling in an InterestedLead.
//A slug absent from these three objects is a slug these workflows never write.
//---------------------------------------------------------------------------------------------------------

/** [LOGIC] USES: automatedSourceLabel (lib/providers.ts); toDate, withoutEmpty (this module). Pure. */
export function personValuesFor(lead: InterestedLead, companyId: string | null = null): AttioValues {
  const values: Record<string, unknown> = {
    email_addresses: lead.emails,
    phone_numbers: lead.phones,
    linkedin: lead.linkedin,
    job_title: lead.jobTitle,
    description: lead.description,
    location: lead.location,
    campaign_name: lead.campaignName,
    date_added: toDate(lead.occurredAtMs),
    //The same string the Deal carries - see automatedSourceLabel (lib/providers.ts).
    lead_source: automatedSourceLabel(lead.provider),
  };
  if (lead.firstName || lead.lastName) {
    const firstName = lead.firstName ?? "";
    const lastName = lead.lastName ?? "";
    values.name = [
      { first_name: firstName, last_name: lastName, full_name: `${firstName} ${lastName}`.trim() },
    ];
  }
  //Offered whenever a company was resolved; updateAttioAttributes drops it if the person already has one.
  if (companyId) {
    values.company = { target_object: "companies", target_record_id: companyId };
  }
  return withoutEmpty(values);
}

/** [LOGIC] USES: toDomain, parsePostalAddress, toEmployeeRange, toArrBucket, withoutEmpty (this module). */
export function companyValuesFor(lead: InterestedLead): AttioValues {
  const domain = toDomain(lead.companyDomain ?? lead.website);
  return withoutEmpty({
    //A company found only by domain still needs a name, and the domain is the least wrong one available.
    name: lead.companyName ?? domain,
    domains: domain ? [domain] : [],
    primary_location: parsePostalAddress(lead.companyAddress),
    employee_range: toEmployeeRange(lead.employeeCount),
    estimated_arr_usd: toArrBucket(lead.annualRevenue),
  });
}

/** [LOGIC] USES: automatedSourceLabel (lib/providers.ts); toTimestamp, withoutEmpty (this module). Pure. */
export function dealValuesFor(lead: InterestedLead): AttioValues {
  return withoutEmpty({
    //The same string the Person carries - see automatedSourceLabel (lib/providers.ts).
    lead_source: automatedSourceLabel(lead.provider),
    campaign_name: lead.campaignName,
    email: lead.emails[0] ?? null,
    phone_number_7: lead.phones[0] ?? null,
    linkedin: lead.linkedin,
    website: lead.website,
    //Free text on the Deal, so these cross over exactly as the provider spelled them. The bucketed equivalents
    //live on the Company.
    industry: lead.industry,
    employees: lead.employeeCount,
    revenue: lead.annualRevenue,
    moved_to_interested_at: toTimestamp(lead.occurredAtMs),
  });
}
//#endregion

//#region company resolution and deal naming
export interface ResolvedCompany {
  readonly id: string;
  /** The name Attio holds, which is what the deal is named after - not what the provider called it. */
  readonly name: string | null;
}

//---------------------------------------------------------------------------------------------------------
//The company an interested lead belongs to, found or created, and enriched in passing.
//FLOW: 1. the person is already linked to one -> that one wins, whatever the provider says. 2. otherwise look
//it up by domain, then by exact name. 3. still nothing -> create one, but only if there is a name or a domain
//to create it from. 4. either way, fill its blank attributes.
//Step 1 is unconditional on purpose: a person's company in Attio is a human's judgement, and a provider's
//`companyName` string is not grounds for moving them.
//Step 3's guard is what keeps a cold Aircall dial from creating a company: with no contact in Aircall's address
//book there is no name, and a company record named after a phone number is worse than no company at all.
//USES: personCompanyId, fetchRecord, findCompanyByDomain, findCompanyByName, createCompany, recordDisplayName
//(lib/attio.ts); toDomain, companyValuesFor, updateAttioAttributes (this module).
//[DEBUG] Each branch logs which one it took, because "no company" and "the company Attio already had" produce
//very different deals and the difference is invisible afterwards.
//---------------------------------------------------------------------------------------------------------
export async function resolveInterestedCompany(
  lead: InterestedLead,
  person: AttioPerson,
): Promise<ResolvedCompany | null> {
  const linkedId = personCompanyId(person);
  if (linkedId) {
    const linked = await fetchRecord("companies", linkedId);
    console.log(
      `[lookup] company: person is already linked to ${recordDisplayName(linked) ?? linkedId}, which the deal will be named after`,
    );
    await updateAttioAttributes("companies", linked, companyValuesFor(lead));
    return { id: linkedId, name: recordDisplayName(linked) };
  }

  const domain = toDomain(lead.companyDomain ?? lead.website);
  const found = (await findCompanyByDomain(domain)) ?? (await findCompanyByName(lead.companyName));
  if (found) {
    await updateAttioAttributes("companies", found, companyValuesFor(lead));
    return { id: found.id.record_id, name: recordDisplayName(found) };
  }

  if (!lead.companyName && !domain) {
    console.log(
      `[lookup] company: none - neither Attio nor ${lead.provider} has a company for this lead, so none is created and the deal is named for an unknown company`,
    );
    return null;
  }
  const created = await createCompany(companyValuesFor(lead));
  return { id: created.id.record_id, name: recordDisplayName(created) };
}

//---------------------------------------------------------------------------------------------------------
//What a deal this codebase opens is called. Strictly "<company> - Interested", with no other form.
//The convention is strict so these deals are recognisable as a set and sort together, and so a person's name
//never becomes a deal name: a deal belongs to a company even when only one contact there is known.
//"Unknown Company" is used when neither Attio nor the provider names one, which is honest and, more usefully,
//greppable - those are exactly the deals needing a human to say who they are with.
//Deals that already existed are never renamed - see ensureInterestedDeal.
//USES: nothing. Pure.
//---------------------------------------------------------------------------------------------------------
export function interestedDealName(companyName: string | null): string {
  const name = companyName?.trim();
  return `${name ? name : "Unknown Company"} - Interested`;
}
//#endregion

//#region suppression
export interface SuppressionOutcome {
  readonly platform: string;
  readonly status: "suppressed" | "skipped" | "failed";
  readonly detail: string | null;
}

export interface SuppressionResult {
  readonly outcomes: readonly SuppressionOutcome[];
  /** One entry per platform that could not be suppressed. Empty means the lead is suppressed everywhere. */
  readonly failures: readonly string[];
}

//The Attio DNC list, prepended to the third-party channels. It lives here rather than in the register because
//it is the only channel that touches Attio, and keeping it here is what lets lib/providers.ts stay free of any
//Attio import. It is also the channel that governs Aircall dialling, which has no API of its own to call.
//[LOGIC] USES: addPersonToList, LISTS (lib/attio.ts).
const ATTIO_DNC_CHANNEL: SuppressionChannel = {
  platform: "attio DNC list",
  suppress: async (targets) => {
    await addPersonToList(targets.personId, LISTS.DNC, targets.personName);
    return { status: "suppressed" };
  },
};

//---------------------------------------------------------------------------------------------------------
//Stops every outbound channel contacting a lead who has already said yes. One function, called by every
//interested workflow, because interest is a fact about the person and not about the channel that found it: a
//lead who answers the phone must stop receiving the cold email sequence too, and the reverse. Suppressing only
//the channel that happened to report first is how a lead ends up pitched twice.
//
//Which channels exist is not decided here - see THIRD_PARTY_SUPPRESSION_CHANNELS (lib/providers.ts). A new
//outbound platform is appended there and is suppressed by this function from that moment, for every provider,
//with no change to this file or to any route.
//
//[STABILITY] Every channel is independent and a failure in one does not stop the others: half the platforms
//suppressed is strictly better than one suppressed and the rest untouched because the first threw. Failures are
//returned for the caller to report rather than raised, and no channel is retried.
//A channel that reports "skipped" is not a failure - it means the lead is not present on that platform to
//suppress, usually for want of the one identifier it works by.
//FLOW: 1. the Attio DNC channel, then every registered third-party one. 2. each is run inside its own try, so
//a throw becomes a recorded failure rather than an escaped one. 3. one summary line naming every outcome.
//[DEBUG] Every channel logs its own result and the summary repeats them together, so a half-suppressed lead is
//readable from one line rather than reconstructed from three.
//USES: ATTIO_DNC_CHANNEL (this module), THIRD_PARTY_SUPPRESSION_CHANNELS (lib/providers.ts),
//errorMessage (lib/json.js).
//---------------------------------------------------------------------------------------------------------
export async function suppressInterestedLead(targets: SuppressionTargets): Promise<SuppressionResult> {
  const channels = [ATTIO_DNC_CHANNEL, ...THIRD_PARTY_SUPPRESSION_CHANNELS];
  const outcomes: SuppressionOutcome[] = [];
  const failures: string[] = [];

  for (const channel of channels) {
    try {
      const result = await channel.suppress(targets);
      if (result.status === "skipped") {
        console.log(`[suppress] ${channel.platform}: skipped - ${result.reason}`);
        outcomes.push({ platform: channel.platform, status: "skipped", detail: result.reason });
        continue;
      }
      console.log(`[suppress] ${channel.platform}: suppressed${result.detail ? ` - ${result.detail}` : ""}`);
      outcomes.push({ platform: channel.platform, status: "suppressed", detail: result.detail ?? null });
    } catch (error) {
      const message = errorMessage(error);
      failures.push(`${channel.platform}: ${message}`);
      console.error(`[suppress] ${channel.platform}: FAILED - ${message}`);
      outcomes.push({ platform: channel.platform, status: "failed", detail: message });
    }
  }

  console.log(
    `[suppress] ${targets.personName}: ${outcomes.map((outcome) => `${outcome.platform} ${outcome.status}`).join(", ")}`,
  );
  return { outcomes, failures };
}
//#endregion

//#region the shared workflow
export interface InterestedWorkflow {
  readonly lead: InterestedLead;
  /**
   * How this provider identifies the person in Attio, in its own order of confidence - HeyReach leads with a
   * profile URL, Instantly and Aircall with an address. Returning null means no such person exists yet and one
   * is created from the lead.
   */
  readonly findPerson: () => Promise<AttioPerson | null>;
  /**
   * This provider's own message history, already rendered for the note. A thunk rather than a string because
   * fetching a thread costs a request, and it should not be paid until the lead is known to be recordable.
   */
  readonly history: () => Promise<string>;
  /** What this event is called in the logs - "poll call 4821", "heyreach-interested". */
  readonly subject: string;
}

export interface InterestedOutcome {
  readonly personId: string;
  readonly personName: string;
  readonly dealId: string;
  readonly companyId: string | null;
  readonly suppression: SuppressionResult;
}

//---------------------------------------------------------------------------------------------------------
//Records an interested lead in Attio. Every provider's route or cron ends here, and this is the whole of what
//they share - so a fourth platform needs an extractor, a lookup, and a note renderer, and inherits the rest.
//
//FLOW:
// 1. Resolve the person by the provider's own lookup order, creating one from the lead when there is no match.
// 2. resolveInterestedCompany - the company already linked to the person if there is one, else found by domain
//    or name, else created. This runs BEFORE the deal because the deal is named after it.
// 3. ensureInterestedDeal - reuses any deal already linked to the person whatever its stage, and only creates
//    one when none exists, named strictly by interestedDealName.
// 4. Note on the person and on the deal, carrying the provider's rendered history.
// 5. updateAttioAttributes on the person and the deal - fills blanks only, save for lead source, which is
//    restated to this run's channel whatever Attio already held. See ALWAYS_OVERWRITE.
// 6. suppressInterestedLead - Attio DNC plus every registered outbound platform.
//
//ORDERING is deliberate. The company precedes the deal because it names it. The notes precede the attribute
//writes because a note is the record of what happened and is worth having even if a later write fails. The
//suppression is last because it is the only step that writes outside Attio: if it throws, the CRM record it
//would otherwise have cost is already committed.
//
//[STABILITY] Every step is a separate API call with no transaction. A throw partway leaves the earlier writes
//committed. Callers treat that as a failed event and do not retry, because a retry would duplicate the notes.
//Step 6 is the exception: it collects its own failures instead of raising, so one unreachable platform cannot
//fail an event that Attio already recorded.
//
//USES: createPerson, personLabel, ensureInterestedDeal, defaultDealOwner, createNote (lib/attio.ts);
//leadSourceLabel (lib/providers.ts); resolveInterestedCompany, interestedDealName, personValuesFor,
//dealValuesFor, updateAttioAttributes, suppressInterestedLead (this module).
//The caller supplies findPerson and history; nothing else about a provider is visible from here.
//[DEBUG] Ends with one line naming the person, deal, and company, so an event reads as a single result.
//[RUN LOG] Wrapped in a transcript scope, which writes what happened here back to the Person as a note. It is
//additive and self-contained: see lib/run-log.ts. Removing it is this wrapper plus three lines below.
//---------------------------------------------------------------------------------------------------------
export async function recordInterestedLead(workflow: InterestedWorkflow): Promise<InterestedOutcome> {
  return withRunLog(workflow.lead.provider, () => runInterestedLead(workflow));
}

async function runInterestedLead(workflow: InterestedWorkflow): Promise<InterestedOutcome> {
  const { lead, subject } = workflow;

  let person = await workflow.findPerson();
  snapshotBefore(person);
  if (!person) person = await createPerson(personValuesFor(lead));
  const personId = person.id.record_id;
  const personName = personLabel(person);
  runLogTarget(personId, personName);

  const company = await resolveInterestedCompany(lead, person);
  runLogCompany(company);
  const deal = await ensureInterestedDeal(
    person,
    interestedDealName(company?.name ?? null),
    defaultDealOwner(),
    company?.id ?? null,
  );
  const dealId = deal.id.record_id;

  const history = await workflow.history();
  const title = leadSourceLabel(lead.provider);
  await createNote("people", personId, title, history, personName);
  await createNote("deals", dealId, title, history);

  await updateAttioAttributes("people", person, personValuesFor(lead, company?.id ?? null), personName);
  await updateAttioAttributes("deals", deal, dealValuesFor(lead));

  const suppression = await suppressInterestedLead({
    personId,
    personName,
    email: lead.emails[0] ?? null,
    profileUrl: lead.linkedin,
  });

  console.log(
    `[interested] ${subject}: completed - person ${personName}, deal ${dealId}, company ${company?.name ?? "none"}`,
  );
  return { personId, personName, dealId, companyId: company?.id ?? null, suppression };
}
//#endregion
