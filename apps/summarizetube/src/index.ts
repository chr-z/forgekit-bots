/**
 * SummarizeTube — paste a YouTube link, get a structured summary.
 *
 * Pipeline: link -> caption extraction (pure JS, no binaries) -> Workers AI
 * map-reduce summary with [mm:ss] citations -> Telegram reply. Free: 3
 * short summaries/day; Pro: unlimited + deep mode; credit packs extend
 * the free quota (1 credit per summary).
 *
 * Free-tier discipline: caption fetch is one HTTP GET to youtube.com plus
 * one to the timedtext endpoint; AI runs only on captions. Failures never
 * charge anything.
 */

import { verifyUpdateSignature } from "@forgekit/auth";
import { grantCredits, spendCredits } from "@forgekit/credits";
import { parseLocale, t } from "@forgekit/i18n";
import { RateLimiter } from "@forgekit/ratelimit";
import { reviewPreCheckout, fulfillSuccessfulPayment, type StarProduct } from "@forgekit/stars";
import { renderPdf } from "./pdf";
import { BotApi, type TgUpdate } from "@forgekit/app-shared/botapi";
import { extractUrl, parseUpdate } from "@forgekit/app-shared/updates";

import {
  buildTimestampIndex,
  chunkTranscript,
  cuesToTranscript,
  extractPlayerResponse,
  fetchCaptions,
  parseVideoId,
  pickCaptionTrack,
} from "./youtube";
import {
  aiSummarize,
  extractiveFallback,
  renderSummary,
  SUMMARIZE_MODEL_FREE,
} from "./summarizer";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  KV: KVNamespace;
  /** D1 shared database (credits ledger). */
  DB: D1Database;
  /** Workers AI binding. */
  AI: Ai;
}

export const SUMMARIZETUBE_CATALOG: StarProduct[] = [
  {
    productId: "sub:summarizetube-pro",
    title: "SummarizeTube Pro — 30 days",
    description: "Unlimited summaries, deep mode, priority queue.",
    priceInStars: 200,
    kind: "subscription",
    proDays: 30,
  },
  {
    productId: "pack:s100",
    title: "100 extra summaries",
    description: "Credit pack, never expires.",
    priceInStars: 150,
    kind: "credits",
    creditsAmount: 100,
  },
];

export const FREE_DAILY_LIMIT = 3;

const MESSAGES = {
  en: {
    start: "Send me a YouTube link and I'll reply with a structured summary (TLDR + key points with timestamps).\n\nFree: 3 summaries/day. /buy for unlimited + deep mode.",
    not_a_youtube_link: "That doesn't look like a YouTube link. Try https://youtu.be/... or a youtube.com/watch?v=... URL.",
    quota_exceeded: "Daily free limit reached ({limit}/day). Resets in {hours}h — or get unlimited with /buy.",
    payment_ok: "Payment confirmed — {amount} Stars received. Thanks!",
    working: "Watching the video… this can take a moment.",
    no_captions: "This video has no usable captions (neither manual nor auto-generated), so I can't summarize it honestly.",
    failed: "Couldn't process this video right now.\nYouTube changes things often — it's logged and will be fixed. Nothing was charged.",
    buy_intro: "SummarizeTube Pro: unlimited summaries + deep mode — {stars} Stars / 30 days.\nCredit pack: {pack_stars} Stars for 100 extra summaries (never expires).",
    balance: "\n\nCredit used — balance left: {balance}.",
    export_pro_only: "PDF export is a Pro feature. /buy to unlock unlimited summaries, deep mode and PDF export.",
    export_nothing: "No recent summary to export — send me a YouTube link first.",
    export_failed: "Couldn't generate the PDF right now. Nothing was charged — try again in a minute.",
  },
  "pt-BR": {
    start: "Me manda um link do YouTube que eu respondo com um resumo estruturado (TLDR + pontos-chave com timestamps).\n\nGrátis: 3 resumos/dia. /buy para ilimitado + modo profundo.",
    not_a_youtube_link: "Isso não parece um link do YouTube. Tenta https://youtu.be/... ou uma URL youtube.com/watch?v=...",
    quota_exceeded: "Limite diário grátis atingido ({limit}/dia). Reseta em {hours}h — ou vire ilimitado com /buy.",
    payment_ok: "Pagamento confirmado — {amount} Stars recebidos. Valeu!",
    working: "Assistindo ao vídeo… pode demorar um pouco.",
    no_captions: "Esse vídeo não tem legendas utilizáveis (nem manuais nem automáticas), então não dá pra resumir com honestidade.",
    failed: "Não consegui processar esse vídeo agora.\nO YouTube muda as coisas com frequência — está logado e será corrigido. Nada foi cobrado.",
    buy_intro: "SummarizeTube Pro: resumos ilimitados + modo profundo — {stars} Stars / 30 dias.\nPacote de créditos: {pack_stars} Stars por 100 resumos extras (não expira).",
    balance: "\n\nCrédito usado — saldo restante: {balance}.",
    export_pro_only: "Exportar PDF é recurso Pro. /buy libera resumos ilimitados, modo profundo e PDF.",
    export_nothing: "Sem resumo recente pra exportar — me manda um link do YouTube antes.",
    export_failed: "Não consegui gerar o PDF agora. Nada foi cobrado — tenta de novo em um minuto.",
  },
};

