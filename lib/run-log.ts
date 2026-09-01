import { AsyncLocalStorage } from "node:async_hooks";
import { createNote, fetchRecord, type AttioPerson, type AttioRecord } from "./attio.js";
import { arrayValue, errorMessage, isJsonObject, numberValue, stringValue } from "./json.js";
import { providerDisplayName, type Provider } from "./providers.js";

//=============================================================================================================
//A transcript of one interested run, written back to the Person it was about.
//
//WHY THIS EXISTS. Everything these workflows decide is already logged, but the log lives in Vercel, keyed by
//invocation, and expires. The question actually asked afterwards is never "what happened in invocation
//dpl_xyz" - it is "why does THIS person look like this". That is a question about a record, so the answer
//belongs on the record: what Attio held before the run, every line the run printed, and what Attio held after.
//
//SELF-CONTAINED BY DESIGN. This module is additive. It imports from the codebase; nothing in the codebase
//imports from it except three one-line calls in recordInterestedLead (lib/interested.ts). Deleting this file,
//its test, and those three lines removes the feature completely and changes nothing else.
//
//INTERESTED RUNS ONLY, without any of the shared modules having to know. Capture is scoped to an open run -
//see withRunLog - and lib/attio.ts is equally the touchpoint crons' code. Those crons never open a scope, so
//their prints pass straight through and are never collected. Nothing needed splitting to achieve that.
//
//[STABILITY] NOTHING HERE MAY THROW INTO A RUN. This is diagnostics attached to an event Attio has already
//committed; losing the transcript is a nuisance, losing the event is a data problem. Every entry point either
//no-ops outside a scope or swallows its own failure onto console.
//=============================================================================================================

//#region the open run
//---------------------------------------------------------------------------------------------------------
//One run's transcript, being built. `before` holds the Person record as it was FOUND rather than a rendering
//of it, because the company name that makes a reference readable is not resolved until later in the run - so
//both states are rendered at the end, once, against the same names.
//---------------------------------------------------------------------------------------------------------
interface RunLogState {
  readonly provider: Provider;
  readonly startedAtMs: number;
  readonly lines: string[];
  /** Null until snapshotBefore runs; false there means no Person existed and there is no previous state. */
  existedBefore: boolean | null;
  before: AttioPerson | null;
  /** Set by runLogTarget. Until it is, there is no record to attach a note to. */
  personId: string | null;
  personName: string | null;
  /** Set by runLogCompany, purely so a company reference prints as a name rather than a record id. */
  companyId: string | null;
  companyName: string | null;
}

const RUN_LOG = new AsyncLocalStorage<RunLogState>();

//[PERF] Caps, so a pathological run cannot post a note large enough for Attio to reject. Both are far above a
//normal run, which prints on the order of thirty lines.
const MAX_LINES = 500;
const MAX_VALUE_CHARS = 200;
//#endregion

//#region mirroring the console
//---------------------------------------------------------------------------------------------------------
//Every console print made while a run is open is copied into that run's transcript.
//
//WHY MIRROR RATHER THAN CALL A RECORDER AT EACH SITE. The interested path prints from about sixty places
//across six modules. A recorder beside each one duplicates the message string sixty times, and two copies of a
//sentence drift the moment one is edited - a transcript that disagrees with the log is worse than no
//transcript. This way the existing prints are the single source, and neither can be edited without the other.
//
//Vercel's own output is untouched: the original is called first, with the same arguments, every time.
//
//[STABILITY] Installed on a refcount rather than per scope, because runs can overlap - the Aircall sync
//processes interested calls one after another inside a single invocation, and Vercel may run concurrent
//invocations in one instance. The refcount means the last scope to close is what restores the console, and
//AsyncLocalStorage is what keeps overlapping runs' lines apart. The exact original reference is restored, so a
//caller that swapped console.log itself - the unit tests do - gets its own function back rather than a wrapper.
//---------------------------------------------------------------------------------------------------------
type MirroredMethod = "log" | "warn" | "error";
type ConsolePrinter = (...parts: unknown[]) => void;

