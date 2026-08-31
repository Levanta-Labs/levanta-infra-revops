<br />
<p align="center">
  <img src="assets/logo.svg" alt="Levanta Labs logo">
</p>
<br />

# Levanta RevOps Infrastructure

Levanta RevOps infrastructure keeps Attio aligned with interested-lead and sales-touchpoint activity from Aircall, Instantly, and HeyReach.

## Quickstart

Install the Bun dependencies and run the strict compiler plus unit suite:

```sh
bun install
bun run check
```

The project runs on Bun `1.x`; `packageManager` pins `1.3.13` for local installs, and `vercel.json` selects the
`1.x` runtime (Vercel accepts only `1.x` or `1.4.x` there, so the exact patch cannot be pinned in both places).
Configure local integrations by copying `.env.example` to `.env.local` and supplying the required credentials before invoking a webhook or cron route.

## How CRM activity is synchronized

The Vercel functions handle two workflows:

1. Interested events resolve an Attio Person, resolve or create their Company, ensure an Interested Deal exists,
   write source-history notes, fill blank attributes on all three records, and suppress the lead on every
   outbound platform.
2. Cron jobs poll each provider for new touchpoints - Instantly and HeyReach every five minutes, Aircall every ten. They process only People on the Master TAM list, increment the configured counters, mirror notes to associated Companies, and persist cursor progress in Supabase.

The three syncs do not write the same records, by design:

| Sync | Person note | Person counter | Company note | Company counter |
| --- | --- | --- | --- | --- |
| Instantly | yes | yes | yes | yes |
| HeyReach | yes | yes | yes | yes |
| Aircall | **no** | yes | yes | yes |

An Aircall touchpoint deliberately writes no Person note, because the call and its recording already live in Aircall
and the Person only needs the count. The note exists on the Company as the roll-up view. A consequence worth knowing:
an Aircall touchpoint for a Person with no associated Company records only the counter increment.

### The interested workflow is shared, and cannot overwrite

All three providers converge on `recordInterestedLead` in `lib/interested.ts`. Each provider contributes only
three things - how it parses its own payload, how it looks a Person up in Attio, and how it renders its own
message history into a note. Everything after that is one code path:

| Step | What it does |
| --- | --- |
| 1. Person | The provider's own lookup order, creating a Person from the lead when there is no match |
| 2. Company | The Company already linked to the Person if there is one, else found by domain then by exact name, else created - but only when a name or domain exists to create it from |
| 3. Deal | Any Deal already linked to the Person is reused whatever its stage; a new one is opened only when there is none, named strictly `<company> - Interested` |
| 4. Notes | The provider's rendered history, on the Person and on the Deal |
| 5. Attributes | `updateAttioAttributes` on the Person and the Deal |
| 6. Suppression | The Attio DNC list plus every registered outbound platform |

**Nothing overwrites.** `updateAttioAttributes` reads what a record already holds and writes only the
attributes that are blank, so third-party data fills gaps and never contradicts the CRM. Someone who corrected
a job title in Attio will not find it replaced by whatever the provider still believes.

The one exception is the multiselect attributes - `email_addresses`, `phone_numbers`, `domains`. A PATCH replaces
an attribute wholesale rather than appending to it, so for these the existing entries are read and sent back
alongside the new one. A second address for a lead is additive information, and skipping the write outright is
what previously dropped it. If any existing entry cannot be read back in full, the attribute is declined
outright rather than risking a write that would delete real data.

Values that will not fit an Attio attribute are dropped rather than guessed at: a headcount or revenue figure
that does not parse, a "website" that is not really a domain, a postal address whose country does not resolve to
an ISO code. A blank attribute is recoverable; a confidently wrong value in a CRM that nothing will ever
overwrite is not.

