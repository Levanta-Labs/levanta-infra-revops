# Levanta CRM Overhaul

Typed Vercel functions that synchronize Aircall, Instantly, and HeyReach activity into Attio. Bun is used for dependency management, local scripts, tests, and the Vercel runtime.

## Project layout

```text
api/
  instantly-interested.ts
  heyreach-interested.ts
  cron/
    aircall-interested-sync.ts
    aircall-touchpoint-sync.ts
    instantly-touchpoint-sync.ts
    heyreach-touchpoint-sync.ts
lib/
  attio.ts
  aircall.ts
  instantly.ts
  heyreach.ts
  cursors.ts
tests/
  unit/
  live/
```

Each interested webhook (Instantly, HeyReach) creates or finds an Attio Person, ensures an Interested Deal exists, writes source history notes, sets Lead Source, and upserts the Person into the DNC list. Aircall's "interested" detection is a polling cron instead of a webhook — see below. Each touchpoint cron sync only logs touchpoints for People on the Master TAM list, mirrors the note to the associated Company, and increments the configured counters.

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
| `AIRCALL_DIALER_USER_ID` | Aircall user ID whose Dialer Campaign is polled for outcomes |
| `AIRCALL_INTERESTED_OUTCOMES` | Comma-separated Dialer Campaign outcome values that mean interested |
| `INSTANTLY_API_KEY` | Instantly v2 API key with `emails:read` or broader scope |
| `INSTANTLY_WEBHOOK_SECRET` | Secret configured as the Instantly `x-webhook-secret` custom header |
| `HEYREACH_API_KEY` | HeyReach API key |
| `HEYREACH_WEBHOOK_SECRET` | Secret configured by the Zapier relay as `x-webhook-secret` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Server-side Supabase secret key; never expose it to a client |
| `CRON_SECRET` | Vercel Cron authorization secret |

Legacy Supabase JWT projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`.

## Supabase cursors

All syncs use `Attio_Integrations_Touchpoint_Cursors` instead of process memory. Rows are upserted by these stable keys:

- `aircall-touchpoints`
- `aircall-interested`
- `instantly-touchpoints`
- `heyreach-touchpoints`

`cursor_timestamp` is the completed high-water mark. `cursor_value` contains a JSON array of event IDs at that exact timestamp, preventing events with identical timestamps from being lost or replayed. A missing row starts with a ten-minute lookback and is created automatically. `last_updated_at` is explicitly refreshed on every upsert.

The Supabase server key must have `SELECT`, `INSERT`, and `UPDATE` access to the table. Keep it in Vercel server-side environment variables only.

## Webhooks and cron routes

| Route | Source | Expected request |
| --- | --- | --- |
| `/api/instantly-interested` | Instantly | A `lead_interested` webhook using current top-level v2 fields |
| `/api/heyreach-interested` | Zapier relay | A lead object, nested or top-level, containing `profileUrl`/`linkedInUrl` or `email` |
| `/api/cron/aircall-interested-sync` | Vercel Cron | Authorized GET every five minutes; polls Aircall's Dialer Campaign for outcomes matching `AIRCALL_INTERESTED_OUTCOMES` |
| `/api/cron/aircall-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/instantly-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |
| `/api/cron/heyreach-touchpoint-sync` | Vercel Cron | Authorized GET every five minutes |

**Note on `aircall-interested-sync`:** Aircall does not expose a webhook or a documented public schema for Dialer Campaign outcomes (`Interested`, `Not Interested`, `DNC`, `No Answer`, `Not ICP`, etc. — confirmed via the Aircall dashboard and a real `call.tagged` webhook payload, which only carries a generic `Outbound Campaign` tag, not the outcome). This sync polls `GET /v1/users/{AIRCALL_DIALER_USER_ID}/dialer_campaign/phone_numbers` instead. **The field names it parses (`lib/aircall.ts`'s `parseDialerCampaignEntry`) are provisional** — they're a best guess from the dashboard UI, not a confirmed response schema, and must be verified against a real API response before this is trusted in production.

The HeyReach implementation uses `GetConversationsV3` cursor pagination and the current `GetCampaignsForLead` and `StopLeadInCampaign` endpoints. Instantly uses the current v2 email schema (`timestamp_created`, numeric `ue_type`, nullable `lead`, and nested `body`) and its documented timestamp filters. Scheduled and automatic-reply emails are not counted as touchpoints.

## Tests

Run the strict compiler and unit suite:

```sh
bun run check
```

The unit suite mocks every external write and covers provider response validation, pagination, handlers, touchpoint event identity, Attio helpers, and Supabase cursor persistence.

Run opt-in read-only smoke tests against configured live accounts:

```sh
bun run test:live
```

Live tests only identify/read one small page from Supabase, Attio, Aircall, Instantly, and HeyReach. They do not create, update, stop, or delete anything, and they do not print returned account data.

## Deployment

`vercel.json` selects Vercel's Bun `1.x` runtime and schedules all three syncs every five minutes. Vercel also detects `bun.lock`, so dependency installation uses Bun rather than npm.

Attio counter updates remain read-then-write because Attio does not expose an atomic increment operation. The sync handlers process events sequentially and stop at the first failed event so the cursor never advances past unprocessed work. Avoid overlapping manual invocations of the same sync.
