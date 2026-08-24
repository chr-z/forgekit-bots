/**
 * InstaToolkit — Instagram utilities bot (public data only).
 *
 * /profile <handle>  -> public snapshot report
 * /tags <keywords>   -> balanced hashtag set
 * /buy               -> Stars subscription & credit packs
 */

import { parseLocale, t } from "@forgekit/i18n";
import { RateLimiter } from "@forgekit/ratelimit";
import { reviewPreCheckout, type StarProduct } from "@forgekit/stars";
import { BotApi, type TgUpdate } from "@forgekit/app-shared/botapi";
import { parseUpdate, type CommandContext } from "@forgekit/app-shared/updates";

import { fetchProfile, renderReport } from "./profile";
import { generateHashtags, renderTagList } from "./hashtags";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  KV: KVNamespace;
}

const FREE_DAILY = 5;

export const INSTATOOLKIT_CATALOG: StarProduct[] = [
  {
    productId: "sub:instatoolkit-pro",
    title: "InstaToolkit Pro — 30 days",
    description: "Unlimited profiles & hashtag sets.",
    priceInStars: 200,
    kind: "subscription",
    proDays: 30,
  },
];

const MESSAGES = {
  en: {
    start: "Instagram toolkit:\n/profile <handle> — public profile snapshot\n/tags <keywords> — hashtag set for your post\n\nFree: 5 commands/day. /buy for unlimited.",
    usage_profile: "Usage: /profile <handle>",
    usage_tags: "Usage: /tags coffee, business",
    profile_failed: "Couldn't read that profile right now.",
    profile_private: "That account is private or doesn't exist.",
    tags_empty: "Give me at least one keyword.",
  },
  "pt-BR": {
    start: "Kit de utilidades para Instagram:\n/perfil <@usuario> — raio-x do perfil público\n/tags <palavras> — conjunto de hashtags pro seu post\n\nGrátis: 5 comandos/dia. /buy para ilimitado.",
    usage_profile: "Uso: /perfil @usuario",
    usage_tags: "Uso: /tags cafe, negocios",
    profile_failed: "Não consegui ler esse perfil agora.",
    profile_private: "Essa conta é privada ou não existe.",
    tags_empty: "Me dá pelo menos uma palavra-chave.",
  },
};

async function isPro(db: never): Promise<boolean> {
  // Placeholder until subscriptions table is wired per-bot; Pro comes from Stars.
  return false;
}
void isPro;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("instatoolkit worker up", { status: 200 });
    const secretOk = request.headers.get("X-Telegram-Bot-Api-Secret-Token") === env.WEBHOOK_SECRET;
    if (!secretOk) return new Response("bad secret", { status: 401 });

    const update = (await request.json()) as TgUpdate;
    const route = parseUpdate(update);

    if (route.kind === "pre_checkout") {
      const bot = new BotApi(env.TELEGRAM_BOT_TOKEN);
      const review = reviewPreCheckout({ invoice_payload: route.payload }, INSTATOOLKIT_CATALOG);
      await bot.answerPreCheckoutQuery(route.queryId, review.ok, review.errorMessage);
      return new Response("ok");
    }
    if (route.kind !== "command") return new Response("ok");

    const { command, args, chatId, user }: CommandContext = route.ctx;
    const locale = parseLocale(user.language_code) as "en" | "pt-BR";
    const bot = new BotApi(env.TELEGRAM_BOT_TOKEN);

    const limiter = new RateLimiter(env.KV, { freeLimit: FREE_DAILY });
    const gate = await limiter.consume("instatoolkit", `user:${user.id}`, false);

    if (!gate.allowed && !["/start", "/help", "/buy"].includes(command)) {
      await bot.sendMessage(chatId, t(MESSAGES, locale, "quota_exceeded", { limit: gate.limit }));
      return new Response("ok");
    }

    if (command === "/start" || command === "/help") {
      await bot.sendMessage(chatId, t(MESSAGES, locale, "start"));
      return new Response("ok");
    }

    if (command === "/profile" || command === "/perfil") {
      if (!args.trim()) {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "usage_profile"));
        return new Response("ok");
      }
      const result = await fetchProfile(args.trim());
      if (result === "private" || result === "not_found") {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "profile_private"));
      } else if (result === "failed") {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "profile_failed"));
      } else {
        await bot.sendMessage(chatId, renderReport(result));
      }
      return new Response("ok");
    }

    if (command === "/tags") {
      const seeds = args.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      if (seeds.length === 0) {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "usage_tags"));
        return new Response("ok");
      }
      const set = generateHashtags(seeds, 18);
      await bot.sendMessage(chatId, renderTagList(set));
      return new Response("ok");
    }

    if (command === "/buy") {
      await bot.sendMessage(chatId, "InstaToolkit Pro: 200 Stars / 30 days.");
      return new Response("ok");
    }

    return new Response("ok");
  },
};

// keep i18n keys referenced so linters don't prune them from the dict type
void MESSAGES;
