import { requiredEnv } from "./env.ts";
import { ATTIO_BASE, attioHeaders } from "./endpoints.ts";
import {
  arrayValue,
  isJsonObject,
  numberValue,
  objectValue,
  responseJson,
  stringValue,
  type JsonObject,
} from "./json.ts";

export const LISTS = {
  MASTER_TAM: "master_tam_list",
  DNC: "dnc",
} as const;

export const PERSON_COUNTER_SLUGS = {
  aircall: "number_of_calls",
  instantly: "number_of_emails",
  heyreach: "number_of_dms",
} as const;

export const LEAD_SOURCE_LABELS = {
  aircall: "Aircall Cold Outreach",
  instantly: "Instantly Cold Outreach",
  heyreach: "HeyReach Cold Outreach",
} as const;

export type Provider = keyof typeof PERSON_COUNTER_SLUGS;
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

export async function attioFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${ATTIO_BASE}${path}`, {
    ...options,
    headers: { ...attioHeaders(), ...options.headers },
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new AttioApiError(
      `Attio API error ${response.status}: ${JSON.stringify(body)}`,
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
  return arrayValue(values, key)
    .map(parseRecordReference)
    .filter((value): value is AttioRecordReference => value !== null);
}

//#endregion

//#region master methode
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

async function findPerson(attribute: string, value: string | null): Promise<AttioPerson | null> {
  if (!value) return null;
  const response = await attioFetch("/objects/people/records/query", {
    method: "POST",
    body: JSON.stringify({ filter: { [attribute]: value }, limit: 1 }),
  });
  const data = responseData(response);
  if (!Array.isArray(data)) throw new Error("Attio person query returned invalid data");
  return data[0] === undefined ? null : parseAttioPerson(data[0]);
}

export function findPersonByEmail(email: string | null): Promise<AttioPerson | null> {
  return findPerson("email_addresses", email);
}

export function findPersonByPhone(phone: string | null): Promise<AttioPerson | null> {
  return findPerson("phone_numbers", phone);
}

export function findPersonByLinkedIn(profileUrl: string | null): Promise<AttioPerson | null> {
  return findPerson("linkedin", profileUrl);
}

//=============================================================================================================

export async function getPerson(personId: string): Promise<AttioPerson> {
  return parseAttioPerson(responseData(await attioFetch(`/objects/people/records/${personId}`)));
}

//============================================================================================================
//push to attio
//============================================================================================================

export async function createPerson(values: CreatePersonValues): Promise<AttioPerson> {
  const response = await attioFetch("/objects/people/records", {
    method: "POST",
    body: JSON.stringify({ data: { values } }),
  });
  return parseAttioPerson(responseData(response));
}

export async function patchPerson(personId: string, values: PatchPersonValues): Promise<void> {
  if (Object.keys(values).length === 0) return;
  await attioFetch(`/objects/people/records/${personId}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { values } }),
  });
}

export async function isPersonInList(personId: string, listSlug: string): Promise<boolean> {
  const response = await attioFetch(`/objects/people/records/${personId}/entries`);
  const data = responseData(response);
  if (!Array.isArray(data)) throw new Error("Attio list entries response is invalid");
  return data.some((entry) => {
    if (!isJsonObject(entry)) return false;
    const listId = objectValue(entry, "list_id");
    return stringValue(listId?.slug) === listSlug || stringValue(entry.list_api_slug) === listSlug;
  });
}

export async function addPersonToList(personId: string, listSlug: string): Promise<void> {
  await attioFetch(`/lists/${listSlug}/entries`, {
    method: "PUT",
    body: JSON.stringify({
      data: { parent_record_id: personId, parent_object: "people", entry_values: {} },
    }),
  });
}

export async function createNote(
  parentObject: AttioObject,
  parentRecordId: string,
  title: string,
  content: string,
): Promise<void> {
  await attioFetch("/notes", {
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
  });
}

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

export async function incrementCounter(
  objectType: Exclude<AttioObject, "deals">,
  recordId: string,
  attributeSlug: string,
): Promise<void> {
  const current = parseCounterValue(
    await attioFetch(`/objects/${objectType}/records/${recordId}`),
    attributeSlug,
  );
  await attioFetch(`/objects/${objectType}/records/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { values: { [attributeSlug]: current + 1 } } }),
  });
}

export async function ensureInterestedDeal(
  person: AttioPerson,
  dealNameHint: string,
  ownerEmail: string,
): Promise<string> {
  const existing = person.values.associated_deals[0]?.target_record_id;
  if (existing) return existing;

  const companyId = person.values.company[0]?.target_record_id;
  const response = await attioFetch("/objects/deals/records", {
    method: "POST",
    body: JSON.stringify({
      data: {
        values: {
          name: dealNameHint || "New Interested Deal",
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
  return dealId;
}

export function personDisplayName(person: AttioPerson): string | null {
  return person.values.name[0]?.full_name ?? null;
}

export function personCompanyId(person: AttioPerson): string | null {
  return person.values.company[0]?.target_record_id ?? null;
}

export function companyCounterSlug(provider: Provider): string {
  return requiredEnv(`ATTIO_COMPANY_${provider.toUpperCase()}_COUNTER_SLUG`);

}
