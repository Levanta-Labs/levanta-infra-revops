import { reportConfigEmail, reportConfigValue, requiredEnv } from "./env.js";
import { ATTIO_BASE, attioHeaders, credentialHint } from "./endpoints.js";
import {
  arrayValue,
  errorMessage,
  isJsonObject,
  numberValue,
  objectValue,
  responseJson,
  stringValue,
  type JsonObject,
} from "./json.js";

export const LISTS = {
  MASTER_TAM: "master_tam_list",
  DNC: "dnc",
} as const;

export type Provider = "aircall" | "instantly" | "heyreach";

export const LEAD_SOURCE_LABELS: Record<Provider, string> = {
  aircall: "Aircall Cold Outreach",
  instantly: "Instantly Cold Outreach",
  heyreach: "HeyReach Cold Outreach",
};
export type AttioObject = "people" | "companies" | "deals";

//Interfaces==============================================================================================

export interface AttioRecordReference {
  readonly target_object?: string;
  readonly target_record_id: string;
}

export interface AttioPerson {
  readonly id: {
    readonly record_id: string;
  };
  readonly values: {
    readonly associated_deals: readonly AttioRecordReference[];
    readonly company: readonly AttioRecordReference[];
    readonly name: readonly { readonly full_name: string | null }[];
  };
  // Attio returns every attribute as an array, so a non-empty array means "has a value"
  // regardless of the attribute's type. Used to fill only blanks and never overwrite.
  readonly populatedAttributes: ReadonlySet<string>;
}

export interface PersonNameInput {
  readonly first_name: string;
  readonly last_name: string;
  readonly full_name: string;
}

export interface CreatePersonValues {
  readonly email_addresses?: readonly string[];
  readonly phone_numbers?: readonly string[];
  readonly linkedin?: string;
  readonly name?: readonly PersonNameInput[];
}

export interface PatchPersonValues extends CreatePersonValues {
  readonly lead_source?: string;
}

//============================================================================================================

export class AttioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "AttioApiError";
  }
}

