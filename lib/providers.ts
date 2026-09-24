import { blockInstantlyLead } from "./instantly.js";
import { stopLeadInActiveCampaigns } from "./heyreach.js";
import { fetchOutfoundLead, markOutfoundThreadDnc } from "./outfound.js";

//=============================================================================================================
//The register of third-party platforms. Adding a fourth is meant to be an APPEND here plus its own extractor,
//and nothing else - no edit to the shared interested workflow, the Attio mapping, or the write path.
//
//Two registers, because a platform sits on two independent axes and a given one may be on either, both, or
//only one:
//
//  SOURCES      - platforms that can report a lead as interested. Aircall, Instantly, HeyReach and Outfound
//                 all do.
//  SUPPRESSION  - outbound platforms that must stop contacting a lead once any source reports interest.
//                 Instantly, HeyReach and Outfound are here; Aircall is NOT, because it is a phone system with
//                 no campaign or blocklist API and nothing to call.
//
//A new platform is added to whichever registers apply. Everything downstream is derived.
//=============================================================================================================

//#region sources
//---------------------------------------------------------------------------------------------------------
//Every platform that can report interest. `displayName` is the only thing a new entry has to decide, and it is
//load-bearing: the source strings written into Attio and the note titles are derived from it, so it must be
//spelled exactly as the business wants to read it in a report. Changing one afterwards changes what new
//records say without changing what old ones already say.
//
//The provider KEY is used for two other things, both by derivation and neither needing an edit here:
//  - the counter-slug environment variables, ATTIO_PERSON_<KEY>_COUNTER_SLUG and ATTIO_COMPANY_<KEY>_COUNTER_SLUG
//    (see counterSlug in attio.ts), which a new provider must have added to the deployment before it can run;
//  - the Supabase cursor key its sync uses, if it polls.
//---------------------------------------------------------------------------------------------------------
//[LOGIC] The register itself. Appending one line here is what adds a provider.
const SOURCES = {
  aircall: { displayName: "Aircall" },
  instantly: { displayName: "Instantly" },
  heyreach: { displayName: "HeyReach" },
  //Outfound is a warehouse over other sequencers rather than a sender of its own, so the emails it reports were
  //sent elsewhere. It is a source in its own right here because the mail it carries is mail no other configured
  //provider reads - see lib/outfound.ts.
  outfound: { displayName: "Outfound" },
} as const;

//=============================================================================================================
//Deal attribution: which discrete source each provider represents.
//
//WHY OPTION IDS AND NOT TITLES. Attio accepts either for a select - `[{ option: "Cold Email" }]` works just as
//well as `[{ option: "6cae752e-..." }]`. The ID is used because it survives a rename: someone relabelling
//"Cold Email" to "Cold Outbound Email" in the Attio UI keeps the same option_id, where a title write would
//start failing silently from that moment on with nothing in the code to say why.
//The trade is that these are unreadable, so each carries its title in a comment, and a live smoke test asserts
//every one of them still exists on the attribute - see tests/live/read-only.test.ts.
//
//SUB-SOURCE IS ABOUT WHOSE PLATFORM SENT IT, not which tool. Instantly and HeyReach are Levanta's own; Outfound
//is the SAS platform. Aircall is Levanta's dialler. A provider whose sub-source is null simply does not write
//the attribute.
//=============================================================================================================

/** The `deal_source_discrete` options, by title. Only the four these workflows can produce are named. */
const DEAL_SOURCE_OPTIONS = {
  COLD_EMAIL: "6cae752e-6395-478a-83aa-eb934479d7dd",
  COLD_CALL: "0696a0fc-425c-4ba5-9afb-2897b61ca3aa",
  LI_OUTBOUND: "9686ed43-60ba-454d-b5d4-70c0840f227f",
} as const;

