# Levanta CRM Overhaul

Typed Vercel functions that synchronize Aircall, Instantly, and HeyReach activity into Attio. Bun is used for dependency management, local scripts, tests, and the Vercel runtime.

## Project layout

```text
api/
  aircall-interested.ts
  instantly-interested.ts
  heyreach-interested.ts
  cron/
    aircall-touchpoint-sync.ts
    instantly-touchpoint-sync.ts
    heyreach-touchpoint-sync.ts
lib/
  attio.ts
  aircall.ts
  instantly.ts
  heyreach.ts
  cursors.ts
  endpoints.ts
  env.ts
  http.ts
  json.ts
tests/
  unit/
  live/
```

`lib/endpoints.ts` is the single source for every provider base URL and auth header builder; the provider clients and the live smoke tests both import from it rather than constructing their own. API keys are still read from environment variables at call time, never hardcoded.

Each interested webhook creates or finds an Attio Person, ensures an Interested Deal exists, writes source history notes, backfills Lead Source and any blank contact attributes, and upserts the Person into the DNC list. Attio is treated as the source of truth: third-party data only fills attributes that are currently empty on the Person, and never overwrites a value Attio already holds (see `blankPersonValues` in `lib/attio.ts`). An attribute counts as blank only when its Attio value array is empty, so a Person who already has one email keeps exactly that email. Each touchpoint cron sync only processes People on the Master TAM list and increments the configured counters; Instantly and HeyReach also write a note on the Person, while Aircall does not (that note is written by a separate integration) — all three mirror a note to the associated Company when one exists.

## Setup

Install dependencies with Bun only:

```sh
bun install
```

Copy `.env.example` to `.env.local` for local development. Configure the same values in Vercel for deployment.

### Required environment variables

| Variable | Purpose |
| --- | --- |
| `ATTIO_API_KEY` | Attio API token with record, list-entry, and note permissions |
| `ATTIO_DEFAULT_DEAL_OWNER` | Workspace member email used when creating a Deal |
| `ATTIO_COMPANY_AIRCALL_COUNTER_SLUG` | Confirmed Company counter slug for Aircall calls |
| `ATTIO_COMPANY_INSTANTLY_COUNTER_SLUG` | Confirmed Company counter slug for Instantly emails |
| `ATTIO_COMPANY_HEYREACH_COUNTER_SLUG` | Confirmed Company counter slug for HeyReach DMs |
| `AIRCALL_API_ID` / `AIRCALL_API_TOKEN` | Aircall Basic Auth credentials for polling |
| `AIRCALL_WEBHOOK_TOKEN` | Token Aircall includes in the webhook JSON payload |
| `AIRCALL_INTERESTED_TAGS` | Comma-separated Aircall tags that mean interested |
| `INSTANTLY_API_KEY` | Instantly v2 API key with `emails:read` or broader scope |
| `INSTANTLY_WEBHOOK_SECRET` | Secret configured as the Instantly `x-webhook-secret` custom header |
| `HEYREACH_API_KEY` | HeyReach API key |
| `HEYREACH_WEBHOOK_SECRET` | Secret configured in HeyReach's webhook settings as the `x-webhook-secret` header |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-side Supabase secret key; never expose it to a client |
| `CRON_SECRET` | Vercel Cron authorization secret |

Legacy Supabase JWT projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.

## Supabase cursors

All syncs use `Attio_Integrations_Touchpoint_Cursors` instead of process memory. Rows are upserted by these stable keys:

- `aircall-touchpoints`
- `instantly-touchpoints`
- `heyreach-touchpoints`

`cursor_timestamp` is the completed high-water mark. `cursor_value` contains a JSON array of event IDs at that exact timestamp, preventing events with identical timestamps from being lost or replayed. A missing row starts with a ten-minute lookback and is created automatically. `last_updated_at` is explicitly refreshed on every upsert.

Because the syncs now run once daily but a missing cursor row only looks back ten minutes, the very first run against an empty table (or any run after the row is deleted) picks up ten minutes of history rather than a full day. Seed `cursor_timestamp` manually if a backfill is needed.

The Supabase server key must have `SELECT`, `INSERT`, and `UPDATE` access to the table. Keep it in Vercel server-side environment variables only.

## Webhooks and cron routes

| Route | Source | Expected request |
| --- | --- | --- |
| `/api/aircall-interested` | Aircall | A documented Aircall webhook envelope; matching is driven by `AIRCALL_INTERESTED_TAGS` |
| `/api/instantly-interested` | Instantly | A `lead_interested` webhook using current top-level v2 fields |
| `/api/heyreach-interested` | HeyReach | A lead object, nested or top-level, containing `profileUrl`/`linkedInUrl` or `email` |
| `/api/cron/aircall-touchpoint-sync` | Vercel Cron | Authorized GET, once daily at 06:00 UTC |
| `/api/cron/instantly-touchpoint-sync` | Vercel Cron | Authorized GET, once daily at 06:00 UTC |
| `/api/cron/heyreach-touchpoint-sync` | Vercel Cron | Authorized GET, once daily at 06:00 UTC |

The HeyReach implementation uses `GetConversationsV3` cursor pagination and the current `GetCampaignsForLead` and `StopLeadInCampaign` endpoints. Instantly uses the current v2 email schema (`timestamp_created`, numeric `ue_type`, nullable `lead`, and nested `body`) and its documented timestamp filters. Scheduled and automatic-reply emails are not counted as touchpoints.

## Tests

Run the strict compiler and unit suite:

```sh
bun run check
```

The unit suite mocks every external write and covers provider response validation, pagination, interested-webhook and cron handlers, touchpoint event identity, Attio helpers, blank-only attribute backfill, and Supabase cursor persistence.

Run opt-in read-only smoke tests against configured live accounts:

```sh
bun run test:live
```

Live tests only identify/read one small page from Supabase, Attio, Aircall, Instantly, and HeyReach. They do not create, update, stop, or delete anything, and they do not print returned account data.

## Deployment

`vercel.json` selects Vercel's Bun `1.x` runtime and schedules the three touchpoint syncs once daily at 06:00 UTC. Vercel also detects `bun.lock`, so dependency installation uses Bun rather than npm.

Attio counter updates remain read-then-write because Attio does not expose an atomic increment operation. The sync handlers process events sequentially and stop at the first failed event so the cursor never advances past unprocessed work. Avoid overlapping manual invocations of the same sync.
