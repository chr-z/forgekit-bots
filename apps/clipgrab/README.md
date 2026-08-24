# ClipGrab 📱→🔗

**Telegram bot that turns public TikTok & Instagram links into direct download links.**
Serverless on Cloudflare Workers — we never host the media, so zero storage/bandwidth cost.

## What it does

| | |
|---|---|
| Send a TikTok link (short or canonical) | → direct video URL, **watermark-free** when the feed endpoint cooperates |
| Send an Instagram post/reel permalink | → direct media URL via the public embed payload |
| Free tier | 3 links/day |
| Pro (`/buy`) | unlimited links, paid in Telegram Stars |

## Honest limitations

- **YouTube is NOT supported.** The public Cobalt instance prohibits commercial use,
  self-hosting needs ffmpeg/binaries (impossible on Workers), and we run no VM by policy.
  It ships only when we have our own extraction infrastructure. Every YouTube link gets
  a clear "coming soon" answer.
- Instagram scope: single public posts/reels/TV. Carousels, stories, private accounts → explicit "unsupported".
- These resolvers are unofficial and fragile by nature. Each one is isolated in
  [`src/resolvers/`](src/resolvers/) with its own test suite; breakage is fixed reactively
  and never takes other platforms down with it.

## Architecture

```
Telegram webhook ──► src/index.ts (auth → rate limit → route)
                                    │
                     src/routing.ts (first matching resolver wins)
                       ├── resolvers/tiktok.ts      (feed API → web-page hydration fallback)
                       ├── resolvers/instagram.ts   (embed/captioned contextJSON)
                       └── resolvers/youtube.ts     (stub: documented refusal)
```

- Quota: `@forgekit/ratelimit` on KV (fixed daily window)
- Payments: Stars subscriptions + credit packs via `@forgekit/stars` (idempotent by charge id)
- Ledger: shared D1 (`infra/schema.d1.sql`)

## Tests

```bash
npm test        # runs from the monorepo root; resolvers are tested against mocked fetch
```

Live endpoints change without notice — unit tests pin the *parsing* contracts so we notice
exactly what broke when a platform ships changes.
