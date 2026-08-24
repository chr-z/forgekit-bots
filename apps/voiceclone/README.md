# VoiceClone Alerts (Bot 6 — ONDA 2)

Keyword alerts for Telegram **channels where the bot is an admin**. No voice
cloning, no MTProto user-API scraping (ToS risk) — the conservative scope the
owner locked in BOTS_ROADMAP.md.

## How it works

1. User adds the bot as **admin** of their channel.
2. `/addchannel <t.me link | @handle | -100id>` in a DM — the worker verifies
   the BOT's admin status over that chat via `getChatMember` before storing it
   (ownership proof without any user login).
3. `/addterm <word>` registers watch terms. Free: 1 channel + 1 term;
   Pro: 5 channels + 20 terms; credit packs add term slots.
4. Every new channel post arrives as a `channel_post` webhook update → pure-TS
   matcher (accent/case-insensitive, whole-word) → the owner gets a DM with
   matched terms + post excerpt.

## Why webhook, not cron polling

Once `setWebhook` is registered, `getUpdates` answers **409 Conflict** — a
cron+getUpdates design would fight the webhook. Channels push posts to admin
bots automatically, so ingestion is webhook-driven. The `[triggers]` cron in
`wrangler.toml` only drains the KV retry queue for alerts whose first send
failed (TTL 24h, max 20/tick).

## Honest limitations

- Only channels/supergroups where the bot is admin are watchable — by design,
  not by accident. Public-channel monitoring WITHOUT admin access would need
  MTProto and is out of scope on purpose.
- Matching is lexical (normalized substring/whole-word), not semantic. It will
  never invent a match; it can miss paraphrases.
- Media-only posts (no text/caption) are ignored.
- If the owner's DM is unreachable (never started the bot), alerts queue for
  retry and expire after 24h.

## Test coverage

Matcher normalization/whole-word/accent folding, channel-arg parsing, store
upsert/delete/count semantics (D1 stub), limits per plan/pack, dedupe of
redelivered posts, alert queue TTL/drain behavior, payment fulfillment,
i18n alignment — see `src/*.test.ts`.

## Deploy

Same shared D1 (`forgekit`) as the rest of the fleet; own KV namespace
(`voiceclone`). Webhook registration must include `channel_post` in
`allowed_updates` — see [../../deploy.md](../../deploy.md).
