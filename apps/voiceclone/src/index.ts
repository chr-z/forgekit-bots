/**
 * VoiceClone Alerts — keyword alerts for channels where the bot is admin.
 *
 * Conservative scope (owner decision in BOTS_ROADMAP.md): NO MTProto user
 * API (Telegram ToS risk). The bot only sees posts of channels where it
 * was added as ADMIN — those arrive as `channel_post` updates on the
 * webhook. A cron trigger exists solely to retry alert sends that failed
 * at post time; it never polls Telegram (getUpdates would 409 against the
 * registered webhook).
 *
 * Free: 1 channel + 1 term | Pro R$9/mo: 5 channels + 20 terms. Credit
 * packs buy extra TERM slots (see limitsFor). Stars catalog mirrors
 * sibling bots (subscription + credit pack).
 */

import { verifyUpdateSignature } from "@forgekit/auth";
import { parseLocale, t } from "@forgekit/i18n";
import { reviewPreCheckout, fulfillSuccessfulPayment, type StarProduct } from "@forgekit/stars";
import { BotApi, type TgUpdate } from "@forgekit/app-shared/botapi";
import { parseUpdate } from "@forgekit/app-shared/updates";

import { matchTerms, parseChannelArg, normalizeText } from "./matcher";
import { enqueueAlert, makeAlert, renderAlert, takeAlerts, type PendingAlert } from "./alerts";
import { exportCaption, exportFileName, renderHistoryPdf } from "./exportpdf";
import {
  addTerm,
  clearAlertHistory,
  countTerms,
  deleteChannel,
  getChannelByChat,
  listChannelsByOwner,
  listTerms,
  listAlertHistory,
  loadWatchlist,
  pruneAlertHistory,
  recordAlert,
  removeTerm,
  upsertChannel,
  type ChannelRow,
} from "./store";

/** Alert-history retention: rows kept per user (Pro), pruned after each insert. */
export const HISTORY_MAX_ROWS = 200;
/** Free users keep a tiny tail so an upgrade instantly surfaces recent alerts. */
export const HISTORY_FREE_KEEP = 5;

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  KV: KVNamespace;
  /** D1 shared database. */
  DB: D1Database;
}

export const VOICECLONE_CATALOG: StarProduct[] = [
  {
    productId: "sub:voiceclone-pro",
    title: "VoiceClone Alerts Pro — 30 days",
    description: "5 channels, 20 terms, alert retry queue.",
    priceInStars: 200,
    kind: "subscription",
    proDays: 30,
  },
  {
    productId: "pack:v50",
    title: "50 extra term slots",
    description: "Credit pack: 50 extra keyword slots, never expires.",
    priceInStars: 150,
    kind: "credits",
    creditsAmount: 50,
  },
];

export const FREE_CHANNELS = 1;
export const FREE_TERMS = 1;
export const PRO_CHANNELS = 5;
export const PRO_TERMS = 20;
/** Hard ceiling so a credit pack can never blow past predictable scale. */
export const TERMS_HARD_CAP = 70;

