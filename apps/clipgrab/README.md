# ClipGrab 📱→🔗

**Telegram bot that turns public TikTok & Instagram links into direct download links.**
Serverless on Cloudflare Workers — we never host the media, so zero storage/bandwidth cost.

## What it does

| | |
|---|---|
| Send a TikTok link (short or canonical) | → direct video URL; **watermark-free** when the mobile feed endpoint is healthy (it has a cooldown — see below) |
| Send an Instagram post/reel permalink | → direct media URL via the public embed payload |
| `/status` | supported platforms + today's quota + Pro state |
| Free tier | 3 links/day |
| Pro (`/buy`) | unlimited links, paid in Telegram Stars |

## Honest limitations

- **YouTube is NOT supported.** The public Cobalt instance prohibits commercial use,
  self-hosting needs ffmpeg/binaries (impossible on Workers), and we run no VM by policy.
  It ships only when we have our own extraction infrastructure. Every YouTube link gets
  a clear "coming soon" answer.
  - *Roadmap:* Deno Deploy free tier + `youtube.js` (pure JS, progressive stream, no
    ffmpeg) is the documented path for a future YouTube resolver — or a Cobalt instance
    partnership. Until then, YouTube stays out of the free/commercial bot.
- Instagram scope: single public posts/reels/TV. Carousels, stories, private accounts → explicit "unsupported".
- These resolvers are unofficial and fragile by nature. Each one is isolated in
  [`src/resolvers/`](src/resolvers/) with its own test suite; breakage is fixed reactively
  and never takes other platforms down with it.
- **TikTok strategy order (2026-08-24):** the web page hydration blob is PRIMARY — it kept
  serving while the mobile feed endpoint spent the day returning HTTP 429 from our egress.
  The feed API (watermark-free) stays as fallback behind a **shared KV cooldown** (600s):
  a 429/5xx benches the endpoint fleet-wide so free users stop paying its latency tax, and
  parallel requests never re-probe a benched endpoint. Page fetches retry transient 5xx/429s.

## Architecture

```
Telegram webhook ──► src/index.ts (auth → rate limit → route)
                                    │
                     src/routing.ts (first matching resolver wins)
                       ├── resolvers/tiktok.ts      (web-page hydration PRIMARY → feed API fallback w/ KV cooldown)
                       ├── resolvers/instagram.ts   (embed/captioned contextJSON)
                       └── resolvers/youtube.ts     (stub: documented refusal)
```

- Quota: `@forgekit/ratelimit` on KV (fixed daily window); `/status` reads it via `peek()` without consuming
- Payments: Stars subscriptions + credit packs via `@forgekit/stars` — pre-checkout review
  AND idempotent fulfillment of `message.successful_payment` (a paid user always receives
  Pro/credits, keyed by charge id)
- Ledger: shared D1 (`infra/schema.d1.sql`)

## Tests

```bash
npm test        # runs from the monorepo root; resolvers are tested against mocked fetch
```

Live endpoints change without notice — unit tests pin the *parsing* contracts so we notice
exactly what broke when a platform ships changes.
