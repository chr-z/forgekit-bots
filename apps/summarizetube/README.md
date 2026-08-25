# SummarizeTube

Paste a **YouTube link**, get a structured summary back: TLDR, key points
with `[mm:ss]` timestamps and the cleaned-up transcript.

## How it works (no paid infra)

1. **Link parsing** — any YouTube URL shape (`youtu.be/...`,
   `youtube.com/watch?v=...`, shorts, embeds) is reduced to the video id.
2. **Caption extraction (pure JS, no binaries)** — the Worker fetches the
   watch page, brace-matches `ytInitialPlayerResponse` out of it, picks the
   best caption track (manual > ASR, user language first) and pulls the
   timedtext track (json3 or legacy XML). No ffmpeg, no youtube-dl.
3. **Summarize** — the transcript is chunked and summarized by Workers AI
   (`@cf/meta/llama-3.1-8b-instruct`) with a map-reduce pass; every claim in
   the summary carries a `[mm:ss]` citation resolved against the real cue
   timeline. **Deep mode** (Pro) runs more chunks per video for longer,
   denser summaries.
4. **`/transcript` (Pro)** — the cleaned transcript is cached alongside the
   summary and can be re-delivered at any time within 7 days: fully inline
   when it fits a message, otherwise a paragraph-boundary preview plus a
   `.txt` file; `/transcript pdf` renders a real PDF through the shared
   writer (`@forgekit/app-shared/pdf`).

Free-tier discipline by construction: caption fetch is one GET to
youtube.com plus one to the timedtext endpoint; AI runs only on captions.
Failures never charge anything.

## Honest limitations

- Videos with **no usable captions** (neither manual nor auto-generated)
  are refused — we never invent content we cannot actually read.
- YouTube changes its player surface without notice; each step degrades to
  an honest failure message and gets fixed reactively.
- Chapters are derived from the caption timeline, not from the description
  metadata.

## Pricing

| | Free | Pro |
|---|---|---|
| Summaries | 3 / day | unlimited |
| Mode | short | deep (more chunks per video) |
| Transcript | — | `/transcript` (inline, `.txt` or PDF) |
| Notion export | — | `/connect <token> <page>` links workspace; `/export notion` pushes the last summary as a child page (token never echoed; validated via `api.notion.com/v1/users/me`) |

- **Pro:** 200 Stars / 30 days — unlimited + deep mode + priority queue.
- **Credit pack:** 150 Stars for 100 extra summaries (never expires).
- Payments are Telegram Stars only; fulfillment is idempotent by charge id.

## Stack

Cloudflare Workers free tier · D1 (credits ledger + usage) · KV (daily rate
limit) · Workers AI. Shares `packages/core` with the fleet: credits CAS
ledger, stars fulfillment, ratelimit, i18n (EN / pt-BR).

Built by [@chr-z](https://github.com/chr-z) — part of the
[ForgeKit Bots](https://github.com/chr-z/forgekit-bots) fleet.
