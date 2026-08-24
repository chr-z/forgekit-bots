/**
 * ClipGrab — TikTok & Instagram download links, serverless.
 *
 * The user sends a link; we resolve it to a direct media URL and reply
 * with that link (we never host or proxy the file). Free tier: N/day via
 * KV rate limit; Pro/credits: exempt from the daily cap.
 */

import { verifyUpdateSignature } from "@forgekit/auth";
import { parseLocale, t } from "@forgekit/i18n";
import { RateLimiter } from "@forgekit/ratelimit";
import { reviewPreCheckout, type StarProduct } from "@forgekit/stars";
import { BotApi, type TgUpdate } from "@forgekit/app-shared";
import { extractUrl, parseUpdate } from "@forgekit/app-shared";

import { routeResolve } from "./routing";
import type { ResolveResult } from "./types";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  KV: KVNamespace;
  /** D1 shared database (credits ledger). */
  DB: D1Database;
}

export const CLIPGRAB_CATALOG: StarProduct[] = [
  {
    productId: "sub:clipgrab-pro",
    title: "ClipGrab Pro — 30 days",
    description: "Unlimited links, no waiting, batch mode.",
    priceInStars: 300,
    kind: "subscription",
    proDays: 30,
  },
  {
    productId: "pack:c100",
    title: "100 extra downloads",
    description: "Credit pack, never expires.",
    priceInStars: 150,
    kind: "credits",
    creditsAmount: 100,
  },
];

const FREE_DAILY_LIMIT = 3;

const MESSAGES = {
  en: {
    start: "Send me a public TikTok or Instagram link and I'll reply with a direct download link.\n\nFree: 3 links/day. /buy for unlimited.\nYouTube: coming soon (needs dedicated infra).",
    unsupported_platform: "I only handle TikTok and Instagram public links right now.\nYouTube support is planned — see /status.",
    not_a_link: "That doesn't look like a link. Send something like https://vt.tiktok.com/...",
    quota_exceeded: "Daily free limit reached ({limit}/day). Resets in {hours}h — or get unlimited with /buy.",
    resolving: "Resolving your {platform} link…",
    here_your_link: "Here's your {platform} file ({quality}):",
    link_expires: "The link is temporary — download soon.",
    carousel: "This post has multiple files (carousel) — not supported yet, only single posts/reels.",
    failed: "Couldn't extract this one ({details}).\nThe platform probably changed something — it's logged and will be fixed.",
    buy_intro: "ClipGrab Pro: unlimited links, no waiting — {stars} Stars / 30 days.\nCredit pack: {pack_stars} Stars for 100 downloads (never expires).",
    pro_active: "You're Pro — unlimited until {until}.",
    balance: "Credits available: {balance}.",
  },
  "pt-BR": {
    start: "Me manda um link público do TikTok ou Instagram que eu respondo com o link direto de download.\n\nGrátis: 3 links/dia. /buy para ilimitado.\nYouTube: em breve (precisa de infra própria).",
    unsupported_platform: "Por enquanto eu só resolvo links públicos do TikTok e Instagram.\nSuporte ao YouTube está planejado — vê o /status.",
    not_a_link: "Isso não parece um link. Manda algo como https://vt.tiktok.com/...",
    quota_exceeded: "Limite diário grátis atingido ({limit}/dia). Reseta em {hours}h — ou vire ilimitado com /buy.",
    resolving: "Resolvendo seu link de {platform}…",
    here_your_link: "Aqui está seu arquivo de {platform} ({quality}):",
    link_expires: "O link é temporário — baixa logo.",
    carousel: "Esse post tem vários arquivos (carrossel) — ainda não suportado, só posts/reels únicos.",
    failed: "Não consegui extrair esse ({details}).\nA plataforma provavelmente mudou alguma coisa — está logado e será corrigido.",
    buy_intro: "ClipGrab Pro: links ilimitados, sem espera — {stars} Stars / 30 dias.\nPacote de créditos: {pack_stars} Stars por 100 downloads (não expira).",
    pro_active: "Você é Pro — ilimitado até {until}.",
    balance: "Créditos disponíveis: {balance}.",
  },
};

const QUALITY_LABEL: Record<"yes" | "no", { en: string; "pt-BR": string }> = {
  yes: { en: "no watermark", "pt-BR": "sem marca d'água" },
  no: { en: "standard", "pt-BR": "padrão" },
};

function replyFor(result: ResolveResult, locale: "en" | "pt-BR"): string {
  switch (result.kind) {
    case "ok": {
      const quality = QUALITY_LABEL[result.watermarkFree ? "yes" : "no"]![locale];
      return [
        t(MESSAGES, locale, "here_your_link", { platform: result.platform, quality }),
        result.directUrl,
        t(MESSAGES, locale, "link_expires"),
      ].join("\n");
    }
    case "unsupported":
      return t(MESSAGES, locale, "unsupported_platform");
    case "failed":
      // Details are generic on purpose; raw reasons go to logs only.
      return t(MESSAGES, locale, "failed", { details: result.platform });
  }
}

async function isPro(db: D1Database, userId: number): Promise<{ pro: boolean; proUntil?: string }> {
  const row = await db
    .prepare("SELECT pro_until FROM subscriptions WHERE tg_user_id = ?")
    .bind(userId)
    .first<{ pro_until: string }>();
  const active = !!row?.pro_until && new Date(row.pro_until).getTime() > Date.now();
  return { pro: active, proUntil: row?.pro_until };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("clipgrab worker up", { status: 200 });
    }
    if (!verifyUpdateSignature(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)) {
      return new Response("bad secret", { status: 401 });
    }

    const update = (await request.json()) as TgUpdate;
    const route = parseUpdate(update);
    const bot = new BotApi(env.TELEGRAM_BOT_TOKEN);

    if (route.kind === "pre_checkout") {
      const review = reviewPreCheckout({ invoice_payload: route.payload }, CLIPGRAB_CATALOG);
      await bot.answerPreCheckoutQuery(route.queryId, review.ok, review.errorMessage);
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
      // Invoice buttons are sent by the client wrapper in production; the text explains the catalog.
      await bot.sendMessage(chatId, t(MESSAGES, locale, "buy_intro", { stars: 300, pack_stars: 150 }));
      return new Response("ok");
    }

    if (command === "/link" || command === "/dl") {
      const url = extractUrl(args);
      if (!url) {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "not_a_link"));
        return new Response("ok");
      }

      const { pro } = await isPro(env.DB, user.id);
      const limiter = new RateLimiter(env.KV, { freeLimit: FREE_DAILY_LIMIT });
      const gate = await limiter.consume("clipgrab", `user:${user.id}`, pro);
      if (!gate.allowed && !pro) {
        await bot.sendMessage(
          chatId,
          t(MESSAGES, locale, "quota_exceeded", {
            limit: gate.limit,
            hours: Math.max(1, Math.ceil(gate.resetAfter / 3600)),
          }),
        );
        return new Response("ok");
      }

      const result = await routeResolve(url);
      if (result.kind === "unsupported" && !url.hostname.includes("tiktok") && !url.hostname.includes("instagram")) {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "unsupported_platform"));
        return new Response("ok");
      }
      await bot.sendMessage(chatId, replyFor(result, locale));
      return new Response("ok");
    }

    return new Response("ok");
  },
};
