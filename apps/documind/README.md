# DocuMind

Send a **PDF, DOCX or text file** to the bot, then ask questions about it —
answers cite the exact passages (`[1]`, `[2]`).

## How it works (no paid infra)

1. **Ingest** — the bot downloads the file via the Telegram Bot API (20MB
   hard cap) and extracts text serverlessly:
   - PDFs: pure-TypeScript extractor — finds `stream…endstream` payloads,
     inflates `FlateDecode` with the Workers-native `DecompressionStream`,
     and pulls text from `Tj/TJ` show-text operators. No wasm, no binaries.
   - DOCX (Office Open XML): pure-TypeScript ZIP reader — walks the central
     directory, inflates raw-deflate entries (`DecompressionStream("deflate-raw")`),
     verifies CRC-32 of every part and converts `word/document.xml`
     (+header/footer parts) to text honoring paragraphs, tabs and breaks.
     Legacy binary `.doc` is NOT supported.
   - Text files (.txt/.md/.csv/.log/json): decoded as UTF-8.
2. **Index** — text is split into sentence-packed numbered chunks that keep
   their **source page** and are stored in D1 (`dm_docs`, `dm_chunks`)
   alongside the shared credits ledger.
3. **Ask** — keyword-overlap retrieval picks the top passages; Workers AI
   (llama-3.1-8b-instruct) answers strictly from them and must cite `[n]`.
   Replies without citations degrade to a deterministic extractive answer.
   The model can also answer honestly `NOT_IN_DOCUMENT`. Every answer ends
   with a `Fontes: p. 1, 3` sources line — citations point at real pages.

Deliberate simplification: retrieval is keyword scoring, not embeddings —
Vectorize's free allowance requires a paid Workers plan in practice. Zero
marginal cost per question by construction.

## Commands

- attach a **PDF/DOCX/txt** → indexed (`/docs`, `/use <id>`, `/forget <id|all>`)
- `/ask <question>` → answer citing exact passages `[1] p.2` + `Fontes:` page summary
- `/export [pdf]` *(Pro)* → re-renders the last answered question as a real
  PDF document (pure-TS shared writer, sanitized filename, 7-day window)

## Honest limitations

- Scanned/image-only PDFs are refused ("no readable text") — we never
  invent content from documents we cannot actually read. The same applies
  to DOCX containers with empty/text-less bodies or corrupted entries
  (CRC mismatch refuses the whole file — no partial guesses).
- Pagination is approximate: one index unit per content stream, not per
  visual page.
- Exotic PDF encodings (non-Flate filters like LZW/DCT, subsetted CMaps)
  may yield partial or no text — extraction degrades honestly instead of
  guessing.

## Pricing

| | Free | Pro |
|---|---|---|
| Documents | 2 / 30 days | unlimited |
| Questions | 10 / 30 days | 500 / 30 days |
| Retrieval size | top 4 passages | top 6 passages |

Pro: **300 Stars / 30 days** · Credit pack: **150 Stars = 150 questions**
(never expires). Payments via Telegram Stars only.

## Commands

- attach a `.pdf`/`.docx`/`.txt` file → indexes it
- `/ask <question>` (alias `/q`) — ask the active (latest) document
- `/docs`, `/use <id>`, `/forget <id>|all` — library management
- `/buy` — Pro + credit packs
