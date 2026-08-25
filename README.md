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
2. Five-minute cron jobs poll each provider for new touchpoints. They process only People on the Master TAM list, mirror notes to associated Companies, increment the configured counters, and persist cursor progress in Supabase.

## Webhook and cron routes

| Route | Source | Expected request |
| --- | --- | --- |
| `/api/aircall-interested` | Aircall | A documented Aircall webhook envelope; matching is driven by `AIRCALL_INTERESTED_TAGS` |
| `/api/instantly-interested` | Instantly | A `lead_interested` webhook using current top-level v2 fields |
| `/api/heyreach-interested` | Zapier relay | A lead object, nested or top-level, containing `profileUrl`/`linkedInUrl` or `email` |
| `/api/cron/aircall-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/instantly-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/heyreach-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |

The HeyReach integration uses `GetConversationsV3` cursor pagination and the current `GetCampaignsForLead` and `StopLeadInCampaign` endpoints. Instantly uses the current v2 email schema (`timestamp_created`, numeric `ue_type`, nullable `lead`, and nested `body`) and its documented timestamp filters. Scheduled and automatic-reply emails are not counted as touchpoints.

## Configuration

Keep credentials in `.env.local` for local development and configure the same values in Vercel for deployment.

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
| `HEYREACH_WEBHOOK_SECRET` | Secret configured by the Zapier relay as `x-webhook-secret` |
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

The Supabase server key must have `SELECT`, `INSERT`, and `UPDATE` access to the table. Keep it in Vercel server-side environment variables only.

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

Live tests identify and read one small page from Supabase, Attio, Aircall, Instantly, and HeyReach. They do not create, update, stop, or delete anything, and they do not print returned account data.

## Deployment

`vercel.json` selects Vercel's Bun `1.x` runtime and schedules all three syncs every five minutes. Vercel also detects `bun.lock`, so dependency installation uses Bun rather than npm.

Attio counter updates remain read-then-write because Attio does not expose an atomic increment operation. The sync handlers process events sequentially and stop at the first failed event so the cursor never advances past unprocessed work. Avoid overlapping manual invocations of the same sync.