**A rejected attribute cannot fail the event.** Attributes are written as one PATCH, which is the only request
usually made. If Attio rejects that write on its *content* - a `400` or `422`, meaning some value it will not
accept - the attributes are retried one at a time so that one bad value costs only itself, and whatever is still
rejected is dropped. A rejection that is not about content (`401`, `404`, a `5xx`, a transport failure) is not
retried, because no single attribute caused it and N further attempts would fail identically.

Either way the step does not raise. By the time attributes are written the Person, Company, Deal, and notes are
already committed, and losing all of that because one provider value would not fit an Attio attribute is a far
worse outcome than a blank field. What was dropped is logged under `[attio]` - an attribute silently missing with
no record of why is undiagnosable. The one part that still raises is the *read*: without knowing what a record
already holds there is no way to write to it without risking an overwrite.

### Interest on one platform means suppression on all of them

Interest is a fact about the person, not about the channel that noticed it. A lead who answers the phone must
stop receiving the cold email sequence too, and the reverse - suppressing only the channel that happened to
report first is how a lead ends up pitched twice. So every interested event, whatever found it, runs the same
`suppressInterestedLead`:

| Channel | Action | Needs |
| --- | --- | --- |
| Attio | Add the Person to the DNC list | the Person |
| Instantly | Add the address to the workspace blocklist | an email address |
| HeyReach | Stop the lead in every campaign still able to message them | a LinkedIn profile URL |

Aircall is absent because it is a phone system with no campaign or blocklist API - there is nothing there to
call. Aircall dialling is governed by the Attio DNC list, which is why that is the first channel and the one
that matters most.

Each channel is independent and a failure in one does not stop the others: half the platforms suppressed is
strictly better than one suppressed and the rest untouched because the first threw. Failures are returned in the
route's response body rather than raised, so an unreachable platform cannot fail an event Attio already
recorded. A channel reporting `skipped` is not a failure - it means the lead is not present on that platform,
usually for want of the one identifier it works by.

### Adding a fourth platform

Provider support is a register, not a set of branches. Adding one is an append plus its own extractor:

1. **`lib/providers.ts`** - add an entry to `SOURCES` with its `displayName`. That single entry widens the
   `Provider` type and derives the Lead Source and Deal Source strings (`<Name> Cold Outreach` and
   `<Name> Cold Outreach - Automated`). If the platform also sends outbound and must be silenced, append a
   `SuppressionChannel` to `THIRD_PARTY_SUPPRESSION_CHANNELS`; from that moment it is suppressed for every
   provider, with no change to any route.
2. **A provider module** - parse its payload and return an `InterestedLead` via `interestedLead()`, naming only
   the fields it actually has. Everything it cannot supply stays null and simply is not written.
3. **A route or cron** - call `recordInterestedLead` with the lead, a `findPerson` lookup, and a `history`
   renderer.
4. **Two environment variables** - `ATTIO_PERSON_<KEY>_COUNTER_SLUG` and `ATTIO_COMPANY_<KEY>_COUNTER_SLUG`,
   derived from the provider key. These throw on first use if absent, so a missing one fails loudly rather than
   writing a counter nobody reads.

Nothing in the Attio mapping, the write path, the company resolution, or the deal naming needs to change.

### What each platform contributes

Only fields that exist on both sides are mapped. The providers are not equally rich:

| Attio target | Aircall | Instantly | HeyReach |
| --- | --- | --- | --- |
| Person `name`, `email_addresses` | yes | yes | yes |
| Person `phone_numbers` | yes | yes | - |
| Person `linkedin` | - | yes | yes |
| Person `job_title` | - | yes | yes |
| Person `description` | yes | - | yes |
| Person `location` | - | yes | yes |
| Person `campaign_name`, `date_added`, `lead_source`, `company` | yes | yes | yes |
| Company `name` | yes | yes | yes |
| Company `domains`, `primary_location`, `employee_range`, `estimated_arr_usd` | - | yes | - |
| Deal `lead_source`, `campaign_name`, `email`, `moved_to_interested_at` | yes | yes | yes |
| Deal `phone_number_7` | yes | yes | - |
| Deal `linkedin` | - | yes | yes |
| Deal `website`, `industry`, `employees`, `revenue` | - | yes | - |

