/**
 * VoiceClone PDF export — maps a page of the alert history onto the shared
 * @forgekit/app-shared/pdf writer (same engine SummarizeTube and DocuMind
 * use for their Pro exports). Pure module: unit-testable without D1.
 *
 * Free users never reach this path — the /history handler gates it with the
 * same isPro() check that already guards the text history.
 */
import { renderPdf, type PdfDoc } from "@forgekit/app-shared/pdf";

/** One alert as read out of vc_alerts (store.listAlertHistory row shape). */
export interface HistoryRowLike {
  terms: string;
  title: string;
  excerpt: string;
  created_at: string;
  delivered: number;
}

/** Telegram hard cap; keep the confirmation caption well inside it. */
export const EXPORT_CAPTION_MAX = 200;

/**
 * Map one history page (newest first) to the shared PdfDoc.
 * - title: "VoiceClone Alerts" + page/total header line as first bullet;
 * - tldrLabel "Alertas" / "Alerts": the page's own headline, not "TLDR";
 * - each bullet = one alert: `• <created_at> · <channel> · terms — excerpt`
 *   with ` · retry` appended when delivery went through the retry queue.
 */
export function historyToPdfDoc(
  rows: readonly HistoryRowLike[],
  page: number,
  total: number,
  locale: string,
): PdfDoc {
  const pt = locale.toLowerCase().startsWith("pt");
  const bullets: string[] = [
    pt ? `Página ${page} de até 20 alertas — ${total} no total` : `Page ${page} of up to 20 alerts — ${total} in total`,
    "",
  ];
  for (const r of rows) {
    const ex = r.excerpt.length > 80 ? `${r.excerpt.slice(0, 77)}…` : r.excerpt;
    const retry = r.delivered ? "" : pt ? " · na fila de reenvio" : " · retry queue";
    bullets.push(`• ${r.created_at} · ${r.title} · ${r.terms}${retry}\n  ${ex}`);
  }
  return {
    title: "VoiceClone Alerts",
    author: "@chr-z",
    tldrLabel: pt ? "Alertas" : "Alerts",
    tldr: pt
      ? `Histórico de alertas — página ${page} (${total} no total)`
      : `Alert history — page ${page} (${total} total)`,
    bullets,
  };
}

/** Safe filename for Telegram's sendDocument (mirrors SummarizeTube's rule). */
export function exportFileName(page: number): string {
  return `voiceclone-history-p${Math.max(1, Math.floor(page))}.pdf`;
}

/** Caption under the document; truncated to stay inside Telegram's limit. */
export function exportCaption(total: number, locale: string): string {
  const raw = locale.toLowerCase().startsWith("pt")
    ? `📜 Histórico exportado — ${total} alerta(s) no total.`
    : `📜 Exported history — ${total} alert(s) in total.`;
  return raw.length > EXPORT_CAPTION_MAX ? `${raw.slice(0, EXPORT_CAPTION_MAX - 1)}…` : raw;
}

/** Render the full PDF bytes for a history page (thin wrapper over renderPdf). */
export function renderHistoryPdf(
  rows: readonly HistoryRowLike[],
  page: number,
  total: number,
  locale: string,
): Promise<Uint8Array> {
  return renderPdf(historyToPdfDoc(rows, page, total, locale));
}
