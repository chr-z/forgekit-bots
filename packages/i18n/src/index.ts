/**
 * forgekit-i18n — tiny i18n for Telegram bots (EN + pt-BR).
 *
 * Convention: every dictionary MUST have a complete `en` entry set.
 * Missing keys fall back to English, then to the raw key (so a broken
 * locale never renders an empty message).
 */

export type Locale = "en" | "pt-BR";

export type Dict = Record<Locale, Record<string, string>>;

/** Normalize a Telegram language_code to a supported locale. */
export function parseLocale(langCode?: string | null): Locale {
  if (!langCode) return "en";
  const lower = langCode.toLowerCase();
  return lower.startsWith("pt") ? "pt-BR" : "en";
}

const PLACEHOLDER = /\{(\w+)\}/g;

export type Params = Record<string, string | number>;

/** Translate `key` for `locale`, interpolating `{param}` placeholders. */
export function t(dict: Dict, locale: Locale, key: string, params?: Params): string {
  let template = dict[locale]?.[key] ?? dict.en[key];
  if (template === undefined) return key;
  if (params) {
    template = template.replace(PLACEHOLDER, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  }
  return template;
}

/** CI guard: report keys present in the reference list but missing per locale. */
export function assertKeysAligned(
  dict: Dict,
  keys: readonly string[],
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const locale of Object.keys(dict) as Locale[]) {
    for (const key of keys) {
      if (!(key in dict[locale])) missing.push(`${locale}:${key}`);
    }
  }
  return { ok: missing.length === 0, missing };
}