Aircall is the thinnest by a wide margin: no LinkedIn URL, job title, industry, headcount, or revenue exists
anywhere in its API, and a name or company appears only when the dialled number was already in Aircall's address
book - which for a cold campaign it usually is not. A cold dial therefore creates no Company at all, because a
company record named after a phone number is worse than no company.

Instantly is the richest, but almost none of it is on the webhook. `/api/instantly-interested` reads the lead
record back (`POST /leads/list`) for the job title, LinkedIn URL, phone, industry, headcount, revenue, location,
and company address, which live under the campaign's custom variables. That lookup is best-effort: if it fails,
the event is still recorded from the webhook body alone.

HeyReach's enrichment is free. The route already fetches the conversation for the note, and every entry carries
the correspondent's position, headline, location, company, and all three of HeyReach's email fields.

## Webhook and cron routes

| Route | Source | Expected request |
| --- | --- | --- |
| `/api/instantly-interested` | Instantly | A `lead_interested` webhook using current top-level v2 fields; the route reads the lead record back for enrichment |
| `/api/heyreach-interested` | HeyReach | A HeyReach webhook carrying a lead object, nested or top-level, containing `profileUrl`/`linkedInUrl` or `email` |
| `/api/cron/aircall-touchpoint-sync` | Vercel Cron | Authorized GET every ten minutes (`*/10 * * * *`); also runs the interested workflow for any call whose completion falls in the window and already carries an `AIRCALL_INTERESTED_TAGS` tag |
| `/api/cron/instantly-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/heyreach-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |

### Aircall interested leads are found by polling, not by webhook

There is no `/api/aircall-interested` route. It was removed. Aircall applies an outcome tag *after* the call ends,
so the payload the webhook received almost never carried the tag yet, and the touchpoint cron had to cover the gap
regardless; running both meant every tagged call was recorded twice. The workflow now lives in
`lib/aircall-interested.ts` and has exactly one caller, the cron.

Each run reads every call's tags straight from the API and runs `processAircallInterested` for any call already
tagged. Because a tag is applied after the call, a high-water cursor alone would carry a call past the check before
its tag exists, so the interested check is not cursor-gated. Its floor is `min(cursor, now - INTERESTED_LOOKBACK_MS)`,
with the lookback set to five minutes.

**This sync runs every ten minutes, and at that cadence the lookback does not bind - five minutes is a minimum, not
the window.** The cursor sits about 12 minutes back (the gap plus the two-minute `CURSOR_GRACE_MS`), and 12 minutes
back reaches further back than five does, so `min()` picks the cursor. Real tag tolerance day to day is therefore
**~12 minutes**, not five. What the constant guarantees is the floor when two runs land close together - a manual
trigger behind a scheduled one, or a retry - where the cursor is only a minute or two back and would otherwise leave
almost no tolerance at all. Lowering it further cannot push tolerance below the cursor's ~12 minutes; only a shorter
cadence can do that.

What the ~12-minute floor gives you, measured against this workspace's tag history (63 of 67 hand-applied tags landed
within five minutes of the call ending, three within thirty, one took 165 minutes):

- **Tag coverage: the 63.** The three at up to thirty minutes and the 165-minute outlier are missed.
- **One note per interested call.** A call is re-checked on every run whose floor still covers it, so at a floor
  barely wider than the cadence it is normally checked once, occasionally twice when it lands inside the two-minute
  grace band.
- **Latency up to ten minutes** before a booking's deal, notes, and DNC entry reach Attio.
- **Heavier runs.** One invocation processes up to ten minutes of new calls plus whatever backlog remains, each
  touchpoint being up to eight sequential Attio requests. See [The run budget](#the-run-budget).

This is a deliberate choice of clean notes over maximum tag coverage. The alternative is a 65-minute lookback, which
recovers the 30-minute tags and the 165-minute outlier but writes each interested call's person and deal notes about
six times over - the count is always `lookback / cadence`, and the deal itself is never duplicated, only the notes.
To get wide coverage without the duplicates, lengthen the cadence rather than the lookback.

### The run budget

The per-call loop is sequential and a single touchpoint costs up to eight Attio requests, so throughput is roughly
one call every three or four seconds. That is finite, and a backlog can exceed it. Left unguarded the run is killed
by Vercel at `maxDuration`, and the kill lands *before* `saveSyncCursor` - so the run records no progress at all:
the next run re-reads the same backlog, re-increments every counter it already incremented, and is killed again. A
504 on this route means exactly that loop, and inflated `number_of_calls` values are its symptom.

`DEFAULT_RUN_BUDGET_MS` (240s, under the 300s `maxDuration`) makes the loop stop of its own accord instead. On a
budget stop:

- The cursor is saved where the loop actually reached, so the next run resumes rather than restarts.
- The park at `now - CURSOR_GRACE_MS` is **skipped**, because the calls the loop never reached have not been dealt
  with and must stay above the mark.
- The response carries `truncated: true`, `stopReason`, and `callsRemaining`, and the run logs a `[run] ... STOPPED` warning.
  The HTTP status stays 200 - a partial run is a success, not a failure.

A single truncated run is normal while a backlog drains. Truncation on run after run means calls are arriving faster
than they are being processed: shorten the cadence in `vercel.json`. `AIRCALL_SYNC_BUDGET_MS` overrides the budget
without a redeploy, for retuning against a live backlog; a malformed value falls back to the default rather than
failing the run.

### Attio rate limits, and the one failure worth retrying

Attio rate-limits on request rate **and** on *query complexity* - the filtered record lookups this codebase performs
to match a phone number or email to a Person. The touchpoint sync opens every call with one, so a busy run is exactly
what trips the complexity limiter.

`attioFetch`, the single Attio transport, now retries. Deliberately narrowly:

| Status | Retried? | Why |
| - | - | - |
| 429 | Any method | A refused request was never processed, so repeating it cannot apply anything twice. |
| 5xx | `GET` only | A 5xx is ambiguous - Attio may have applied the change and then failed to answer. On a `GET` there is nothing to apply. On a `POST` there is: a retried `POST /notes` duplicates the note, and Attio offers no idempotency key to prevent it. |
| other 4xx | No | Deterministic. The same request fails the same way. |

Four attempts, `Retry-After` honoured when Attio sends one and 0.5s/1s/2s backoff otherwise. Bounded, because a
permanently throttled account has to surface rather than absorb the whole run budget in sleeps - and if it does
absorb it, the budget stop above handles that cleanly.

**Beyond the retries, a throttle before the first write no longer loses the call.** The sync's standing policy is to
count a failed call and pass it over, never retrying, because its earlier writes are already committed and a retry
would duplicate them. That reasoning only holds once something *has* been written. A touchpoint's first two Attio
requests - the filtered person lookup and the Master TAM list read - write nothing, so a transient failure there was
being discarded for no reason: the counter and note were lost and the cursor advanced past the call regardless.

A transient failure in that pre-write region now raises `ThrottledBeforeWrite`, and the run stops with the cursor
still **below** that call. The next run starts on it. Nothing is lost and nothing can double, because nothing was
written. The response reports `stopReason: "throttled"` and the run is still a success with `failed: 0` - the work is
deferred, not failed.

Two things stay on the old pass-over path, both deliberately:

- **A deterministic failure** (a 404, a bad attribute slug) anywhere. It will fail identically on every future run,
  so stopping the run on it would wedge the sync on one unprocessable call.
- **A transient failure from the first write onward.** `incrementCounter` opens with a read but its `PATCH` is inside
  the same call, so a failure there cannot be told apart from one after it. Retrying would risk double-counting a
  Person, which is the worse outcome. This is a KNOWN GAP: a 429 landing between the Person counter and the Company
  note still loses the note and the Company counter, and says so in the log.

If the lookback is ever retuned, two figures move together: tag tolerance, and how many times an interested call's
notes are written, which is the lookback divided by the cadence. Having both wide coverage and no duplicates needs a
record of which calls were already recorded, which does not exist today. Touchpoint counters, by contrast, are
cursor-gated at any cadence and never double-counted - once the cursor is actually being saved.

### Why the Aircall window reaches back two hours

Aircall's `/calls` endpoint filters on a call's **creation** time. This sync places calls on its timeline by
**completion** time, because that is when a call becomes a countable touchpoint and when its tag can exist. The two
do not coincide, and the gap between them is the call's duration.

A call is therefore visible to the query from the moment it starts, but `fetchAircallCalls` discards it until it is
`done`. With a window only as wide as the completion window, a call lasting longer than that window was filtered out
as unfinished on every run covering its start, then fell out of range before it ever looked finished - lost
entirely, touchpoint and tag alike. Longer cron intervals do not fix this; they only move the boundary.

So the request reaches back `MAX_CALL_DURATION_MS` (two hours) below the oldest completion the run acts on. That
reach is also why the interested check needs an explicit floor of its own rather than simply acting on everything
the fetch returned: without one it would re-record up to two hours of already-handled calls on every run. The
extra calls the margin pulls in are rejected by two independent gates - `isAfterCursor` for touchpoints, and the
completion floor for the interested check, which is deliberately not cursor-gated.

**This sets a hard ceiling on call length.** A call is caught while its duration stays under roughly this value -
about 2h02m at the current setting, since the floor trails the completion by up to `CURSOR_GRACE_MS`. Anything
longer is dropped in full, touchpoint and tag alike, and dropped *silently*: it never reaches the fetch, so no
counter, log line, or failure entry records that it existed. Widening the constant costs pagination and nothing
else. Narrowing it below the longest call the account actually makes reintroduces exactly the loss it was added
to fix.

Aircall reports a number as `raw_digits`, punctuated for display (`+1 949-735-4000`), while Attio stores and matches
E.164 (`+19497354000`), so every lookup keyed on the raw value missed. `toE164` normalises it, and both Aircall paths
apply it: the interested workflow inside `extractAircallFields`, so the number written back to Attio is normalised
too, and the touchpoint sync before its own person lookup.

The interested step is given its own error handling inside the run, so a failure there cannot stop the touchpoint
counters from being written, or the reverse. It needs `ATTIO_DEFAULT_DEAL_OWNER` and `AIRCALL_INTERESTED_TAGS`; the
latter is read before any network call, so a missing or empty list fails the run without first paying for the fetch.

Both interested webhooks are configured directly in the provider, pointed at the production host
`https://levanta-crm-overhaul.vercel.app`. Instantly and HeyReach authenticate with an `x-webhook-secret` custom
header whose value must match the corresponding environment variable. Point providers at the production hostname,
never at a deployment-specific URL, which is pinned to a single deployment. Any Aircall webhook still pointed at
this project should be removed in Aircall: the route no longer exists and every delivery will 404.