/** The `outbound_sub_source_discrete` options, by title. */
const OUTBOUND_SUB_SOURCE_OPTIONS = {
  LEVANTA: "4763981c-5793-48dc-b878-c02e0231df13",
  SAS: "2cbbadd4-dca8-47cd-a6fb-6af4ae0eddee",
} as const;

export interface DealAttribution {
  /** Option ID for `deal_source_discrete`. */
  readonly source: string;
  /** Option ID for `outbound_sub_source_discrete`, or null to leave the attribute alone. */
  readonly subSource: string | null;
}

//[LOGIC] One entry per provider, checked against Provider so adding a fifth will not compile until it is
//attributed. That is deliberate: a new provider silently writing no source is the failure this prevents.
const DEAL_ATTRIBUTION: Readonly<Record<Provider, DealAttribution>> = {
  //George's dialler. Levanta's own.
  aircall: { source: DEAL_SOURCE_OPTIONS.COLD_CALL, subSource: OUTBOUND_SUB_SOURCE_OPTIONS.LEVANTA },
  //Levanta's own cold email.
  instantly: { source: DEAL_SOURCE_OPTIONS.COLD_EMAIL, subSource: OUTBOUND_SUB_SOURCE_OPTIONS.LEVANTA },
  //LinkedIn outbound, Levanta's own.
  heyreach: { source: DEAL_SOURCE_OPTIONS.LI_OUTBOUND, subSource: OUTBOUND_SUB_SOURCE_OPTIONS.LEVANTA },
  //Cold email arriving through the SAS platform rather than ours.
  outfound: { source: DEAL_SOURCE_OPTIONS.COLD_EMAIL, subSource: OUTBOUND_SUB_SOURCE_OPTIONS.SAS },
};

/** [LOGIC] How a deal from this provider is attributed. USES: DEAL_ATTRIBUTION (this module). Pure. */
export function dealAttribution(provider: Provider): DealAttribution {
  return DEAL_ATTRIBUTION[provider];
}

/** [LOGIC] Every option ID this codebase writes, for the live schema check. Pure. */
export function attributionOptionIds(): Readonly<Record<string, readonly string[]>> {
  return {
    deal_source_discrete: Object.values(DEAL_SOURCE_OPTIONS),
    outbound_sub_source_discrete: Object.values(OUTBOUND_SUB_SOURCE_OPTIONS),
  };
}

/** Derived from SOURCES, so appending an entry there is what adds a provider - there is no second list. */
export type Provider = keyof typeof SOURCES;

export const PROVIDERS: readonly Provider[] = Object.keys(SOURCES) as Provider[];

/** [LOGIC] USES: SOURCES (this module). Pure. */
export function providerDisplayName(provider: Provider): string {
  return SOURCES[provider].displayName;
}

/**
 * [LOGIC] The bare channel name - "<Name> Cold Outreach". One derivation for every provider, so a fourth
 * inherits the convention rather than adding a fourth hand-written string that could disagree with the other
 * three. This is the note TITLE and the stem automatedSourceLabel builds on; nothing writes it to an attribute.
 * USES: providerDisplayName (this module). Pure.
 */
export function leadSourceLabel(provider: Provider): string {
  return `${providerDisplayName(provider)} Cold Outreach`;
}

/**
 * [LOGIC] The source string written into Attio, on the Person and on the Deal alike. Every record these
 * workflows touch was produced without a human, and the "- Automated" suffix is what distinguishes it in
 * reporting from the same channel worked by hand - which is as true of the Person as it is of the Deal, so both
 * carry this rather than the Person carrying the bare channel name.
 *
 * NOT the same as leadSourceLabel, which is now the bare channel and is used only to TITLE the notes. A note
 * heading is read by a human in context, where the suffix says nothing the surrounding note does not.
 * USES: leadSourceLabel (this module). Pure.
 */
export function automatedSourceLabel(provider: Provider): string {
  return `${leadSourceLabel(provider)} - Automated`;
}
//#endregion