export const MESSAGES = {
  en: {
    start:
      "I watch channels (where you add me as ADMIN) and ping you when new posts mention your keywords.\n\n" +
      "Setup:\n" +
      "1. Add me as admin to your channel\n" +
      "2. /addchannel <link-or-@handle> here\n" +
      "3. /addterm <word>\n\n" +
      "Free: 1 channel, 1 term. /buy for Pro (5 channels, 20 terms).",
    not_admin:
      "I couldn't confirm admin access over that channel. Add me as administrator first (with posts permission), then try /addchannel again.",
    not_a_channel: "That target exists but is not a channel/supergroup I can watch.",
    channel_added: "✅ Watching {title}. Now add keywords with /addterm <word>.",
    channel_removed: "Channel removed (its terms went with it).",
    no_channels: "You haven't registered any channel yet. Start with /addchannel <link-or-@handle>.",
    pick_channel:
      "You watch more than one channel — tell me which one:\n{list}\nUse /addterm <channel> <word>.",
    term_limit: "Term limit reached ({limit} on your plan). Remove one with /removeterm or upgrade with /buy.",
    channel_limit: "Channel limit reached ({limit} on your plan). Remove one with /removechannel or upgrade with /buy.",
    term_added: '👀 "{term}" is being watched.',
    term_dup: '"{term}" was already being watched.',
    term_removed: '"{term}" removed.',
    no_such_term: "No such term on that channel. Check /terms.",
    terms_list: "Watching on {title}:\n{terms}",
    quota: "Free plan: 1 channel + 1 term. Pro ({stars} Stars/30d): 5 channels + 20 terms.",
    payment_ok: "Payment confirmed — {amount} Stars received. Thanks!",
    buy_intro:
      "VoiceClone Alerts Pro: 5 channels + 20 terms — {stars} Stars / 30 days.\nPack: {pack_stars} Stars for 50 extra term slots (never expires).",
    bad_channel: "That doesn't look like a channel link or @handle. Try https://t.me/durov or @durov.",
    bad_term: "Send the keyword as text, e.g. /addterm pagamento.",
    usage_addchannel: "Usage: /addchannel <https://t.me/link | @handle | -100id>",
    history_empty:
      "No alerts recorded yet. I save every alert here once your channels fire — Pro keeps the last 200.",
    history_page:
      "📜 Alert history ({page}/{pages}) — {total} total:\n{items}",
    history_pro_only:
      "Alert history is a Pro feature — you have {n} recent alert(s) saved, upgrade with /buy to browse them all.",
    history_cleared: "History cleared ({n} rows removed).",
    history_export_empty:
      "Nothing to export yet — no alerts recorded. I save every alert here once your channels fire.",
    history_export_failed:
      "Couldn't generate the PDF right now. Try again in a minute.",
  },
  "pt-BR": {
    start:
      "Eu observo canais (onde você me adicionar como ADMIN) e te aviso quando um post novo citar suas palavras-chave.\n\n" +
      "Como usar:\n" +
      "1. Me adiciona como admin no seu canal\n" +
      "2. /addchannel <link-ou-@handle> aqui no privado\n" +
      "3. /addterm <palavra>\n\n" +
      "Grátis: 1 canal, 1 palavra. /buy para Pro (5 canais, 20 palavras).",
    not_admin:
      "Não consegui confirmar acesso de admin nesse canal. Me adiciona como administrador primeiro (com permissão de publicar), depois tenta /addchannel de novo.",
    not_a_channel: "O destino existe mas não é um canal/supergrupo que eu consiga observar.",
    channel_added: "✅ Observando {title}. Agora adiciona palavras com /addterm <palavra>.",
    channel_removed: "Canal removido (as palavras dele foram junto).",
    no_channels: "Você ainda não registrou nenhum canal. Começa com /addchannel <link-ou-@handle>.",
    pick_channel:
      "Você observa mais de um canal — me diz qual:\n{list}\nUse /addterm <canal> <palavra>.",
    term_limit: "Limite de termos atingido ({limit} no seu plano). Remove uma com /removeterm ou faz upgrade com /buy.",
    channel_limit: "Limite de canais atingido ({limit} no seu plano). Remove um com /removechannel ou faz upgrade com /buy.",
    term_added: '👀 "{term}" está sendo observada.',
    term_dup: '"{term}" já estava sendo observada.',
    term_removed: '"{term}" removida.',
    no_such_term: "Nenhuma palavra com esse nome nesse canal. Confere /terms.",
    terms_list: "Observando em {title}:\n{terms}",
    quota: "Plano grátis: 1 canal + 1 palavra. Pro ({stars} Stars/30d): 5 canais + 20 palavras.",
    payment_ok: "Pagamento confirmado — {amount} Stars recebidos. Valeu!",
    buy_intro:
      "VoiceClone Alerts Pro: 5 canais + 20 palavras — {stars} Stars / 30 dias.\nPacote: {pack_stars} Stars por 50 vagas extras de termos (não expira).",
    bad_channel: "Isso não parece um link de canal ou @handle. Tenta https://t.me/durov ou @durov.",
    bad_term: "Manda a palavra-chave como texto, ex.: /addterm pagamento.",
    usage_addchannel: "Uso: /addchannel <link t.me | @handle | -100id>",
    history_empty:
      "Nenhum alerta registrado ainda. Salvo cada alerta aqui quando seus canais dispararem — o Pro guarda os últimos 200.",
    history_page:
      "📜 Histórico de alertas ({page}/{pages}) — {total} no total:\n{items}",
    history_pro_only:
      "Histórico é recurso Pro — você tem {n} alerta(s) recente(s) salvos, faz upgrade com /buy para ver todos.",
    history_cleared: "Histórico limpo ({n} registros removidos).",
    history_export_empty:
      "Nada pra exportar ainda — nenhum alerta registrado. Salvo cada alerta aqui quando seus canais dispararem.",
    history_export_failed:
      "Não consegui gerar o PDF agora. Tenta de novo em um minuto.",
  },
};