The HeyReach integration uses `GetConversationsV3` cursor pagination and the current `GetCampaignsForLead` and `StopLeadInCampaign` endpoints.

HeyReach applies its `from`/`to` filter with **day** granularity, so a five-minute run receives every conversation
touched since UTC midnight, each with its full message list, and hashes every message before the per-message cursor
check rejects it. Cost therefore grows through the day. Pre-filtering out conversations with no activity past the
cursor would avoid most of that work; it is deliberately not done, so the per-message check absorbs the whole load.

Instantly uses the current v2 email schema (`timestamp_created`, numeric `ue_type`, nullable `lead`, and nested `body`) and its documented timestamp filters. Scheduled and automatic-reply emails are not counted as touchpoints.

## Configuration

Keep credentials in `.env.local` for local development and configure the same values in Vercel for deployment.

| Variable | Purpose |
| --- | --- |
| `ATTIO_API_KEY` | Attio API token with record, list-entry, and note permissions on People, Companies, and Deals |
| `ATTIO_DEFAULT_DEAL_OWNER` | Workspace member email used when creating a Deal |
| `ATTIO_PERSON_AIRCALL_COUNTER_SLUG` | Person counter slug for Aircall calls |
| `ATTIO_PERSON_INSTANTLY_COUNTER_SLUG` | Person counter slug for Instantly emails |
| `ATTIO_PERSON_HEYREACH_COUNTER_SLUG` | Person counter slug for HeyReach DMs |
| `ATTIO_COMPANY_AIRCALL_COUNTER_SLUG` | Company counter slug for Aircall calls |
| `ATTIO_COMPANY_INSTANTLY_COUNTER_SLUG` | Company counter slug for Instantly emails |
| `ATTIO_COMPANY_HEYREACH_COUNTER_SLUG` | Company counter slug for HeyReach DMs |
| `AIRCALL_API_ID` / `AIRCALL_API_TOKEN` | Aircall Basic Auth credentials for polling |
| `AIRCALL_INTERESTED_TAGS` | Comma-separated Aircall tags that mean interested |
| `AIRCALL_SYNC_BUDGET_MS` | Optional. Milliseconds the touchpoint loop may run before it stops and saves its place; defaults to 240000. See [The run budget](#the-run-budget) |
| `INSTANTLY_API_KEY` | Instantly v2 API key; needs to read emails and leads, and to write blocklist entries |
| `INSTANTLY_WEBHOOK_SECRET` | Secret configured as the Instantly `x-webhook-secret` custom header |
| `HEYREACH_API_KEY` | HeyReach API key; needs to read conversations and to stop leads in campaigns |
| `HEYREACH_WEBHOOK_SECRET` | Secret configured on the HeyReach webhook as the `x-webhook-secret` custom header |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-side Supabase secret key; never expose it to a client |
| `CRON_SECRET` | Vercel Cron authorization secret |

Legacy Supabase JWT projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.

A fourth provider adds two more counter-slug variables, named from its provider key - see
[Adding a fourth platform](#adding-a-fourth-platform).

## Cursor persistence

All three syncs use `Attio_Integrations_Touchpoint_Cursors` instead of process memory. Rows are upserted with these stable keys:

- `aircall-touchpoints`
- `instantly-touchpoints`
- `heyreach-touchpoints`

`cursor_timestamp` is the completed high-water mark. `cursor_value` contains a JSON array of event IDs at that exact timestamp, preventing events with identical timestamps from being lost or replayed. A missing row starts with a ten-minute lookback and is created automatically. `last_updated_at` is refreshed on every upsert.

At the end of a run the mark is parked at `now - CURSOR_GRACE_MS` (two minutes), not at `now`. Provider timestamps
are generated on the provider's clock and become readable through its API some time later; parking at the function's
own `Date.now()` silently skipped anything landing in that gap. Re-reading two minutes costs nothing, because
`isAfterCursor` rejects the overlap - and when the newest handled event is more recent than the parked value the
cursor is left untouched, so its boundary ID set survives and that event is not replayed.

### A touchpoint that fails partway through

One touchpoint is three or four separate Attio writes, and Attio offers neither a transaction nor an atomic
increment, so a failure can leave some of them committed. The cursor advances past a failed event anyway, and the run
carries on with the rest of the window.

That is deliberate. Retrying the event would replay the writes that already succeeded, duplicating a note and
double-counting a counter, and an event that fails for a permanent reason would block every later touchpoint on every
future run. Passing over it costs one attempt.

The trade-off is that a failed touchpoint is recorded partially or not at all, and nothing will pick it up later. Each
one is reported so it can be reconciled by hand:

- an `[event] ... FAILED and passed over` line naming the event and the error
- a count in the `[run]` summary
- `failed` and `errors` in the response body, and a `500` status for the run

The Supabase server key must have `SELECT`, `INSERT`, and `UPDATE` access to the table. Keep it in Vercel server-side environment variables only.

## How the code is annotated

Comment tags mark what a block is *for*, so the diagnostic scaffolding can be told from the rules at a glance:

| Tag | Meaning |
| --- | --- |
| `[LOGIC]` | A business rule. Changing it changes what ends up in the CRM |
| `[DEBUG]` | Diagnostic only - a log line, or a branch that exists to make a failure legible. Removing it would change no record |
| `[SECURITY]` | A guard against writing the wrong data, exposing a secret, or acting on an unauthenticated request |
| `[STABILITY]` | What happens when something fails partway - what is already committed, what is retried, what is not |
| `[PERF]` | A cost worth knowing about: requests per event, how a window widens work |

Functions carry a `FLOW:` list of numbered steps in plain English, and a `USES:` line naming what they depend
on and where it lives, so a reader can follow a call without searching for its imports.

## Reading a run from the logs

Every environment read and every write is reported to the console, so a misconfigured deployment can be identified,
and a completed run replayed action by action, from the Vercel runtime logs without redeploying instrumented code.
Secret values are never logged.

| Prefix | Meaning |
| --- | --- |
| `[env]` | Whether a variable is set, its length in characters, and whether stored surrounding whitespace had to be trimmed |
| `[config]` | The full value of a non-secret identifier: attribute slugs, `SUPABASE_URL`, the parsed `AIRCALL_INTERESTED_TAGS` list, and which Supabase key variable was used. `ATTIO_DEFAULT_DEAL_OWNER` is reported by domain only |
| `[auth]` | Why a cron or webhook request was accepted or rejected, distinguishing an unconfigured secret from an absent header, a missing `Bearer` prefix, and a value that differs by case, whitespace, or length |
| `[credential]` | A provider answered `401`/`403`, naming the variables that hold that provider's key |
| `[slug]` | Attio rejected a counter attribute, naming the slug so the matching `ATTIO_PERSON_*` or `ATTIO_COMPANY_*_COUNTER_SLUG` can be checked |
| `[route]` | The decision a webhook made before touching Attio: that an Instantly event was not `lead_interested`, or which HeyReach lead is being handled. Ends with a line counting the history entries summarised and the platforms that failed to suppress |
| `[interested]` | The Aircall interested workflow, naming the call and who it was with. Always `poll`: the cron is the only caller. Every call the check sees produces a decision line listing every tag it carried, whether or not any matched, and on a miss the configured set it was compared against; a run reporting nothing interested is therefore readable as "these calls, these tags, no match" rather than as silence. A match is followed by the person and deal it finished with, or by the reason it could not: no way to reach a person (the call carried neither an email nor a phone number), or a failure passed over |
| `[lookup]` | Each person, company, and deal search and its result, naming the attribute searched and the record matched, plus whether that person is on the Master TAM list. A company line also says when the person was already linked to one, or when neither Attio nor the provider names one and the deal will be named for an unknown company. An Instantly lead lookup names which enrichment fields arrived, by field name only. The deal line reports both outcomes - how many deals the person already had and which is being reused, or that they had none and one is being created - because "checked and found none" and "never checked" must not read alike |
| `[action]` | Each write and its outcome: person or company created, a record updated with the attribute list, a record left untouched because every target attribute was already populated, deal created, deal reused, note added, blocklist entry added, counter moved from one value to the next. A failure is reported as `[action] FAILED` naming the action and record before the error propagates |
| `[suppress]` | One line per outbound platform - suppressed, skipped with the identifier it lacked, or `FAILED` with the reason - then a summary naming every platform and its outcome. A failure here is reported, not raised: the Attio record was already written |
| `[attio]` | An attribute was not written and the event continued anyway: a multiselect left alone because its existing entries could not all be read back, so a replacing write would have risked deleting real data; or a value Attio rejected, named individually, with a count of what was written and what was dropped |
| `[event]` | Why one polled touchpoint was skipped: no phone or lead email on the record, no Attio person matched, or the person is not on the Master TAM list. An Aircall line names the touchpoint process, to separate it from the interested check running over the same call |
| `[run]` | One summary per sync: how many records were in the window, how many were processed, skipped, off-TAM, or failed and passed over, and the new cursor. Aircall reports two counts, because its fetch is deliberately wider than its scope: `fetched` is everything the two-hour reach-back returned, `scope` is the subset completing at or after the floor the run acts on. Only the second is expected to match the processed and interested figures; the response body carries the same pair as `callsFound` and `callsInScope` |

A `401` from a cron route means the guard rejected the request, not that the function failed. The `[auth]` line
states which case applied. Note that Vercel only attaches the `authorization` header once `CRON_SECRET` exists in
the project's environment variables, and adding it requires a redeploy before it reaches a running deployment.

Secret confidentiality is enforced by a test: no `[env]`, `[auth]`, or `[credential]` path may print a configured
secret. Note that `[lookup]` and `[event]` lines do carry the business identifier being matched - an email address,
a phone number, or a LinkedIn URL - because a miss is not actionable without it. Those are not credentials, but they
are personal data in a retained log.

## Verification

Run the compiler and isolated unit suite:

```sh
bun run check
```

The unit suite mocks every external write and covers provider response validation, pagination, handlers, touchpoint
event identity, Attio helpers, and Supabase cursor persistence. The shared interested workflow is covered
separately in `tests/unit/interested.test.ts`: the attribute transforms at each bucket boundary, the never-overwrite
rule, the multiselect merge and the cases where it declines to write, the strict deal naming, and suppression
continuing across platforms after one of them fails.

Run opt-in, read-only smoke tests against configured live accounts:

```sh
bun run test:live
```

`bun test` sets `NODE_ENV=test`, and Bun skips `.env.local` in that environment, so the script passes
`--env-file=.env.local` explicitly. Without it every live test fails on a missing variable rather than on anything
it was meant to check.

Live tests do not create, update, stop, or delete anything, and they do not print returned account data. They cover
two kinds of failure:

- **Credentials.** One small page is read from Supabase, Attio, Aircall, Instantly, and HeyReach, which proves each
  key is accepted.
- **Schema and configuration.** All six counter slugs are checked against the live Attio attribute list for the
  people and companies objects, both list slugs against the workspace's lists, and `ATTIO_DEFAULT_DEAL_OWNER`
  against the workspace members. A wrong slug or a renamed list is caught here rather than on the first touchpoint
  that happens to reach it in production. `CRON_SECRET` and the three webhook secrets are checked for presence,
  which is all that can be verified without a caller.

## Deployment

`vercel.json` selects Vercel's Bun `1.x` runtime and schedules the Instantly and HeyReach syncs every five minutes and the Aircall sync every ten (`*/10 * * * *`). Vercel also detects `bun.lock`, so dependency installation uses Bun rather than npm.

Every function under `api/` is given `maxDuration: 300`. One touchpoint is up to eight sequential Attio requests and
the work is unbounded by design, so at the platform default a busy window could be cut off mid-event, leaving a note
written and its counter not. Three hundred seconds is the Pro ceiling; the project already exceeds Hobby's cron
limits, so it cannot be running there.

`maxDuration` is a backstop, not a plan. The Aircall sync stops itself at `DEFAULT_RUN_BUDGET_MS` (240s) and saves
its cursor, because being killed at `maxDuration` discards the run entirely - see [The run budget](#the-run-budget).
Raise `maxDuration` before raising that budget, never the other way round.

Attio counter updates remain read-then-write because Attio does not expose an atomic increment operation. The sync
handlers process events sequentially, and a failed event is passed over rather than retried, as described under
[A touchpoint that fails partway through](#a-touchpoint-that-fails-partway-through). Nothing guards against two
invocations of the same sync running at once, so avoid overlapping manual runs.