//---------------------------------------------------------------------------------------------------------
//Single transport for every Attio call in the codebase. Nothing else calls fetch against Attio.
//FLOW: 1. prefix the path with ATTIO_BASE. 2. merge attioHeaders (endpoints.ts) under any caller override.
//3. parse the body with responseJson (json.ts). 4. non-2xx -> throw AttioApiError carrying status and body.
//[SECURITY] The bearer token is read from env per request by attioHeaders and never cached in module state.
//[DEBUG] credentialHint appends the env var name to a 401/403; the typed status lets incrementCounter tell a
//bad attribute slug (400/404) apart from a transport failure.
//---------------------------------------------------------------------------------------------------------
export async function attioFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${ATTIO_BASE}${path}`, {
    ...options,
    headers: { ...attioHeaders(), ...options.headers },
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new AttioApiError(
      `Attio API error ${response.status}: ${JSON.stringify(body)}${credentialHint("attio", response.status)}`,
      response.status,
      body,
    );
  }
  return body;
}

//=============================================================================================================
//parce functions, turns raw pull from attio (json) into usable data
//=============================================================================================================

//#region helper functions
function parseRecordReference(value: unknown): AttioRecordReference | null {
  if (!isJsonObject(value)) return null;
  const recordId = stringValue(value.target_record_id);
  if (!recordId) return null;
  const targetObject = stringValue(value.target_object);
  return targetObject
    ? { target_object: targetObject, target_record_id: recordId }
    : { target_record_id: recordId };
}

function parseReferences(values: JsonObject, key: string): readonly AttioRecordReference[] {
  //Unreadable entries are dropped rather than throwing: one malformed reference should not void the record.
  return arrayValue(values, key)
    .map(parseRecordReference)
    .filter((value): value is AttioRecordReference => value !== null);
}

//#endregion

//#region master methode
//---------------------------------------------------------------------------------------------------------
//Turns one raw Attio person record into the shape the rest of the codebase uses.
//FLOW: 1. require id.record_id and values. 2. read the linked deals and company as references. 3. read names.
//4. record which attribute slugs hold anything at all, for blankPersonValues.
//Step 4 is type-agnostic on purpose: Attio wraps every attribute in an array whatever its type, so a non-empty
//array is the only "has a value" test that works across text, references, and counters alike.
//---------------------------------------------------------------------------------------------------------
export function parseAttioPerson(value: unknown): AttioPerson {
  if (!isJsonObject(value)) throw new Error("Attio returned an invalid person record");
  const id = objectValue(value, "id");
  const values = objectValue(value, "values");
  const recordId = id ? stringValue(id.record_id) : null;
  if (!recordId || !values) throw new Error("Attio person record is missing id or values");

  const names = arrayValue(values, "name")
    .map((name) => {
      if (!isJsonObject(name)) return null;
      return { full_name: stringValue(name.full_name) };
    })
    .filter((name): name is { readonly full_name: string | null } => name !== null);

  const populatedAttributes = new Set(
    Object.keys(values).filter((slug) => arrayValue(values, slug).length > 0),
  );

  return {
    id: { record_id: recordId },
    values: {
      associated_deals: parseReferences(values, "associated_deals"),
      company: parseReferences(values, "company"),
      name: names,
    },
    populatedAttributes,
  };
}

/**
 * Keeps only the candidate values whose attribute is currently blank on the person,
 * so third-party data fills gaps without ever overwriting what Attio already holds.
 */
export function blankPersonValues(
  person: AttioPerson,
  candidate: PatchPersonValues,
): PatchPersonValues {
  const fillable: Record<string, unknown> = {};
  for (const [slug, value] of Object.entries(candidate)) {
    if (value === undefined) continue;
    //Populated means "Attio holds something here". A PATCH would replace the whole attribute, not merge into
    //it, so anything already present is left strictly alone.
    if (person.populatedAttributes.has(slug)) continue;
    fillable[slug] = value;
  }
  return fillable as PatchPersonValues;
}
//#endregion

//============================================================================================================

function responseData(value: unknown): unknown {
  if (!isJsonObject(value) || !("data" in value)) {
    throw new Error("Attio response is missing data");
  }
  return value.data;
}

//=============================================================================================================
//          Match Data From Thrid Party Records To Record ID In Attio
//=============================================================================================================

//---------------------------------------------------------------------------------------------------------
//One filtered person query. The three exported wrappers below differ only in the attribute searched.
//FLOW: 1. no value -> no query. 2. POST the filter, limit 1. 3. no hit -> null. 4. hit -> parseAttioPerson.
//[DEBUG] Every branch logs, including the misses. A lookup that quietly returns null is the usual cause of a
//touchpoint vanishing, so the searched attribute and value are named in the log line.
//NOTE: those log lines carry the business identifier - an address, number, or profile URL. Not credentials,
//but personal data in a retained log.
//---------------------------------------------------------------------------------------------------------
async function findPerson(attribute: string, value: string | null): Promise<AttioPerson | null> {
  if (!value) {
    console.log(`[lookup] person by ${attribute}: skipped - no value to search for`);
    return null;
  }
  const response = await attioFetch("/objects/people/records/query", {
    method: "POST",
    body: JSON.stringify({ filter: { [attribute]: value }, limit: 1 }),
  });
  const data = responseData(response);
  if (!Array.isArray(data)) throw new Error("Attio person query returned invalid data");
  if (data[0] === undefined) {
    console.log(`[lookup] person by ${attribute} ${JSON.stringify(value)}: no match`);
    return null;
  }
  const person = parseAttioPerson(data[0]);
  console.log(`[lookup] person by ${attribute} ${JSON.stringify(value)}: matched ${personLabel(person)}`);
  return person;
}

export function findPersonByEmail(email: string | null): Promise<AttioPerson | null> {
  return findPerson("email_addresses", email);
}

export function findPersonByPhone(phone: string | null): Promise<AttioPerson | null> {
  //Callers must pass E.164: Attio matches on the stored form, not on a punctuated display number.
  return findPerson("phone_numbers", phone);
}

export function findPersonByLinkedIn(profileUrl: string | null): Promise<AttioPerson | null> {
  return findPerson("linkedin", profileUrl);
}

//=============================================================================================================

//============================================================================================================
//push to attio
//
//Every write reports what it did, so a run can be read back action by action from the logs. A failure names the
//action before the error propagates, which is the difference between "the sync broke" and "the note on person X
//could not be created".
//
//A record is logged by the name it carries in Attio, so a run reads as a list of people rather than a list of
//identifiers. Only the name is logged, never the rest of the record's contents. The caller supplies that name,
//because it is the caller that holds the record: the helpers below are handed an id, and a helper that has only
//an id logs the id rather than spending a request to resolve a name for a log line. The exception is
//incrementCounter, which has to read the record anyway and so takes the name off a response already paid for.
//============================================================================================================

/** [DEBUG] Wraps one write so the log says whether it happened. Re-throws unchanged; changes no control flow. */
async function withAction<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    console.log(`[action] ${action}`);
    return result;
  } catch (error) {
    console.error(`[action] FAILED, did not happen - ${action}: ${errorMessage(error)}`);
    throw error;
  }
}

/** Creates a person and returns it parsed, so the caller has both the new ID and its populated-attribute set. */
export async function createPerson(values: CreatePersonValues): Promise<AttioPerson> {
  //Not withAction: the log line needs the created record's name, which only exists after the response parses.
  try {
    const response = await attioFetch("/objects/people/records", {
      method: "POST",
      body: JSON.stringify({ data: { values } }),
    });
    const person = parseAttioPerson(responseData(response));
    console.log(`[action] person created: ${personLabel(person)}`);
    return person;
  } catch (error) {
    console.error(`[action] FAILED - person could not be created: ${errorMessage(error)}`);
    throw error;
  }
}

/** Writes the given attributes. Callers pass blankPersonValues output, so this never overwrites existing data. */
export async function patchPerson(
  personId: string,
  values: PatchPersonValues,
  personName: string = personId,
): Promise<void> {
  const slugs = Object.keys(values);
  //An empty patch means every candidate attribute was already populated. Skip the request, log the reason.
  if (slugs.length === 0) {
    console.log(`[action] person ${personName} not updated - no attributes needed writing`);
    return;
  }
  await withAction(`person ${personName} updated: ${slugs.join(", ")}`, () =>
    attioFetch(`/objects/people/records/${personId}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values } }),
    }),
  );
}

