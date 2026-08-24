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
import { reviewPreCheckout, fulfillSuccessfulPayment, type StarProduct } from "@forgekit/stars";
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
    status: "ClipGrab status\n• TikTok: supported (watermark-free when available)\n• Instagram posts/reels: supported\n• YouTube: coming soon — needs our own extraction infra\n• Free quota: {used}/{limit} today{pro_line}",
    resolving: "Resolving your {platform} link…",
    here_your_link: "Here's your {platform} file ({quality}):",
    link_expires: "The link is temporary — download soon.",
    carousel: "This post has multiple files (carousel) — not supported yet, only single posts/reels.",
    failed: "Couldn't extract this one ({details}).\nThe platform probably changed something — it's logged and will be fixed.",
    buy_intro: "ClipGrab Pro: unlimited links, no waiting — {stars} Stars / 30 days.\nCredit pack: {pack_stars} Stars for 100 downloads (never expires).",
    pro_active: "You're Pro — unlimited until {until}.",
    payment_credits: "Payment confirmed — 100 credits added. Thanks!",
    balance: "Credits available: {balance}.",
  },
  "pt-BR": {
    start: "Me manda um link público do TikTok ou Instagram que eu respondo com o link direto de download.\n\nGrátis: 3 links/dia. /buy para ilimitado.\nYouTube: em breve (precisa de infra própria).",
    unsupported_platform: "Por enquanto eu só resolvo links públicos do TikTok e Instagram.\nSuporte ao YouTube está planejado — vê o /status.",
    not_a_link: "Isso não parece um link. Manda algo como https://vt.tiktok.com/...",
    quota_exceeded: "Limite diário grátis atingido ({limit}/dia). Reseta em {hours}h — ou vire ilimitado com /buy.",
    status: "Status do ClipGrab\n• TikTok: suportado (sem marca d'água quando disponível)\n• Instagram posts/reels: suportado\n• YouTube: em breve — precisa de infra própria de extração\n• Cota grátis hoje: {used}/{limit}{pro_line}",
    resolving: "Resolvendo seu link de {platform}…",
    here_your_link: "Aqui está seu arquivo de {platform} ({quality}):",
    link_expires: "O link é temporário — baixa logo.",
    carousel: "Esse post tem vários arquivos (carrossel) — ainda não suportado, só posts/reels únicos.",
    failed: "Não consegui extrair esse ({details}).\nA plataforma provavelmente mudou alguma coisa — está logado e será corrigido.",
    buy_intro: "ClipGrab Pro: links ilimitados, sem espera — {stars} Stars / 30 dias.\nPacote de créditos: {pack_stars} Stars por 100 downloads (não expira).",
    pro_active: "Você é Pro — ilimitado até {until}.",
    payment_credits: "Pagamento confirmado — 100 créditos adicionados. Valeu!",
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

    if (route.kind === "successful_payment") {
      // Idempotent by telegram_payment_charge_id (star_payments PK).
      if (!route.ctx.user) return new Response("ok"); // no payer identity -> nothing to credit
      await fulfillSuccessfulPayment(env.DB, { ...route.payment, from: { id: route.ctx.user.id } }, CLIPGRAB_CATALOG);
      const isSub = route.payment.invoice_payload.startsWith("sub:");
      await bot.sendMessage(
        route.ctx.chatId,
        isSub
          ? t(MESSAGES, parseLocale(route.ctx.user?.language_code), "pro_active", {
              until: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
            })
          : t(MESSAGES, parseLocale(route.ctx.user?.language_code), "payment_credits"),
      );
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

    if (command === "/status") {
      const { pro, proUntil } = await isPro(env.DB, user.id);
      const limiter = new RateLimiter(env.KV, { freeLimit: FREE_DAILY_LIMIT });
      const { used } = await limiter.peek("clipgrab", `user:${user.id}`);
      await bot.sendMessage(
        chatId,
        t(MESSAGES, locale, "status", {
          used,
          limit: FREE_DAILY_LIMIT,
          pro_line: pro ? `\n• Pro active until ${proUntil!.slice(0, 10)} — unlimited` : "",
        }),
      );
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