const MIRRORED_METHODS: readonly MirroredMethod[] = ["log", "warn", "error"];
//The prefix a mirrored line carries. console.log is the ordinary case and says nothing; the other two do.
const METHOD_PREFIX: Readonly<Record<MirroredMethod, string>> = { log: "", warn: "WARN ", error: "ERROR " };

let originalPrinters: Record<MirroredMethod, ConsolePrinter> | null = null;
let openScopes = 0;

/** [LOGIC] Wall-clock time of day to the millisecond. The date is in the note's own timestamp already. */
function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function record(method: MirroredMethod, parts: readonly unknown[]): void {
  const state = RUN_LOG.getStore();
  if (!state || state.lines.length >= MAX_LINES) return;
  const text = parts.map((part) => (part instanceof Error ? part.message : String(part))).join(" ");
  state.lines.push(`[${stamp()}] ${METHOD_PREFIX[method]}${text}`);
  if (state.lines.length === MAX_LINES) state.lines.push(`[${stamp()}] ... transcript truncated at ${MAX_LINES} lines`);
}

function installConsoleMirror(): void {
  openScopes += 1;
  if (originalPrinters) return;

  const originals = {} as Record<MirroredMethod, ConsolePrinter>;
  for (const method of MIRRORED_METHODS) {
    const original: ConsolePrinter = console[method];
    originals[method] = original;
    console[method] = (...parts: unknown[]): void => {
      original.apply(console, parts);
      record(method, parts);
    };
  }
  originalPrinters = originals;
}

function restoreConsoleMirror(): void {
  openScopes = Math.max(0, openScopes - 1);
  if (openScopes > 0 || !originalPrinters) return;
  for (const method of MIRRORED_METHODS) console[method] = originalPrinters[method];
  originalPrinters = null;
}
//#endregion

//#region reading a record back out
/** [LOGIC] `phone_numbers` reads as "phone numbers". Attio's slug is already the label, bar the underscores. */
function humanizeSlug(slug: string): string {
  return slug.replace(/_/g, " ");
}