//---------------------------------------------------------------------------------------------------------
//List-membership test. The three touchpoint crons gate every write on this returning true for Master TAM.
//FLOW: 1. read the person's list entries. 2. match the slug in either spelling Attio uses for it.
//[PERF] One request per person per event, uncached.
//---------------------------------------------------------------------------------------------------------
export async function isPersonInList(
  personId: string,
  listSlug: string,
  personName: string = personId,
): Promise<boolean> {
  const response = await attioFetch(`/objects/people/records/${personId}/entries`);
  const data = responseData(response);
  if (!Array.isArray(data)) throw new Error("Attio list entries response is invalid");
  //Attio returns the slug as list_id.slug on some entries and list_api_slug on others; accept both.
  const member = data.some((entry) => {
    if (!isJsonObject(entry)) return false;
    const listId = objectValue(entry, "list_id");
    return stringValue(listId?.slug) === listSlug || stringValue(entry.list_api_slug) === listSlug;
  });
  console.log(`[lookup] person ${personName} ${member ? "is" : "is NOT"} on list ${listSlug}`);
  return member;
}

/** PUT asserts the entry, so re-adding an already-listed person is a no-op rather than a duplicate. */
export async function addPersonToList(
  personId: string,
  listSlug: string,
  personName: string = personId,
): Promise<void> {
  await withAction(`person ${personName} added to list ${listSlug}`, () =>
    attioFetch(`/lists/${listSlug}/entries`, {
      method: "PUT",
      body: JSON.stringify({
        data: { parent_record_id: personId, parent_object: "people", entry_values: {} },
      }),
    }),
  );
}

