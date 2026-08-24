# ForgeKit Bots

Fleet of serverless **Telegram bots** on the Cloudflare Workers free tier — zero fixed cost, freemium via Telegram Stars + credit packs.

| Bot | What it does | Status |
|---|---|---|
| [TranscribeForge](apps/transcribeforge/) | Audio/video → text transcript + SRT/VTT subtitles (Workers AI Whisper) | core ready |
| [ClipGrab](apps/clipgrab/) | TikTok & Instagram public-content download links (direct-link replies) | core ready |
| [InstaToolkit](apps/instatoolkit/) | Instagram utilities: public profile snapshot, hashtag generator | core ready |

Shared foundation in [`packages/`](packages/): i18n (EN/pt-BR), rate limiting (KV),
auth (Telegram WebApp signature verification), credits ledger (D1), Stars payment
webhook handling and HMAC license signing.

## Architecture

- **Runtime:** Cloudflare Workers (free tier) — one worker per bot, one shared D1 database.
- **No servers.** No VM, no ffmpeg binaries anywhere. Everything is native `fetch` + edge compute.
- **We never host media.** ClipGrab resolves *public* content to a direct download URL and replies with that link; the user downloads straight from the source platform.
- **Free tier discipline:** every feature must fit Cloudflare's free allowances (100k req/day Workers, 5GB D1, KV free tier). If a platform changes its endpoints, the resolver degrades gracefully and is repaired reactively.

## Honest limitations

- **YouTube: not supported yet.** Public Cobalt instances prohibit commercial use, and self-hosting requires ffmpeg/binaries unavailable on Workers. YouTube ships only when we have our own extraction infrastructure. See [ClipGrab README](apps/clipgrab/README.md).
- Platform resolvers are inherently fragile (platforms change endpoints without notice). Each one is isolated in its own module with its own tests so breakage never leaks across apps.

## Development

```bash
npm install
npm test          # vitest across all workspaces
```

## Deploy

See [deploy.md](deploy.md).

---
Built by [@chr-z](https://github.com/chr-z). MIT licensed.