function truncate(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}...` : value;
}

/** [LOGIC] Selects and statuses both nest their readable half one level down, under a differing key. */
function optionTitle(value: unknown): string | null {
  return isJsonObject(value) ? stringValue(value.title) : null;
}

/** [LOGIC] A structured location, in the order it would be written on an envelope. Null unless something is set. */
function describeLocation(value: Record<string, unknown>): string | null {
  const parts = ["line_1", "locality", "region", "postcode", "country_code"]
    .map((key) => stringValue(value[key]))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

//---------------------------------------------------------------------------------------------------------
//One Attio value object as a human would read it.
//
//Attio spells the scalar differently for every attribute type - `{ value }` for text, `{ email_address }` for
//an address, `{ option: { title } }` for a select, `{ target_record_id }` for a reference - so this walks the
//known spellings in order of how specific they are and falls back to the raw JSON for a type it has not been
//taught. The fallback is deliberate: an unfamiliar attribute printing as JSON is still evidence, whereas
//dropping it silently would misreport the record as not holding it at all.
//
//`names` is how a reference prints as something readable. It carries the run's own company, which is the only
//linked record whose name is known without spending a request; every other reference prints as its record id.
//USES: stringValue, numberValue, isJsonObject (lib/json.ts); optionTitle, describeLocation, truncate (this module).
//---------------------------------------------------------------------------------------------------------
function describeAttioValue(entry: unknown, names: ReadonlyMap<string, string>): string | null {
  if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") return String(entry);
  if (!isJsonObject(entry)) return null;

  const named =
    stringValue(entry.full_name) ??
    stringValue(entry.email_address) ??
    stringValue(entry.original_email_address) ??
    stringValue(entry.original_phone_number) ??
    stringValue(entry.phone_number) ??
    stringValue(entry.domain) ??
    stringValue(entry.root_domain) ??
    optionTitle(entry.option) ??
    optionTitle(entry.status) ??
    stringValue(entry.referenced_actor_name);
  if (named) return truncate(named);

  const location = describeLocation(entry);
  if (location) return truncate(location);

  const currency = numberValue(entry.currency_value);
  if (currency !== null) {
    const code = stringValue(entry.currency_code);
    return code ? `${currency} ${code}` : String(currency);
  }

  const reference = stringValue(entry.target_record_id) ?? stringValue(entry.referenced_actor_id);
  if (reference) return names.get(reference) ?? reference;

  const scalar = entry.value;
  if (typeof scalar === "string" || typeof scalar === "number" || typeof scalar === "boolean") {
    return truncate(String(scalar));
  }
  return truncate(JSON.stringify(entry));
}

//---------------------------------------------------------------------------------------------------------
//Every attribute the record actually holds, one per line, in the order Attio returned them.
//Attributes holding nothing are omitted rather than printed empty: the point of the two states is what
//CHANGED, and a hundred blank slugs on either side buries it.
//USES: arrayValue (lib/json.ts); describeAttioValue, humanizeSlug (this module).
//---------------------------------------------------------------------------------------------------------
function renderState(record: AttioRecord | null, names: ReadonlyMap<string, string>): string {
  if (!record) return "none";
  const lines: string[] = [];
  for (const slug of Object.keys(record.rawValues)) {
    const entries = arrayValue(record.rawValues, slug);
    if (entries.length === 0) continue;
    const values = entries
      .map((entry) => describeAttioValue(entry, names))
      .filter((value): value is string => value !== null && value.length > 0);
    if (values.length > 0) lines.push(`${humanizeSlug(slug)}: ${values.join(", ")}`);
  }
  return lines.length > 0 ? lines.join("\n") : "none";
}
//#endregion

//#region what the run records
//---------------------------------------------------------------------------------------------------------
//Opens a transcript for ONE interested lead and runs the workflow inside it.
//Scoped per lead rather than per invocation on purpose: the Aircall sync records several interested calls in a
//single invocation, and each is a separate person owed a separate note.
//The note is written in the finally, so a run that throws still leaves its transcript on the record - which is
//the run whose transcript is worth the most.
//USES: installConsoleMirror, restoreConsoleMirror, writeRunLogNote (this module).
//---------------------------------------------------------------------------------------------------------
export async function withRunLog<T>(provider: Provider, run: () => Promise<T>): Promise<T> {
  const state: RunLogState = {
    provider,
    startedAtMs: Date.now(),
    lines: [],
    existedBefore: null,
    before: null,
    personId: null,
    personName: null,
    companyId: null,
    companyName: null,
  };
  installConsoleMirror();
  try {
    return await RUN_LOG.run(state, async () => {
      try {
        return await run();
      } finally {
        await writeRunLogNote(state);
      }
    });
  } finally {
    restoreConsoleMirror();
  }
}

/**
 * [LOGIC] The Person as the run found it, BEFORE anything is written - null meaning no such Person existed and
 * one is about to be created. The record is kept rather than rendered; see RunLogState.
 * Outside a run this does nothing, which is what keeps the touchpoint crons out of the feature.
 */
export function snapshotBefore(person: AttioPerson | null): void {
  const state = RUN_LOG.getStore();
  if (!state) return;
  state.existedBefore = person !== null;
  state.before = person;
}

/** [LOGIC] The Person the transcript belongs to. Until this is called there is no record to attach a note to. */
export function runLogTarget(personId: string, personName: string): void {
  const state = RUN_LOG.getStore();
  if (!state) return;
  state.personId = personId;
  state.personName = personName;
}

/** [LOGIC] The run's own company, so `company: <name>` reads as a name on both states instead of a record id. */
export function runLogCompany(company: { readonly id: string; readonly name: string | null } | null): void {
  const state = RUN_LOG.getStore();
  if (!state) return;
  state.companyId = company?.id ?? null;
  state.companyName = company?.name ?? null;
}
//#endregion

//#region the transcript itself
export interface RunLogArtifact {
  readonly filename: string;
  readonly contentType: string;
  readonly body: string;
}

/** [LOGIC] Every name a reference in either state can be printed as. One entry today: the run's own company. */
function referenceNames(state: RunLogState): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  if (state.companyId && state.companyName) names.set(state.companyId, state.companyName);
  return names;
}

//---------------------------------------------------------------------------------------------------------
//The transcript as a file, built in memory.
//
//IN MEMORY BECAUSE THERE IS NOWHERE TO PUT IT. A Vercel function's filesystem is read-only bar /tmp, and /tmp
//goes with the instance and is reachable from nothing outside it - a file written there is neither durable nor
//retrievable. A file is a name, a type, and some bytes, and that is what this returns.
//
//It is also what a mail attachment or a Slack upload takes, which is the point of building it as a file at all
//rather than formatting a note directly: the day this is emailed or posted, the same call yields the same
//bytes the note already carries, and nothing here changes.
//
//`after` is passed in rather than read from the state because reading it costs a request and the caller is
//already holding the result. Returns null outside a run.
//USES: renderState, referenceNames (this module); providerDisplayName (lib/providers.ts).
//---------------------------------------------------------------------------------------------------------
export function runLogArtifact(after: AttioRecord | null): RunLogArtifact | null {
  const state = RUN_LOG.getStore();
  if (!state) return null;

  const names = referenceNames(state);
  const existed = state.existedBefore === true;
  const body = [
    `Record ${existed ? "did" : "did not"} exist before run.`,
    "",
    "**Previous state**",
    existed ? renderState(state.before, names) : "none",
    "",
    "**Run logs**",
    state.lines.length > 0 ? state.lines.join("\n") : "none",
    "",
    "**State after run**",
    //Distinguished from "none" on purpose: a record holding nothing and a record nobody could read are
    //opposite findings, and "none" would report the second as the first.
    after ? renderState(after, names) : "could not be read back after the run - see the transcript above",
  ].join("\n");

  const startedAt = new Date(state.startedAtMs).toISOString().replace(/[:.]/g, "-");
  return {
    filename: `run-log-${state.provider}-${state.personId ?? "unknown"}-${startedAt}.txt`,
    contentType: "text/plain; charset=utf-8",
    body,
  };
}

//---------------------------------------------------------------------------------------------------------
//Reads the Person back as the run left it and posts the transcript to it. Called once, by withRunLog.
//
//[STABILITY] Swallows everything. Both halves can fail independently and neither may reach the caller: the
//re-read because the run may have failed in a way that also breaks a read, the note because it is the last
//write of an event Attio has already committed. A failure here is reported to the log and nothing more.
//[DEBUG] A run that ends before a Person is resolved says so rather than passing silently - a missing note is
//otherwise indistinguishable from a run that never happened.
//USES: fetchRecord, createNote (lib/attio.ts); runLogArtifact (this module); providerDisplayName (lib/providers.ts).
//---------------------------------------------------------------------------------------------------------
async function writeRunLogNote(state: RunLogState): Promise<void> {
  if (!state.personId) {
    console.warn(
      `[run-log] ${state.provider}: no transcript written - the run ended before a person was resolved, so there is no record to attach it to`,
    );
    return;
  }

  let after: AttioRecord | null = null;
  try {
    after = await fetchRecord("people", state.personId);
  } catch (error) {
    console.error(`[run-log] ${state.provider}: could not re-read the person after the run - ${errorMessage(error)}`);
  }

  try {
    const artifact = runLogArtifact(after);
    if (!artifact) return;
    const title = `run logs for automated integration (${providerDisplayName(state.provider)} marked as interested)`;
    await createNote("people", state.personId, title, artifact.body, state.personName ?? state.personId);
  } catch (error) {
    console.error(`[run-log] ${state.provider}: the transcript could not be posted - ${errorMessage(error)}`);
  }
}
//#endregion