/** Appends a note. Attio has no upsert for notes, so calling twice produces two notes. */
export async function createNote(
  parentObject: AttioObject,
  parentRecordId: string,
  title: string,
  content: string,
  parentName: string = parentRecordId,
): Promise<void> {
  await withAction(`note added to ${parentObject} ${parentName} (${JSON.stringify(title)})`, () =>
    attioFetch("/notes", {
      method: "POST",
      body: JSON.stringify({
        data: {
          parent_object: parentObject,
          parent_record_id: parentRecordId,
          title,
          format: "markdown",
          content,
        },
      }),
    }),
  );
}

/** Reads one counter attribute off a fetched record. Absent means zero; present but non-numeric is a config error. */
function parseCounterValue(value: unknown, attributeSlug: string): number {
  const data = responseData(value);
  if (!isJsonObject(data)) throw new Error("Attio record response is invalid");
  const values = objectValue(data, "values");
  if (!values) throw new Error("Attio record values are missing");
  const first = arrayValue(values, attributeSlug)[0];
  if (first === undefined) return 0;
  if (!isJsonObject(first)) throw new Error(`Attio counter ${attributeSlug} is invalid`);
  const counter = numberValue(first.value);
  if (counter === null) throw new Error(`Attio counter ${attributeSlug} is not numeric`);
  return counter;
}

/**
 * The name on a record we have already fetched. Attio spells the attribute two ways - a person's name is
 * structured (`full_name`), a company's is a plain text `value` - and either may be absent. Returns null rather
 * than throwing on any shape it does not recognise: a log line is not worth failing a write over.
 */
function fetchedRecordName(record: unknown): string | null {
  if (!isJsonObject(record)) return null;
  const data = record.data;
  if (!isJsonObject(data)) return null;
  const values = objectValue(data, "values");
  if (!values) return null;
  const first = arrayValue(values, "name")[0];
  if (!isJsonObject(first)) return null;
  return stringValue(first.full_name) ?? stringValue(first.value);
}

//---------------------------------------------------------------------------------------------------------
//Raises a counter attribute by one. Read-then-write, because Attio exposes no atomic increment.
//FLOW: 1. GET the record. 2. take its name off that response for the log. 3. parseCounterValue. 4. PATCH
//current+1. 5. on failure, name the slug when the status suggests the attribute itself is wrong.
//[STABILITY] Two concurrent runs against one record would both read the same value and one increment would be
//lost. Nothing guards against overlapping invocations of the same sync.
//[DEBUG] A 400 or 404 here almost always means the ATTIO_*_COUNTER_SLUG env value does not name a real
//attribute on that object, so the log says so explicitly rather than reporting a bare API error.
//---------------------------------------------------------------------------------------------------------
export async function incrementCounter(
  objectType: Exclude<AttioObject, "deals">,
  recordId: string,
  attributeSlug: string,
  recordName: string = recordId,
): Promise<void> {
  //The current value has to be read before it can be raised, and that response carries the record's name. Taking
  //the name from it is what lets a company - whose name no caller here has in hand - be logged by name without a
  //request of its own. Until that read returns, the caller's name is all there is to report a failure by.
  let label = recordName;
  try {
    const record = await attioFetch(`/objects/${objectType}/records/${recordId}`);
    label = fetchedRecordName(record) ?? recordName;
    const current = parseCounterValue(record, attributeSlug);
    await attioFetch(`/objects/${objectType}/records/${recordId}`, {
      method: "PATCH",
      body: JSON.stringify({ data: { values: { [attributeSlug]: current + 1 } } }),
    });
    console.log(
      `[action] counter ${attributeSlug} on ${objectType} ${label}: ${current} -> ${current + 1}`,
    );
  } catch (error) {
    console.error(
      `[action] FAILED - counter ${attributeSlug} on ${objectType} ${label}: ${errorMessage(error)}`,
    );
    if (error instanceof AttioApiError && (error.status === 400 || error.status === 404)) {
      console.warn(
        `[slug] Attio returned ${error.status} while incrementing ${JSON.stringify(attributeSlug)} on ${objectType} - either that record is gone or no such attribute exists on the ${objectType} object. Counter slugs come from the ATTIO_PERSON_* and ATTIO_COMPANY_*_COUNTER_SLUG values logged above.`,
      );
    }
    throw error;
  }
}