async function isPro(db: D1Database, userId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT pro_until FROM subscriptions WHERE tg_user_id = ?")
    .bind(userId)
    .first<{ pro_until: string }>();
  return !!row?.pro_until && new Date(row.pro_until).getTime() > Date.now();
}

async function creditBalance(db: D1Database, userId: number): Promise<number> {
  const row = await db
    .prepare("SELECT balance FROM users WHERE tg_user_id = ?")
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

/**
 * Term slots = plan allowance + unused credit-pack slots (capped).
 * Channels are plan-only: packs deliberately don't multiply sources.
 */
export function limitsFor(pro: boolean, balance: number): { maxChannels: number; maxTerms: number } {
  const base = pro ? PRO_TERMS : FREE_TERMS;
  return {
    maxChannels: pro ? PRO_CHANNELS : FREE_CHANNELS,
    maxTerms: Math.min(TERMS_HARD_CAP, base + Math.max(0, Math.floor(balance))),
  };
}

interface ResolvedChannel {
  ok: true;
  channel: ChannelRow;
}
type ResolveFail = { ok: false; reason: "none" } | { ok: false; reason: "pick"; list: ChannelRow[] };

/** Resolve the target channel of /addterm-style commands. */
async function resolveChannel(
  db: D1Database,
  ownerId: number,
  arg: string | null,
): Promise<ResolvedChannel | ResolveFail> {
  const channels = await listChannelsByOwner(db, ownerId);
  if (channels.length === 0) return { ok: false, reason: "none" };
  if (!arg) {
    return channels.length === 1
      ? { ok: true, channel: channels[0]! }
      : { ok: false, reason: "pick", list: channels };
  }
  const wanted = arg.trim().toLowerCase();
  // Match by stored chat title (handles would require a live getChat round-trip).
  const byTitle = channels.find((c) => c.title.toLowerCase() === wanted);
  if (byTitle) return { ok: true, channel: byTitle };
  return { ok: false, reason: "pick", list: channels };
}

export interface ScanOutcome {
  matched: boolean;
  /** Owner chat ids an alert was sent (or queued) for. */
  notified: number[];
}

/** Telegram message hard cap; keep rendered history lines well inside it. */
const TG_MESSAGE_CAP = 4096;

/**
 * Render one page of the alert history (newest first).
 * Pure so the pagination math stays unit-testable without D1.
 */
export function renderHistoryPage(
  rows: {
    terms: string;
    title: string;
    excerpt: string;
    created_at: string;
    delivered: number;
  }[],
  page: number,
  pages: number,
  total: number,
  locale: string,
): string {
  const items = rows
    .map((r) => {
      const ex = r.excerpt.length > 48 ? `${r.excerpt.slice(0, 45)}…` : r.excerpt;
      return (
        `• ${r.terms} — ${r.title} · ${r.created_at}${r.delivered ? "" : " · retry"}\n` +
        `  ${ex}`
      );
    })
    .join("\n");
  const body = t(MESSAGES, parseLocale(locale), "history_page", {
    page,
    pages,
    total,
    items: items || "—",
  });
  return body.length > TG_MESSAGE_CAP ? `${body.slice(0, TG_MESSAGE_CAP - 1)}…` : body;
}

/** KV marker so Telegram webhook redeliveries never double-alert. */
async function alreadySeen(kv: KVNamespace, chatId: number, messageId: number): Promise<boolean> {
  const key = `vc:seen:${chatId}:${messageId}`;
  if (await kv.get(key)) return true;
  await kv.put(key, "1", { expirationTtl: 48 * 3600 });
  return false;
}

/**
 * Core scan for one incoming channel post. Registered channel + watchlist
 * terms -> matcher -> DM the owner (queue for retry when sending fails).
 */
export async function handleChannelPost(
  deps: {
    db: D1Database;
    kv: KVNamespace;
    bot: Pick<BotApi, "sendMessage">;
    /** Pro check for the alert owner (drives the history retention cap). */
    getPro: (ownerId: number) => Promise<boolean>;
  },
  chatId: number,
  messageId: number,
  text: string,
): Promise<ScanOutcome> {
  const registered = await getChannelByChat(deps.db, chatId);
  if (!registered) return { matched: false, notified: [] };

  const watch = await loadWatchlist(deps.db);
  const terms = watch.get(chatId) ?? [];
  if (terms.length === 0) return { matched: false, notified: [] };

  const hits = matchTerms(text, terms);
  if (hits.length === 0) return { matched: false, notified: [] };
  if (await alreadySeen(deps.kv, chatId, messageId)) {
    return { matched: true, notified: [] };
  }

  const message = renderAlert(registered.title, hits, text);
  let delivered = true;
  try {
    await deps.bot.sendMessage(registered.owner_id, message);
  } catch {
    delivered = false;
  }
  if (!delivered) {
    await enqueueAlert(deps.kv, makeAlert(registered.owner_id, message));
  }
  // History snapshot — best-effort: never blocks delivery or the ack.
  try {
    await recordAlert(
      deps.db,
      registered.owner_id,
      chatId,
      registered.title,
      hits,
      text.length > 200 ? `${text.slice(0, 197)}…` : text,
      delivered,
    );
    const keep = (await deps.getPro(registered.owner_id))
      ? HISTORY_MAX_ROWS
      : HISTORY_FREE_KEEP;
    await pruneAlertHistory(deps.db, registered.owner_id, keep);
  } catch {
    /* history is a convenience; the alert already went out */
  }
  await deps.db
    .prepare("INSERT INTO usage_log (bot, tg_user_id, action, detail) VALUES ('voiceclone', ?, 'alert', ?)")
    .bind(registered.owner_id, hits.join(","))
    .run();
  return { matched: true, notified: [registered.owner_id] };
}

/**
 * Cron entry: drain the retry queue. Never polls Telegram — the queue only
 * holds alerts whose first send failed. Per-alert try: one broken chat
 * must not eat the batch (each failure is re-enqueued individually).
 */
export async function drainRetryQueue(env: Env): Promise<number> {
  const bot = new BotApi(env.TELEGRAM_BOT_TOKEN);
  const batch = await takeAlerts(env.KV);
  let sent = 0;
  for (const alert of batch) {
    try {
      await bot.sendMessage(alert.toChatId, alert.text);
      sent += 1;
    } catch {
      await enqueueAlert(env.KV, alert);
    }
  }
  return sent;
}

function fmtList(channels: ChannelRow[]): string {
  return channels.map((c) => `• ${c.title}`).join("\n");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("voiceclone worker up", { status: 200 });
    }
    if (
      !verifyUpdateSignature(
        request.headers.get("X-Telegram-Bot-Api-Secret-Token"),
        env.WEBHOOK_SECRET,
      )
    ) {
      return new Response("bad secret", { status: 401 });
    }

    let update: TgUpdate;
    try {
      update = (await request.json()) as TgUpdate;
    } catch {
      return new Response("ok");
    }
    const route = parseUpdate(update);
    const bot = new BotApi(env.TELEGRAM_BOT_TOKEN);

    try {
      if (route.kind === "pre_checkout") {
        const review = reviewPreCheckout({ invoice_payload: route.payload }, VOICECLONE_CATALOG);
        await bot.answerPreCheckoutQuery(route.queryId, review.ok, review.errorMessage);
        return new Response("ok");
      }

      if (route.kind === "successful_payment") {
        if (route.ctx.user) {
          // Idempotent by telegram_payment_charge_id (star_payments PK).
          await fulfillSuccessfulPayment(
            env.DB,
            { ...route.payment, from: { id: route.ctx.user.id } },
            VOICECLONE_CATALOG,
          );
          const locale = parseLocale(route.ctx.user.language_code);
          await bot.sendMessage(
            route.ctx.chatId,
            t(MESSAGES, locale, "payment_ok", { amount: route.payment.total_amount }),
          );
        }
        return new Response("ok");
      }

      if (route.kind === "channel_post") {
        await handleChannelPost(
          {
            db: env.DB,
            kv: env.KV,
            bot,
            // Pro tier picks the history retention cap; resolved lazily
            // because the owner id is only known after the channel lookup.
            getPro: (ownerId) => isPro(env.DB, ownerId),
          },
          route.ctx.chatId,
          route.ctx.messageId,
          route.ctx.text,
        );
        return new Response("ok");
      }

      if (route.kind !== "command") return new Response("ok");
      const { command, args, chatId, user } = route.ctx;
      const locale = parseLocale(user.language_code);
      const send = (key: string, params?: Record<string, string | number>) =>
        bot.sendMessage(chatId, t(MESSAGES, locale, key, params));

      if (command === "/start" || command === "/help") {
        await send("start");
        return new Response("ok");
      }

      if (command === "/quota" || command === "/plans") {
        await send("quota", { stars: 200 });
        return new Response("ok");
      }

      if (command === "/buy") {
        await send("buy_intro", { stars: 200, pack_stars: 150 });
        return new Response("ok");
      }

      const pro = await isPro(env.DB, user.id);
      const limits = limitsFor(pro, await creditBalance(env.DB, user.id));

      if (command === "/addchannel") {
        const target = parseChannelArg(args);
        if (!target) {
          await send("usage_addchannel");
          return new Response("ok");
        }
        // Ownership proof = the BOT's admin status over the target chat
        // (the conservative scope requires bot-admin anyway).
        try {
          const chat = await bot.getChat(target);
          if (chat.type !== "channel" && chat.type !== "supergroup") {
            await send("not_a_channel");
            return new Response("ok");
          }
          const me = await bot.getMe();
          const membership = await bot.getChatMember(chat.id, me.id);
          if (!["administrator", "creator"].includes(membership.status)) {
            await send("not_admin");
            return new Response("ok");
          }
          const title = chat.title ?? target;
          const current = await listChannelsByOwner(env.DB, user.id);
          const alreadyOwned = current.some((c) => c.chat_id === chat.id);
          if (!alreadyOwned && current.length >= limits.maxChannels) {
            await send("channel_limit", { limit: limits.maxChannels });
            return new Response("ok");
          }
          await upsertChannel(env.DB, chat.id, user.id, title);
          await send("channel_added", { title });
        } catch {
          await send("not_admin");
        }
        return new Response("ok");
      }

      if (command === "/removechannel") {
        const channels = await listChannelsByOwner(env.DB, user.id);
        if (channels.length === 0) {
          await send("no_channels");
          return new Response("ok");
        }
        let chosen: ChannelRow | undefined;
        const target = args ? parseChannelArg(args) : null;
        if (target) {
          try {
            const chat = await bot.getChat(target);
            chosen = channels.find((c) => c.chat_id === chat.id);
          } catch {
            chosen = undefined;
          }
          chosen ??= channels.find((c) => c.title.toLowerCase() === args!.trim().toLowerCase());
        } else if (channels.length === 1) {
          chosen = channels[0];
        }
        if (!chosen) {
          await send("pick_channel", { list: fmtList(channels) });
          return new Response("ok");
        }
        await deleteChannel(env.DB, user.id, chosen.chat_id);
        await send("channel_removed");
        return new Response("ok");
      }

      if (command === "/addterm") {
        const parts = args.split(/\s+/).filter(Boolean);
        const hasExplicit = parts.length >= 2 && parseChannelArg(parts[0]!) !== null;
        const termText = (hasExplicit ? parts.slice(1) : parts).join(" ").trim();
        if (!termText) {
          await send("bad_term");
          return new Response("ok");
        }
        const resolved = await resolveChannel(env.DB, user.id, hasExplicit ? parts[0]! : null);
        if (!resolved.ok) {
          await send(resolved.reason === "pick" ? "pick_channel" : "no_channels", {
            list: resolved.reason === "pick" ? fmtList(resolved.list) : "",
          });
          return new Response("ok");
        }
        const existing = await listTerms(env.DB, resolved.channel.chat_id);
        if (existing.some((e) => normalizeText(e) === normalizeText(termText))) {
          await send("term_dup", { term: termText });
          return new Response("ok");
        }
        const total = await countTerms(
          env.DB,
          (await listChannelsByOwner(env.DB, user.id)).map((c) => c.chat_id),
        );
        if (total >= limits.maxTerms) {
          await send("term_limit", { limit: limits.maxTerms });
          return new Response("ok");
        }
        await addTerm(env.DB, resolved.channel.chat_id, termText);
        await send("term_added", { term: termText });
        return new Response("ok");
      }

      if (command === "/removeterm") {
        const parts = args.split(/\s+/).filter(Boolean);
        const hasExplicit = parts.length >= 2 && parseChannelArg(parts[0]!) !== null;
        const termText = (hasExplicit ? parts.slice(1) : parts).join(" ").trim();
        const resolved = await resolveChannel(env.DB, user.id, hasExplicit ? parts[0]! : null);
        if (!resolved.ok) {
          await send(resolved.reason === "pick" ? "pick_channel" : "no_channels", {
            list: resolved.reason === "pick" ? fmtList(resolved.list) : "",
          });
          return new Response("ok");
        }
        const ok = await removeTerm(env.DB, resolved.channel.chat_id, termText);
        await send(ok ? "term_removed" : "no_such_term", { term: termText });
        return new Response("ok");
      }

      if (command === "/terms") {
        const resolved = await resolveChannel(env.DB, user.id, null);
        if (!resolved.ok) {
          await send("no_channels");
          return new Response("ok");
        }
        const terms = await listTerms(env.DB, resolved.channel.chat_id);
        await send("terms_list", {
          title: resolved.channel.title,
          terms: terms.length ? terms.join(", ") : "—",
        });
        return new Response("ok");
      }

      if (command === "/history") {
        // `/history [page] pdf` exports the requested page as a PDF document
        // behind the SAME Pro gate as the text history (free never reaches it).
        const wantsPdf = /\bpdf\b/i.test(args);
        const pageArg = wantsPdf ? args.replace(/\bpdf\b/i, "").trim() : args;
        const page = Math.max(1, parseInt(pageArg, 10) || 1);
        if (!pro) {
          const { total } = await listAlertHistory(env.DB, user.id, 0, 0);
          await send("history_pro_only", { n: total });
          return new Response("ok");
        }
        const pageSize = wantsPdf ? 20 : 10;
        const { rows, total } = await listAlertHistory(
          env.DB,
          user.id,
          pageSize,
          (page - 1) * pageSize,
        );
        if (total === 0) {
          await send(wantsPdf ? "history_export_empty" : "history_empty");
          return new Response("ok");
        }
        if (wantsPdf) {
          try {
            const bytes = await renderHistoryPdf(rows, page, total, user.language_code ?? "en");
            await bot.sendDocument(
              chatId,
              exportFileName(page),
              bytes,
              exportCaption(total, user.language_code ?? "en"),
            );
          } catch {
            await send("history_export_failed");
          }
          return new Response("ok");
        }
        const pages = Math.max(1, Math.ceil(total / pageSize));
        await bot.sendMessage(
          chatId,
          renderHistoryPage(rows, page, pages, total, user.language_code ?? "en"),
        );
        return new Response("ok");
      }

      if (command === "/clearhistory") {
        const n = await clearAlertHistory(env.DB, user.id);
        await send("history_cleared", { n });
        return new Response("ok");
      }

      return new Response("ok");
    } catch (err) {
      console.error("voiceclone handler error", err);
      return new Response("ok");
    }
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    await drainRetryQueue(env);
  },
} as ExportedHandler<Env>;
