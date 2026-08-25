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

The project requires Bun `1.3.13`. Configure local integrations by copying `.env.example` to `.env.local` and supplying the required credentials before invoking a webhook or cron route.

## How CRM activity is synchronized

The Vercel functions handle two workflows:

1. Interested webhooks find or create an Attio Person, ensure an Interested Deal exists, write source-history notes, set Lead Source, and add the Person to the DNC list.
2. Five-minute cron jobs poll each provider for new touchpoints. They process only People on the Master TAM list, increment the configured counters, mirror notes to associated Companies, and persist cursor progress in Supabase.

The three syncs do not write the same records, by design:

| Sync | Person note | Person counter | Company note | Company counter |
| --- | --- | --- | --- | --- |
| Instantly | yes | yes | yes | yes |
| HeyReach | yes | yes | yes | yes |
| Aircall | **no** | yes | yes | yes |

An Aircall touchpoint deliberately writes no Person note, because the call and its recording already live in Aircall
and the Person only needs the count. The note exists on the Company as the roll-up view. A consequence worth knowing:
an Aircall touchpoint for a Person with no associated Company records only the counter increment.

## Webhook and cron routes

| Route | Source | Expected request |
| --- | --- | --- |
| `/api/aircall-interested` | Aircall | A documented Aircall webhook envelope; matching is driven by `AIRCALL_INTERESTED_TAGS` |
| `/api/instantly-interested` | Instantly | A `lead_interested` webhook using current top-level v2 fields |
| `/api/heyreach-interested` | HeyReach | A HeyReach webhook carrying a lead object, nested or top-level, containing `profileUrl`/`linkedInUrl` or `email` |
| `/api/cron/aircall-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/instantly-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/heyreach-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |

All three interested webhooks are configured directly in the provider, pointed at the production host
`https://levanta-crm-overhaul.vercel.app`. Instantly and HeyReach authenticate with an `x-webhook-secret` custom
header whose value must match the corresponding environment variable. Aircall instead sends its own issued token
inside the payload, so it needs no custom header. Point providers at the production hostname, never at a
deployment-specific URL, which is pinned to a single deployment.

The HeyReach integration uses `GetConversationsV3` cursor pagination and the current `GetCampaignsForLead` and `StopLeadInCampaign` endpoints. Instantly uses the current v2 email schema (`timestamp_created`, numeric `ue_type`, nullable `lead`, and nested `body`) and its documented timestamp filters. Scheduled and automatic-reply emails are not counted as touchpoints.

## Configuration

Keep credentials in `.env.local` for local development and configure the same values in Vercel for deployment.

| Variable | Purpose |
| --- | --- |
| `ATTIO_API_KEY` | Attio API token with record, list-entry, and note permissions |
| `ATTIO_DEFAULT_DEAL_OWNER` | Workspace member email used when creating a Deal |
| `ATTIO_PERSON_AIRCALL_COUNTER_SLUG` | Person counter slug for Aircall calls |
| `ATTIO_PERSON_INSTANTLY_COUNTER_SLUG` | Person counter slug for Instantly emails |
| `ATTIO_PERSON_HEYREACH_COUNTER_SLUG` | Person counter slug for HeyReach DMs |
| `ATTIO_COMPANY_AIRCALL_COUNTER_SLUG` | Company counter slug for Aircall calls |
| `ATTIO_COMPANY_INSTANTLY_COUNTER_SLUG` | Company counter slug for Instantly emails |
| `ATTIO_COMPANY_HEYREACH_COUNTER_SLUG` | Company counter slug for HeyReach DMs |
| `AIRCALL_API_ID` / `AIRCALL_API_TOKEN` | Aircall Basic Auth credentials for polling |
| `AIRCALL_WEBHOOK_TOKEN` | Token Aircall issues and includes in the webhook JSON payload; copy it from Aircall rather than choosing a value |
| `AIRCALL_INTERESTED_TAGS` | Comma-separated Aircall tags that mean interested |
| `INSTANTLY_API_KEY` | Instantly v2 API key with `emails:read` or broader scope |
| `INSTANTLY_WEBHOOK_SECRET` | Secret configured as the Instantly `x-webhook-secret` custom header |
| `HEYREACH_API_KEY` | HeyReach API key |
| `HEYREACH_WEBHOOK_SECRET` | Secret configured on the HeyReach webhook as the `x-webhook-secret` custom header |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-side Supabase secret key; never expose it to a client |
| `CRON_SECRET` | Vercel Cron authorization secret |

Legacy Supabase JWT projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.

## Cursor persistence

All three syncs use `Attio_Integrations_Touchpoint_Cursors` instead of process memory. Rows are upserted with these stable keys:

- `aircall-touchpoints`
- `instantly-touchpoints`
- `heyreach-touchpoints`

`cursor_timestamp` is the completed high-water mark. `cursor_value` contains a JSON array of event IDs at that exact timestamp, preventing events with identical timestamps from being lost or replayed. A missing row starts with a ten-minute lookback and is created automatically. `last_updated_at` is refreshed on every upsert.

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
| `[route]` | The decision a webhook made before touching Attio: which Aircall tag matched, that a call carried no tags at all, that the tags present were not interested ones, that an Instantly event was not `lead_interested`, or that a payload had no email and no phone. Ends with a completion line naming the person and deal |
| `[lookup]` | Each person search and its result, naming the attribute searched and the record matched, plus whether that person is on the Master TAM list |
| `[action]` | Each write and its outcome: person created, person updated with the attribute list, person left untouched because every target attribute was already populated, deal created, deal reused, note added, counter moved from one value to the next. A failure is reported as `[action] FAILED` naming the action and record before the error propagates |
| `[event]` | Why one polled touchpoint was skipped: no phone or lead email on the record, no Attio person matched, or the person is not on the Master TAM list |
| `[run]` | One summary per sync: how many records were in the window, how many were processed, skipped, off-TAM, or failed and passed over, and the new cursor |

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

The unit suite mocks every external write and covers provider response validation, pagination, handlers, touchpoint event identity, Attio helpers, and Supabase cursor persistence.

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

`vercel.json` selects Vercel's Bun `1.x` runtime and schedules all three syncs every five minutes. Vercel also detects `bun.lock`, so dependency installation uses Bun rather than npm.

Attio counter updates remain read-then-write because Attio does not expose an atomic increment operation. The sync
handlers process events sequentially, and a failed event is passed over rather than retried, as described under
[A touchpoint that fails partway through](#a-touchpoint-that-fails-partway-through). Nothing guards against two
invocations of the same sync running at once, so avoid overlapping manual runs.
