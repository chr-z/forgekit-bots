/**
 * VoiceClone Alerts — keyword matching over channel posts.
 *
 * Pure module (no I/O) so matching behavior is exhaustively unit-tested:
 * Brazilian audiences expect accent- and case-insensitive matching
 * ("Pagamento" hits "pagamento", "PAGAMENTO", "pagamentô"), and whole-word
 * semantics avoid the classic substring false positive ("CEO" must not
 * trigger on "oceano").
 */

/** Fold case + accents + repeated whitespace into a comparable form. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Return the subset of `terms` whose normalized form occurs as a whole
 * word in `text` (accent/case-insensitive). Order follows the input term
 * list; result capped at `max` to keep alert messages short.
 */
export function matchTerms(text: string, terms: readonly string[], max = 3): string[] {
  const hay = normalizeText(text);
  if (!hay) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const needle = normalizeText(raw);
    if (!needle || seen.has(needle)) continue;
    seen.add(needle);
    const re = new RegExp(
      `(^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}([^\\p{L}\\p{N}]|$)`,
      "u",
    );
    if (re.test(hay)) {
      out.push(raw.trim());
      if (out.length >= max) break;
    }
  }
  return out;
}

const T_ME_RE = /^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]+)\/?$/;
const HANDLE_RE = /^[A-Za-z0-9_]{4,64}$/;

/**
 * Parse a /addchannel argument into something BotApi.getChat accepts:
 * a numeric chat id ("-1001234567890") or an "@handle". Accepts raw ids,
 * @handles, bare handles and t.me links. Returns null when unparseable.
 */
export function parseChannelArg(arg: string): string | null {
  const a = arg.trim();
  if (!a) return null;
  if (/^-?\d+$/.test(a)) return a;
  const link = T_ME_RE.exec(a);
  if (link) return `@${link[1]}`;
  const bare = a.startsWith("@") ? a.slice(1) : a;
  return HANDLE_RE.test(bare) ? `@${bare}` : null;
}
