# Meta Platform Testbed

One service that exercises **Meta Ads, WhatsApp Cloud API, Instagram DMs and Messenger** end to end:
receives every webhook, verifies signatures, normalises the four very different payload shapes into one,
runs a keyword automation engine that replies on any channel, and gives you a live console to watch it all happen.

Built for testing — to see what is what, with the raw payloads in front of you.

## What it does

- **Webhook receiver** for all four products, with `X-Hub-Signature-256` HMAC verification against the raw request body
- **Normalizer** that flattens WhatsApp / Instagram / Page / Ad Account envelopes into one event shape
- **Automation engine** — keyword, postback and comment triggers, replies on WhatsApp, Instagram or Messenger, with reply-loop protection
- **Facebook Login** callback that harvests Pages, IG accounts, ad accounts and WABAs in one round trip
- **WhatsApp Embedded Signup** — real flow, code exchange, WABA subscription, number registration
- **Send APIs** for WhatsApp (text / template / interactive / media), Instagram DMs and comment replies, Messenger (text / quick replies / cards)
- **Ads explorer** — accounts, campaigns, ad sets, ads, insights, Lead Ad retrieval, paused test campaign creation
- **Graph API explorer** for anything the purpose-built routes miss
- **Live console** with SSE streaming, per-channel filtering, and every Graph call logged with its response

## Quick start

```bash
npm install
cp .env.example .env     # fill in META_APP_ID, META_APP_SECRET, VERIFY_TOKEN, DASHBOARD_PASSWORD
npm start
```

Open http://localhost:3000. For local webhook testing, tunnel it:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Set `PUBLIC_URL` to the tunnel URL so the Setup tab shows the right values to paste.

## The URLs you paste into the App Dashboard

The **Setup** tab renders these live with copy buttons. Paths are:

| Setting | Path |
|---|---|
| Webhook — WhatsApp | `/webhooks/whatsapp` |
| Webhook — Instagram | `/webhooks/instagram` |
| Webhook — Messenger / Page | `/webhooks/messenger` |
| Webhook — Ads | `/webhooks/ads` |
| Webhook — universal (any product) | `/webhooks` |
| Valid OAuth Redirect URI | `/auth/facebook/callback` |
| Deauthorize Callback | `/webhooks/deauthorize` |
| Data Deletion Callback | `/webhooks/data-deletion` |
| Privacy Policy URL | `/privacy` |
| Terms of Service URL | `/terms` |

The **Verify Token** is whatever you set as `VERIFY_TOKEN`. It must match character for character.

## Webhook topics and fields

Confirmed against the Meta platform's own topic catalogue:

| Product | `object` | Subscribe to these fields |
|---|---|---|
| WhatsApp | `whatsapp_business_account` | `messages`, `message_template_status_update`, `message_echoes`, `account_update`, `phone_number_quality_update`, `flows`, `history` |
| Instagram | `instagram` | `messages`, `comments`, `live_comments`, `mentions`, `messaging_postbacks`, `messaging_referral`, `message_reactions`, `standby` |
| Messenger / Page | `page` | `messages`, `messaging_postbacks`, `messaging_optins`, `messaging_referrals`, `message_reads`, `message_echoes`, `feed`, `leadgen` |
| Ads | `ad_account` | `ad_recommendations`, `creative_fatigue`, `with_issues_ad_objects`, `in_process_ad_objects`, `ads_async_creation_request` |

## The two steps people miss

A verified callback URL is not enough. Both of these are required before a single webhook arrives:

1. **Subscribe to fields** in the App Dashboard after verifying the URL. An empty field list means a green checkmark and zero deliveries.
2. **Subscribe the app to each asset** — every WABA, Page and ad account needs its own `POST /{id}/subscribed_apps` call. The WhatsApp, Messenger and Ads tabs each have a button for this.

## API reference

```
GET|POST /webhooks[/whatsapp|/instagram|/messenger|/ads]
POST     /webhooks/deauthorize
POST     /webhooks/data-deletion

GET      /auth/facebook/login          start Facebook Login
GET      /auth/facebook/callback       OAuth redirect target
POST     /auth/manual-token            paste a Graph API Explorer token
GET      /auth/status

POST     /api/whatsapp/send            text | template | interactive | image
GET      /api/whatsapp/numbers
GET      /api/whatsapp/templates
POST     /api/whatsapp/subscribe       app -> WABA
POST     /api/whatsapp/register        register number on Cloud API
POST     /api/whatsapp/embedded-signup/exchange

POST     /api/instagram/send           DM, with optional quick replies
POST     /api/instagram/private-reply  DM the author of a comment
POST     /api/instagram/comment-reply  public reply on the thread
GET      /api/instagram/account|media|conversations

POST     /api/messenger/send           text | quick replies | generic card
POST     /api/messenger/subscribe      app -> Page
POST     /api/messenger/profile        greeting, get-started, persistent menu
GET      /api/messenger/subscriptions|conversations

GET      /api/ads/accounts|campaigns|adsets|ads|insights
POST     /api/ads/campaign             always created PAUSED
GET      /api/ads/leadgen/:leadId
POST     /api/ads/subscribe

GET|POST /api/automations              rules CRUD
POST     /api/automations/simulate     dry-run, sends nothing

GET      /api/events                   recent events + stats
GET      /api/events/stream            SSE live feed
POST     /api/events/graph             raw Graph API proxy
GET      /api/config                   the setup values, secrets redacted
GET      /health
```

## Safety

- The dashboard sits behind HTTP Basic (`DASHBOARD_PASSWORD`); webhook, OAuth and health paths stay open because Meta cannot authenticate.
- Webhook POSTs without a valid `X-Hub-Signature-256` are rejected with 403. Set `ENFORCE_SIGNATURE=false` only while poking with curl.
- Access tokens are fingerprinted before reaching the browser and redacted in the event log.
- Campaign creation is hard-coded to `PAUSED` — nothing here can start spending on its own.
- Echo events never trigger automations, so the bot cannot talk to itself.

## Tests

```bash
node src/server.js &   # with META_APP_SECRET=testsecret123 VERIFY_TOKEN=testverify456 REQUIRE_AUTH=false PORT=3111
node smoke.mjs
```

42 assertions covering the handshake, signature enforcement, normalization of all four payload types, the automation engine, loop protection and the auth gate.

## Notes

Events live in a bounded in-memory buffer and reset on restart or redeploy — this is a testbed, not a system of record. Swap `src/lib/store.js` for Postgres if you need durability.

On Render's free tier the instance sleeps after 15 minutes idle and a cold start can make Meta's webhook verification time out. `KEEP_ALIVE=true` self-pings every 10 minutes to prevent that; upgrading to Starter removes the problem entirely.