//#region suppression
/** Everything any suppression channel might need to identify a lead on its own platform. */
export interface SuppressionTargets {
  readonly personId: string;
  readonly personName: string;
  readonly email: string | null;
  /** A LinkedIn profile URL, whichever provider happened to supply it. */
  readonly profileUrl: string | null;
}

export type SuppressionChannelResult =
  //`detail` is folded into the summary log line - a count, an identifier, whatever the platform reports back.
  | { readonly status: "suppressed"; readonly detail?: string }
  //Not a failure: the lead simply is not present on this platform to suppress, usually for want of the one
  //identifier it works by. `reason` says which.
  | { readonly status: "skipped"; readonly reason: string };

export interface SuppressionChannel {
  /** Named in logs and in the failure list a route returns, so keep it recognisable. */
  readonly platform: string;
  readonly suppress: (targets: SuppressionTargets) => Promise<SuppressionChannelResult>;
}

//---------------------------------------------------------------------------------------------------------
//The outbound platforms silenced when any source reports interest. Order is priority: the channel most costly
//to leave running goes first, because each runs independently and a run may be cut short by a timeout.
//
//The Attio DNC list is NOT here. It is prepended by suppressInterestedLead (lib/interested.ts), which keeps
//this file free of any Attio import and this register purely about third parties.
//
//A new outbound platform is appended here with a function that suppresses one lead. It needs no other change:
//it is called for every interested lead whatever platform reported the interest, which is the point - interest
//is a fact about the person, not about the channel that noticed it first.
//[LOGIC] Each `suppress` may throw; suppressInterestedLead (lib/interested.ts) catches and records it, so a
//channel here never has to defend itself against its own failure.
//USES: blockInstantlyLead (lib/instantly.ts), stopLeadInActiveCampaigns (lib/heyreach.ts).
//---------------------------------------------------------------------------------------------------------
export const THIRD_PARTY_SUPPRESSION_CHANNELS: readonly SuppressionChannel[] = [
  {
    platform: "instantly blocklist",
    suppress: async (targets) => {
      if (!targets.email) {
        return { status: "skipped", reason: "the lead carried no email address to block" };
      }
      await blockInstantlyLead(targets.email);
      return { status: "suppressed" };
    },
  },
  {
    platform: "outfound DNC",
    suppress: async (targets) => {
      if (!targets.email) {
        return { status: "skipped", reason: "the lead carried no email address to suppress" };
      }
      //Outfound has no "add this address to DNC" call - only "mark this thread DNC" - so a thread has to be
      //found before anything can be suppressed. The lookup is keyed on the address and returns every thread the
      //lead appears in; marking one with dnc_type "email" suppresses the address across all of them.
      const lead = await fetchOutfoundLead(targets.email);
      const threadHash = lead?.conversations[0]?.threadHash;
      if (!threadHash) {
        return { status: "skipped", reason: "Outfound holds no thread for this address to mark" };
      }
      await markOutfoundThreadDnc(threadHash, targets.email);
      return { status: "suppressed", detail: `via thread ${threadHash}` };
    },
  },
  {
    platform: "heyreach campaigns",
    suppress: async (targets) => {
      if (!targets.profileUrl) {
        //StopLeadInCampaign is driven by leadUrl, so an email-only lead cannot be stopped even though the
        //campaign lookup would accept the address. Closing this needs the leadMemberId - see lib/heyreach.ts.
        return { status: "skipped", reason: "the lead carried no LinkedIn profile URL to stop" };
      }
      const { inCampaigns, removedFrom } = await stopLeadInActiveCampaigns(
        targets.profileUrl,
        targets.email,
      );
      //Both numbers, because either alone misreads. "0 campaign(s) stopped" sounded like a campaign had been
      //left running, when nothing here ever halts a campaign: it withdraws one lead from the ones still live.
      return {
        status: "suppressed",
        detail: `lead is in ${inCampaigns} campaign(s), removed from ${removedFrom}`,
      };
    },
  },
];
//#endregion