async function isPro(db: D1Database, userId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT pro_until FROM subscriptions WHERE tg_user_id = ?")
    .bind(userId)
    .first<{ pro_until: string }>();
  return !!row?.pro_until && new Date(row.pro_until).getTime() > Date.now();
}

/** KV key holding the last summary doc of a user (source for /export pdf). */
export function lastDocKey(userId: number): string {
  return `summarizetube:lastdoc:${userId}`;
}

interface PipelineInput {
  videoId: string;
  deep: boolean;
}

interface PipelineOutput {
  ok: boolean;
  reply?: string;
  reason?: "no_captions" | "failed";
  /** Structured summary payload for the Pro PDF export. */
  doc?: SummaryDoc;
}

/** Everything renderPdf needs — decoupled from the Telegram reply string. */
export interface SummaryDoc {
  title?: string;
  author?: string;
  durationSeconds?: number;
  tldr: string;
  bullets: string[];
}

/**
 * Core pipeline, separated from I/O glue so tests can drive it with fakes:
 * watch page -> player response -> caption track -> cues -> transcript ->
 * timestamp index -> chunks -> AI map-reduce (fallback: extractive).
 */
export async function runSummaryPipeline(
  input: PipelineInput,
  deps: {
    fetchImpl?: typeof fetch;
    ai?: Ai;
    model?: string;
  } = {},
): Promise<PipelineOutput> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = deps.model ?? SUMMARIZE_MODEL_FREE;

  let playerResponse;
  try {
    const pageRes = await fetchImpl(`https://www.youtube.com/watch?v=${input.videoId}&hl=en`, {
      headers: {
        // A plain browser UA keeps the consent-wall away in most regions.
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!pageRes.ok) throw new Error(`watch page ${pageRes.status}`);
    playerResponse = extractPlayerResponse(await pageRes.text());
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (!playerResponse) return { ok: false, reason: "failed" };

  const tracks =
    playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = pickCaptionTrack(tracks);
  if (!track) return { ok: false, reason: "no_captions" };

  let cues;
  try {
    cues = await fetchCaptions(track.baseUrl, fetchImpl);
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (!cues?.length) return { ok: false, reason: "no_captions" };

  const transcript = cuesToTranscript(cues);
  const indexText = buildTimestampIndex(cues);
  const chunks = chunkTranscript(transcript);
  // Deep mode only makes sense when there is more than one map pass.
  const deep = input.deep && chunks.length > 1;

  let summary = null;
  if (deps.ai) {
    try {
      summary = await aiSummarize(deps.ai, model, chunks, deep);
    } catch {
      summary = null;
    }
  }
  summary = summary ?? extractiveFallback(indexText);

  const videoMeta = {
    title: playerResponse.videoDetails?.title,
    author: playerResponse.videoDetails?.author,
    durationSeconds: playerResponse.videoDetails?.lengthSeconds
      ? parseInt(playerResponse.videoDetails.lengthSeconds, 10)
      : undefined,
    languageCode: track.languageCode,
  };

  return {
    ok: true,
    reply: renderSummary(videoMeta, summary, deep),
    doc: {
      title: videoMeta.title,
      author: videoMeta.author,
      durationSeconds: videoMeta.durationSeconds,
      tldr: summary.tldr,
      bullets: [...summary.bullets],
    },
  };
}

/** Deep mode is a Pro perk; free users always get the short form. */
export function resolveMode(pro: boolean, args: string): { deep: boolean } {
  return { deep: pro && /\b(deep|profundo)\b/i.test(args) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("summarizetube worker up", { status: 200 });
    }
    if (!verifyUpdateSignature(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)) {
      return new Response("bad secret", { status: 401 });
    }

    const update = (await request.json()) as TgUpdate;
    const route = parseUpdate(update);
    const bot = new BotApi(env.TELEGRAM_BOT_TOKEN);

    if (route.kind === "pre_checkout") {
      const review = reviewPreCheckout({ invoice_payload: route.payload }, SUMMARIZETUBE_CATALOG);
      await bot.answerPreCheckoutQuery(route.queryId, review.ok, review.errorMessage);
      return new Response("ok");
    }

    if (route.kind === "successful_payment") {
      // Idempotent by telegram_payment_charge_id (star_payments PK).
      if (route.ctx.user) {
        await fulfillSuccessfulPayment(
          env.DB,
          { ...route.payment, from: { id: route.ctx.user.id } },
          SUMMARIZETUBE_CATALOG,
        );
        const locale = parseLocale(route.ctx.user.language_code);
        await bot.sendMessage(
          route.ctx.chatId,
          t(MESSAGES, locale, "payment_ok", { amount: route.payment.total_amount }),
        );
      }
      return new Response("ok");
    }

    if (route.kind !== "command") return new Response("ok");
    const { command, args, chatId, user } = route.ctx;
    const locale = parseLocale(user.language_code);

    if (command === "/start" || command === "/help") {
      await bot.sendMessage(chatId, t(MESSAGES, locale, "start"));
      return new Response("ok");
    }

    if (command === "/buy") {
      await bot.sendMessage(chatId, t(MESSAGES, locale, "buy_intro", { stars: 200, pack_stars: 150 }));
      return new Response("ok");
    }

    // /export pdf — Pro perk: re-render the last summary of this chat as a PDF document.
    if (command === "/export") {
      const pro = await isPro(env.DB, user.id);
      if (!pro) {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "export_pro_only"));
        return new Response("ok");
      }
      const raw = args.trim().toLowerCase();
      const kind = raw === "" ? "pdf" : raw.split(/\s+/)[0];
      const docJson = await env.KV.get(lastDocKey(user.id));
      if (kind !== "pdf" || !docJson) {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "export_nothing"));
        return new Response("ok");
      }
      let doc: SummaryDoc;
      try {
        doc = JSON.parse(docJson) as SummaryDoc;
      } catch {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "export_failed"));
        return new Response("ok");
      }
      try {
        const bytes = await renderPdf(doc);
        const safeTitle =
          (doc.title ?? "summary").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) ||
          "summary";
        await bot.sendDocument(chatId, `${safeTitle}.pdf`, bytes);
      } catch {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "export_failed"));
        return new Response("ok");
      }
      return new Response("ok");
    }

    if (command === "/summarize" || command === "/s") {
      const url = extractUrl(args);
      const videoId = url ? parseVideoId(url.toString()) : null;
      if (!videoId) {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "not_a_youtube_link"));
        return new Response("ok");
      }

      const pro = await isPro(env.DB, user.id);
      const limiter = new RateLimiter(env.KV, { freeLimit: FREE_DAILY_LIMIT });
      const gate = await limiter.consume("summarizetube", `user:${user.id}`, pro);

      // Beyond the free daily window a credit-pack credit covers one summary.
      let creditBalance: number | null = null;
      if (!gate.allowed && !pro) {
        creditBalance = await spendCredits(
          env.DB,
          user.id,
          1,
          `summary:${videoId.slice(0, 12)}`,
        ).catch(() => null);
        if (creditBalance === null) {
          await bot.sendMessage(
            chatId,
            t(MESSAGES, locale, "quota_exceeded", {
              limit: gate.limit,
              hours: Math.max(1, Math.ceil(gate.resetAfter / 3600)),
            }),
          );
          return new Response("ok");
        }
      }

      const { deep } = resolveMode(pro, args);
      await bot.sendMessage(chatId, t(MESSAGES, locale, "working"));

      const result = await runSummaryPipeline({ videoId, deep }, { ai: env.AI });

      if (!result.ok || !result.reply) {
        // A paid credit for a failed summary is refunded — failures never charge.
        if (creditBalance !== null) {
          await grantCredits(env.DB, user.id, 1, `refund:${videoId.slice(0, 12)}`).catch(() => null);
        }
        const key = result.reason === "no_captions" ? "no_captions" : "failed";
        await bot.sendMessage(chatId, t(MESSAGES, locale, key));
        return new Response("ok");
      }

      const suffix =
        creditBalance !== null ? t(MESSAGES, locale, "balance", { balance: creditBalance }) : "";
      await bot.sendMessage(chatId, result.reply + suffix);

      // Remember the structured doc so /export pdf can re-render it (Pro perk).
      if (result.doc) {
        await env.KV.put(lastDocKey(user.id), JSON.stringify(result.doc), { expirationTtl: 7 * 86400 });
      }
      return new Response("ok");
    }

    return new Response("ok");
  },
};
