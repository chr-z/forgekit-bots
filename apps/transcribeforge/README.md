# TranscribeForge 🎙️→📝

**Telegram bot that transcribes audio/video to text + SRT/VTT subtitles** using
Cloudflare Workers AI (Whisper) — no servers, pay-per-minute via credits.

## What it does

| | |
|---|---|
| Send an audio/video file (≤20MB bot API limit) | → transcript in your language |
| Free tier | 10 minutes/month, plain text |
| Credits (`/buy`) | R$10 ≈ 300 Stars packs → extra minutes, **never expire** |

## Pipeline

```
file upload ──► Telegram getFile ──► fetch bytes ──► Workers AI (@cf/openai/whisper)
                                                        │
                        words[] ──► wordsToSegments ──► SRT / VTT / TXT formatters
```

- Word-level timings are grouped into subtitle-sized cues
  (`src/whisper.ts`): sentence boundaries, char budget, gap & duration caps.
- Failed jobs are never charged — the credit spend happens only after the quota gate,
  and errors reply honestly.

## Files

- `src/formatters.ts` — pure SRT/VTT/TXT rendering (fully unit-tested)
- `src/whisper.ts` — Workers AI client + cue grouping
- `src/index.ts` — webhook worker: auth → attachment detection → quota → transcribe

Part of [ForgeKit Bots](../../README.md).
