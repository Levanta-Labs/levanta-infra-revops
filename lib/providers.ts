import { blockInstantlyLead } from "./instantly.js";
import { stopLeadInActiveCampaigns } from "./heyreach.js";

//=============================================================================================================
//The register of third-party platforms. Adding a fourth is meant to be an APPEND here plus its own extractor,
//and nothing else - no edit to the shared interested workflow, the Attio mapping, or the write path.
//
//Two registers, because a platform sits on two independent axes and a given one may be on either, both, or
//only one:
//
//  SOURCES      - platforms that can report a lead as interested. Aircall, Instantly, and HeyReach all do.
//  SUPPRESSION  - outbound platforms that must stop contacting a lead once any source reports interest.
//                 Instantly and HeyReach are here; Aircall is NOT, because it is a phone system with no
//                 campaign or blocklist API and nothing to call.
//
//A new platform is added to whichever registers apply. Everything downstream is derived.
//=============================================================================================================

//#region sources
//---------------------------------------------------------------------------------------------------------
//Every platform that can report interest. `displayName` is the only thing a new entry has to decide, and it is
//load-bearing: the Lead Source and Deal Source strings written into Attio are derived from it, so it must be
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
} as const;

/** Derived from SOURCES, so appending an entry there is what adds a provider - there is no second list. */
export type Provider = keyof typeof SOURCES;

export const PROVIDERS: readonly Provider[] = Object.keys(SOURCES) as Provider[];

/** [LOGIC] USES: SOURCES (this module). Pure. */
export function providerDisplayName(provider: Provider): string {
  return SOURCES[provider].displayName;
}

/**
 * [LOGIC] What a Person's Lead Source says. One derivation for every provider, so a fourth inherits the
 * convention rather than adding a fourth hand-written string that could disagree with the other three.
 * USES: providerDisplayName (this module). Pure.
 */
export function leadSourceLabel(provider: Provider): string {
  return `${providerDisplayName(provider)} Cold Outreach`;
}

/**
 * [LOGIC] What a Deal's Deal Source says - deliberately not the same string as the Person's Lead Source. A deal
 * records how it was opened, and every deal these workflows open was opened without a human: the "- Automated"
 * suffix is what distinguishes it in reporting from the same channel worked by hand.
 * USES: leadSourceLabel (this module). Pure.
 */
export function dealSourceLabel(provider: Provider): string {
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
    platform: "heyreach campaigns",
    suppress: async (targets) => {
      if (!targets.profileUrl) {
        //StopLeadInCampaign is driven by leadUrl, so an email-only lead cannot be stopped even though the
        //campaign lookup would accept the address. Closing this needs the leadMemberId - see lib/heyreach.ts.
        return { status: "skipped", reason: "the lead carried no LinkedIn profile URL to stop" };
      }
      const stopped = await stopLeadInActiveCampaigns(targets.profileUrl, targets.email);
      return { status: "suppressed", detail: `${stopped} campaign(s) stopped` };
    },
  },
];
//#endregion
