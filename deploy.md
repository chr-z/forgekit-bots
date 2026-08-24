# Deploy — ForgeKit Bots on Cloudflare (100% free tier)

One Cloudflare account, one shared D1 database, one KV namespace per bot,
one Worker per bot. **No VMs anywhere** — the Oracle free-tier VM was never
provisionable and nothing in this stack needs it.

## 0. Prerequisites

```bash
npm install -g wrangler   # or use npx wrangler@latest
wrangler login            # interactive OAuth, once
```

Secrets policy: tokens go to `wrangler secret put`, NEVER into chat, git, or wrangler.toml.

## 1. Shared infrastructure (once)

```bash
# D1 database (shared by all bots; schema in infra/schema.d1.sql)
npx wrangler d1 create forgekit
npx wrangler d1 execute forgekit --remote --file infra/schema.d1.sql

# One KV namespace per bot (quotas are isolated on purpose)
for ns in clipgrab transcribeforge instatoolkit; do
  npx wrangler kv namespace create "$ns"
done
```

Copy the printed ids into each app's `wrangler.toml` (`database_id`, KV `id`).

## 2. Bots no Telegram

For each bot: create a bot with @BotFather → get the token.
Payments: activate the Stars provider for the bot via BotFather (`/mybots → Payments`),
then register your product list from each app's catalog.

## 3. Secrets & deploy

Per app directory:

```bash
cd apps/clipgrab        # repeat for the other apps
npx wrangler secret put TELEGRAM_BOT_TOKEN   # paste token when prompted
npx wrangler secret put WEBHOOK_SECRET       # any long random string (openssl rand -hex 32)
npx wrangler deploy
```

## 4. Webhook registration

```bash
# WEBHOOK_SECRET must match the secret above; URL is the workers.dev URL from deploy
curl "https://api.telegram.org/bot$TOKEN/setWebhook" \
  --data-urlencode "url=https://clipgrab-bot.<subdomain>.workers.dev/" \
  --data-urlencode "secret_token=$WEBHOOK_SECRET" \
  --data-urlencode "allowed_updates=[\"message\",\"pre_checkout_query\"]"
```

## 5. Workers AI note (TranscribeForge)

The `AI` binding works out of the box on the free plan. Free tier ≈ 10k neurons/day —
the monthly-minutes quota keeps usage inside that envelope. If the envelope ever gets
tight: pause new free users of that bot first, never generate cost (owner directive).

## 6. Verify after deploy

- `curl https://<worker>.workers.dev/` → plain-text banner (worker is up)
- Send `/start` in Telegram → localized reply
- CI must be green before every push (`npm test`, 80+ tests; `tsc -p tsconfig.base.json --noEmit` clean)

## 7. YouTube policy (ClipGrab)

ClipGrab ships **without** YouTube. The public Cobalt instance forbids commercial use,
and self-hosting needs ffmpeg (no VMs by policy). Documented future paths: Deno Deploy
free tier + youtube.js, or a Cobalt instance partnership. Do not wire YouTube into the
bot until one of those exists.

## Rollback

Workers keep previous versions: `npx wrangler rollback`. Resolvers breaking in
production = revert + fix reactively in the next tick.