//---------------------------------------------------------------------------------------------------------
//Returns the deal to attach interested history to, creating one only when the person has none.
//FLOW: 1. person already linked to a deal -> return it. 2. otherwise create at stage Interested, owned by
//ownerEmail, linked to the person and to their company when one exists.
//Step 1 is deliberately stage-blind: any existing deal is reused whatever phase it sits in, so an interested
//signal updates the live deal rather than opening a second one alongside it.
//USES: attioFetch (this module); ownerEmail comes from defaultDealOwner below.
//---------------------------------------------------------------------------------------------------------
export async function ensureInterestedDeal(
  person: AttioPerson,
  dealNameHint: string,
  ownerEmail: string,
): Promise<string> {
  const existing = person.values.associated_deals[0]?.target_record_id;
  if (existing) {
    console.log(`[action] deal reused: deal ${existing} is already associated with person ${personLabel(person)}`);
    return existing;
  }

  //A person with no linked company still gets a deal; the association is simply omitted.
  const companyId = person.values.company[0]?.target_record_id;
  const dealName = dealNameHint || "New Interested Deal";
  try {
    const response = await attioFetch("/objects/deals/records", {
      method: "POST",
      body: JSON.stringify({
        data: {
          values: {
            name: dealName,
            stage: "Interested",
            owner: ownerEmail,
            associated_people: [
              { target_object: "people", target_record_id: person.id.record_id },
            ],
            ...(companyId
              ? {
                  associated_company: {
                    target_object: "companies",
                    target_record_id: companyId,
                  },
                }
              : {}),
          },
        },
      }),
    });
    const data = responseData(response);
    if (!isJsonObject(data)) throw new Error("Attio deal response is invalid");
    const id = objectValue(data, "id");
    const dealId = stringValue(id?.record_id);
    if (!dealId) throw new Error("Attio deal response is missing record_id");
    console.log(
      `[action] deal created: ${JSON.stringify(dealName)} for person ${personLabel(person)}${companyId ? ` and company ${companyId}` : " with no associated company"}`,
    );
    return dealId;
  } catch (error) {
    console.error(
      `[action] FAILED - deal could not be created for person ${personLabel(person)}: ${errorMessage(error)}`,
    );
    throw error;
  }
}

export function personDisplayName(person: AttioPerson): string | null {
  return person.values.name[0]?.full_name ?? null;
}

/** What a person is called in the logs: their name, or their record id when Attio holds no name for them. */
export function personLabel(person: AttioPerson): string {
  return personDisplayName(person) ?? person.id.record_id;
}

export function personCompanyId(person: AttioPerson): string | null {
  return person.values.company[0]?.target_record_id ?? null;
}

//Counter attribute slugs. Both scopes are configured rather than hardcoded: the Attio attribute names have already
//diverged once (the Company HeyReach counter is not the same slug as the Person one), and renaming an attribute in
//Attio should not require a redeploy. A missing value throws rather than defaulting, because a wrong slug would
//silently write a counter nobody reads.

function counterSlug(scope: "PERSON" | "COMPANY", provider: Provider): string {
  const envName = `ATTIO_${scope}_${provider.toUpperCase()}_COUNTER_SLUG`;
  const slug = requiredEnv(envName);
  //[DEBUG] Not a secret, so the resolved slug is printed in full once per process to make a typo visible.
  reportConfigValue(envName, slug);
  return slug;
}

export function personCounterSlug(provider: Provider): string {
  return counterSlug("PERSON", provider);
}

export function companyCounterSlug(provider: Provider): string {
  return counterSlug("COMPANY", provider);
}

/** Single accessor for the deal owner so the configured address is reported once, by domain only. */
export function defaultDealOwner(): string {
  const owner = requiredEnv("ATTIO_DEFAULT_DEAL_OWNER");
  //[SECURITY] Domain only. Enough to spot the wrong workspace without publishing a mailbox to the logs.
  reportConfigEmail("ATTIO_DEFAULT_DEAL_OWNER", owner);
  return owner;
}
