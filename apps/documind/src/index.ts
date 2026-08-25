/**
 * DocuMind — "ChatGPT dos seus documentos" on Telegram.
 *
 * Send a PDF/txt -> text is extracted serverlessly (pure TS, native
 * DecompressionStream — no binaries, no Vectorize paid plan) -> chunked into
 * a numbered passage index in D1 -> /ask questions are answered by Workers
 * AI strictly from retrieved passages with [n] citations.
 *
 * Free tier (fits Cloudflare free allowances by construction): 2 documents
 * and 10 questions per 30 days. Pro (Stars-only): unlimited docs, 500
 * questions, bigger retrieval. Credit packs extend questions (1 credit =
 * 1 question). Failures never charge anything.
 */

import { verifyUpdateSignature } from "@forgekit/auth";
import { grantCredits, spendCredits } from "@forgekit/credits";
import { parseLocale, t } from "@forgekit/i18n";
import { RateLimiter } from "@forgekit/ratelimit";
import { reviewPreCheckout, fulfillSuccessfulPayment, type StarProduct } from "@forgekit/stars";
import { BotApi, type TgUpdate } from "@forgekit/app-shared/botapi";
import { renderPdf, type PdfDoc } from "@forgekit/app-shared/pdf";
import { parseUpdate } from "@forgekit/app-shared/updates";

import { classifyAttachment, ingestDocument } from "./ingest";
import { DOCUMIND_MODEL, answerQuestion, retrieve } from "./rag";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  KV: KVNamespace;
  /** D1 shared database (credits ledger + doc index). */
  DB: D1Database;
  /** Workers AI binding. */
  AI: Ai;
}

export const DOCUMIND_CATALOG: StarProduct[] = [
  {
    productId: "sub:documind-pro",
    title: "DocuMind Pro — 30 days",
    description: "Unlimited documents, 500 questions, larger retrieval.",
    priceInStars: 300,
    kind: "subscription",
    proDays: 30,
  },
  {
    productId: "pack:q150",
    title: "150 extra questions",
    description: "Credit pack, never expires. 1 credit = 1 question.",
    priceInStars: 150,
    kind: "credits",
    creditsAmount: 150,
  },
];

/** Owner roadmap anchor: Free 2 docs + 10 questions / month. */
export const FREE_DOC_LIMIT = 2;
export const FREE_QUESTION_LIMIT = 10;
export const QUOTA_WINDOW_DAYS = 30;

/** KV key holding the last answered Q&A of a user (source for /export pdf). */
export function lastAnswerKey(userId: number): string {
  return `documind:lastqa:${userId}`;
}

/** Structured payload cached for the Pro PDF export. */
export interface QaDoc {
  docTitle: string;
  question: string;
  answer: string;
}

const MESSAGES = {
  en: {
    start:
      "Send me a PDF or text file and ask anything about it — answers cite the exact passages ([1], [2]).\n\nFree: 2 documents + 10 questions every 30 days. /buy for unlimited.",
    not_a_document: "Attach a PDF or text file (as a file, not a photo) and I'll index it.",
    too_large: "File too large — the Telegram cap for bots is 20MB.",
    unsupported_format: "I only read PDF and plain-text files for now (.pdf, .txt, .md, .csv).",
    no_text: "This file has no readable text (scanned image?). I won't invent content — try a text-based PDF.",
    failed: "Something broke while reading the file.\nIt's logged and will be fixed. Nothing was charged.",
    doc_ready:
      "✅ Indexed: {title}\n{pages} sections · {chunks} passages{trunc}\n\nNow just ask: /ask your question",
    trunc: "\n(very large document — indexed the first ~60k characters)",
    docs_empty: "No documents yet. Attach a PDF or .txt to get started.",
    docs_list: "📚 Your documents (send /use <id> to switch):\n\n{list}",
    doc_row: "[{id}] {title} — {pages}p/{chunks}q",
    active_set: "Active document: [{id}] {title}",
    not_found: "Document #{id} not found in your library.",
    removed: "Deleted [{id}] {title}.",
    ask_usage: "Usage: /ask <your question about the document>",
    no_docs_yet: "Send me a document first — then /ask away.",
    no_match: "I couldn't find anything about that in this document. Try other words — nothing was charged.",
    quota_docs:
      "Free limit reached ({limit} documents / {days} days). Unlimited with Pro: /buy",
    quota_questions:
      "Free limit reached ({limit} questions / {days} days).\nResets soon — or add 150 questions with /buy (1 credit each).",
    buy_intro:
      "DocuMind Pro: unlimited documents + 500 questions — {stars} Stars / 30 days.\nCredit pack: {pack_stars} Stars = 150 extra questions (never expires).",
    export_pro_only:
      "PDF export is a Pro feature. /buy to unlock unlimited documents, questions and PDF export.",
    export_nothing: "No answered question yet — /ask something first, then /export pdf.",
    export_failed: "Something broke while rendering the PDF. Nothing was charged.",
    pro_active: "DocuMind Pro active — unlimited documents and questions for 30 days. Thanks!",
    pack_active: "Payment confirmed — 150 extra questions added. Thanks!",
    balance: "\n\nCredit used — balance left: {balance}.",
  },
  "pt-BR": {
    start:
      "Me manda um PDF ou arquivo de texto e pergunta qualquer coisa sobre ele — as respostas citam os trechos exatos ([1], [2]).\n\nGrátis: 2 documentos + 10 perguntas a cada 30 dias. /buy para ilimitado.",
    not_a_document: "Anexa um PDF ou arquivo de texto (como arquivo, não como foto) que eu indexo.",
    too_large: "Arquivo grande demais — o limite do Telegram para bots é 20MB.",
    unsupported_format: "Por enquanto eu leio só PDF e texto puro (.pdf, .txt, .md, .csv).",
    no_text: "Esse arquivo não tem texto legível (imagem escaneada?). Não vou inventar conteúdo — tenta um PDF com texto.",
    failed: "Algo quebrou lendo o arquivo.\nEstá logado e será corrigido. Nada foi cobrado.",
    doc_ready:
      "✅ Indexado: {title}\n{pages} seções · {chunks} trechos{trunc}\n\nAgora é só perguntar: /ask sua pergunta",
    trunc: "\n(documento bem grande — indexei os primeiros ~60 mil caracteres)",
    docs_empty: "Nenhum documento ainda. Anexa um PDF ou .txt pra começar.",
    docs_list: "📚 Seus documentos (manda /use <id> pra trocar):\n\n{list}",
    doc_row: "[{id}] {title} — {pages}p/{chunks}t",
    active_set: "Documento ativo: [{id}] {title}",
    not_found: "Documento #{id} não encontrado na sua biblioteca.",
    removed: "Apaguei [{id}] {title}.",
    ask_usage: "Uso: /ask <sua pergunta sobre o documento>",
    no_docs_yet: "Me manda um documento primeiro — depois é só /ask.",
    no_match: "Não achei nada sobre isso nesse documento. Tenta outras palavras — nada foi cobrado.",
    quota_docs:
      "Limite grátis atingido ({limit} documentos / {days} dias). Ilimitado com Pro: /buy",
    quota_questions:
      "Limite grátis atingido ({limit} perguntas / {days} dias).\nRenova em breve — ou adicione 150 perguntas com /buy (1 crédito cada).",
    buy_intro:
      "DocuMind Pro: documentos ilimitados + 500 perguntas — {stars} Stars / 30 dias.\nPacote: {pack_stars} Stars = 150 perguntas extras (não expira).",
    export_pro_only:
      "Exportar em PDF é recurso Pro. /buy libera documentos, perguntas e exportação ilimitados.",
    export_nothing: "Nenhuma pergunta respondida ainda — manda um /ask antes, depois /export pdf.",
    export_failed: "Algo quebrou ao gerar o PDF. Nada foi cobrado.",
    pro_active: "DocuMind Pro ativo — documentos e perguntas ilimitados por 30 dias. Valeu!",
    pack_active: "Pagamento confirmado — 150 perguntas extras adicionadas. Valeu!",
    balance: "\n\nCrédito usado — saldo restante: {balance}.",
  },
};

async function isPro(db: D1Database, userId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT pro_until FROM subscriptions WHERE tg_user_id = ?")
    .bind(userId)
    .first<{ pro_until: string }>();
  return !!row?.pro_until && new Date(row.pro_until).getTime() > Date.now();
}

interface DocRow {
  id: number;
  title: string;
  n_pages: number;
  n_chunks: number;
}

async function latestDoc(db: D1Database, userId: number): Promise<DocRow | null> {
  const row = await db
    .prepare("SELECT id, title, n_pages, n_chunks FROM dm_docs WHERE tg_user_id = ? ORDER BY id DESC LIMIT 1")
    .bind(userId)
    .first<DocRow>();
  return row ?? null;
}

async function findDoc(db: D1Database, userId: number, id: number): Promise<DocRow | null> {
  const row = await db
    .prepare("SELECT id, title, n_pages, n_chunks FROM dm_docs WHERE tg_user_id = ? AND id = ?")
    .bind(userId, id)
    .first<DocRow>();
  return row ?? null;
}

async function docsInWindow(db: D1Database, userId: number, days: number): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM dm_docs WHERE tg_user_id = ? AND created_at >= datetime('now', ?)",
    )
    .bind(userId, `-${days} days`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("documind worker up", { status: 200 });
    }
    if (!verifyUpdateSignature(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.WEBHOOK_SECRET)) {
      return new Response("bad secret", { status: 401 });
    }

    const update = (await request.json()) as TgUpdate;
    const route = parseUpdate(update);
    const bot = new BotApi(env.TELEGRAM_BOT_TOKEN);
    const locale = parseLocale(update.message?.from?.language_code);
    const M = (key: string, params?: Record<string, string | number>) =>
      t(MESSAGES, locale, key, params);

    if (route.kind === "pre_checkout") {
      const review = reviewPreCheckout({ invoice_payload: route.payload }, DOCUMIND_CATALOG);
      await bot.answerPreCheckoutQuery(route.queryId, review.ok, review.errorMessage);
      return new Response("ok");
    }

    if (route.kind === "successful_payment") {
      // Idempotent by telegram_payment_charge_id (star_payments PK).
      if (route.ctx.user) {
        await fulfillSuccessfulPayment(
          env.DB,
          { ...route.payment, from: { id: route.ctx.user.id } },
          DOCUMIND_CATALOG,
        );
        const isSub = route.payment.invoice_payload.startsWith("sub:");
        await bot.sendMessage(
          route.ctx.chatId,
          isSub ? M("pro_active") : t(MESSAGES, parseLocale(route.ctx.user.language_code), "pack_active"),
        );
      }
      return new Response("ok");
    }

    const msg = update.message;

    // --- Document intake (attachment messages are not "/" commands) ---
    if (msg?.from && !msg.from.is_bot && (msg as unknown as Record<string, unknown>).document) {
      const doc = (msg as unknown as Record<string, unknown>).document as {
        file_id?: string;
        file_name?: string;
        mime_type?: string;
      };
      const userId = msg.from.id;
      const chatId = msg.chat.id;
      const { kind, title } = classifyAttachment(doc);
      if (!kind) {
        await bot.sendMessage(chatId, M("unsupported_format"));
        return new Response("ok");
      }
      const pro = await isPro(env.DB, userId).catch(() => false);
      if (!pro && (await docsInWindow(env.DB, userId, QUOTA_WINDOW_DAYS)) >= FREE_DOC_LIMIT) {
        await bot.sendMessage(chatId, M("quota_docs", { limit: FREE_DOC_LIMIT, days: QUOTA_WINDOW_DAYS }));
        return new Response("ok");
      }

      const result = await ingestDocument(
        { fileId: doc.file_id ?? "", title, kind, userId, botToken: env.TELEGRAM_BOT_TOKEN },
        { fetchImpl: fetch, db: env.DB },
      );
      if (!result.ok || !result.doc) {
        const map: Record<string, string> = {
          too_large: "too_large",
          unsupported_format: "unsupported_format",
          no_text: "no_text",
          failed: "failed",
        };
        const key = map[result.reason ?? "failed"] ?? "failed";
        await bot.sendMessage(chatId, M(key));
        return new Response("ok");
      }
      await env.DB.prepare("INSERT INTO usage_log (bot, tg_user_id, action, detail) VALUES ('documind', ?, 'ingest', ?)")
        .bind(userId, `${title}:${result.doc.nChunks}c`)
        .run()
        .catch(() => null);
      await bot.sendMessage(
        chatId,
        M("doc_ready", {
          title: result.doc.title,
          pages: result.doc.nPages,
          chunks: result.doc.nChunks,
          trunc: result.doc.truncated ? M("trunc") : "",
        }),
      );
      return new Response("ok");
    }

    if (route.kind !== "command") return new Response("ok");
    const { command, args, chatId, user } = route.ctx;

    if (command === "/start" || command === "/help") {
      await bot.sendMessage(chatId, M("start"));
      return new Response("ok");
    }

    if (command === "/buy") {
      await bot.sendMessage(chatId, M("buy_intro", { stars: 300, pack_stars: 150 }));
      return new Response("ok");
    }

    // /export pdf — Pro perk: re-render the last answered question as a PDF document.
    if (command === "/export") {
      const pro = await isPro(env.DB, user.id).catch(() => false);
      if (!pro) {
        await bot.sendMessage(chatId, M("export_pro_only"));
        return new Response("ok");
      }
      const raw = args.trim().toLowerCase();
      const kind = raw === "" ? "pdf" : raw.split(/\s+/)[0];
      // Production KV.get(_, "json") parses server-side (null when malformed);
      // mirrors how the RateLimiter reads its counters.
      const qa = kind === "pdf" ? await env.KV.get<QaDoc>(lastAnswerKey(user.id), "json") : null;
      if (!qa || typeof qa.question !== "string" || typeof qa.answer !== "string") {
        await bot.sendMessage(chatId, M("export_nothing"));
        return new Response("ok");
      }
      try {
        const pdf: PdfDoc = {
          title: qa.docTitle,
          author: "DocuMind",
          tldr: qa.question,
          tldrLabel: "Question",
          bullets: qa.answer.split("\n").map((l) => l.trim()).filter(Boolean),
        };
        const bytes = await renderPdf(pdf);
        const safeTitle =
          (qa.docTitle ?? "document").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) ||
          "document";
        await bot.sendDocument(chatId, `${safeTitle} - answers.pdf`, bytes);
      } catch {
        await bot.sendMessage(chatId, M("export_failed"));
        return new Response("ok");
      }
      return new Response("ok");
    }

    if (command === "/docs") {
      const rows = await env.DB.prepare(
        "SELECT id, title, n_pages, n_chunks FROM dm_docs WHERE tg_user_id = ? ORDER BY id DESC LIMIT 10",
      )
        .bind(user.id)
        .all<DocRow>()
        .catch(() => ({ results: [] as DocRow[] }));
      const docs = rows.results ?? [];
      if (!docs.length) {
        await bot.sendMessage(chatId, M("docs_empty"));
        return new Response("ok");
      }
      const list = docs.map((d) => M("doc_row", { id: d.id, title: d.title, pages: d.n_pages, chunks: d.n_chunks })).join("\n");
      await bot.sendMessage(chatId, M("docs_list", { list }));
      return new Response("ok");
    }

    if (command === "/use") {
      const id = parseInt(args.trim(), 10);
      const doc = Number.isInteger(id) ? await findDoc(env.DB, user.id, id) : null;
      if (!doc) {
        await bot.sendMessage(chatId, M("not_found", { id: args.trim() || "?" }));
        return new Response("ok");
      }
      // "Switching" = pinning: we re-ingest nothing, just remember preference
      // in KV so /ask targets it. Latest doc remains the default.
      await env.KV.put(`dm:active:${user.id}`, String(doc.id));
      await bot.sendMessage(chatId, M("active_set", { id: doc.id, title: doc.title }));
      return new Response("ok");
    }

    if (command === "/forget") {
      const raw = args.trim();
      const id = raw === "all" || raw === "" ? NaN : parseInt(raw, 10);
      if (raw === "all") {
        await env.DB.prepare("DELETE FROM dm_chunks WHERE doc_id IN (SELECT id FROM dm_docs WHERE tg_user_id = ?)")
          .bind(user.id)
          .run()
          .catch(() => null);
        await env.DB.prepare("DELETE FROM dm_docs WHERE tg_user_id = ?").bind(user.id).run().catch(() => null);
        await env.KV.delete(`dm:active:${user.id}`).catch(() => null);
        await bot.sendMessage(chatId, M("docs_empty"));
        return new Response("ok");
      }
      const doc = Number.isInteger(id) ? await findDoc(env.DB, user.id, id) : null;
      if (!doc) {
        await bot.sendMessage(chatId, M("not_found", { id: raw || "?" }));
        return new Response("ok");
      }
      await env.DB.prepare("DELETE FROM dm_chunks WHERE doc_id = ?").bind(doc.id).run().catch(() => null);
      await env.DB.prepare("DELETE FROM dm_docs WHERE id = ? AND tg_user_id = ?").bind(doc.id, user.id).run().catch(() => null);
      await bot.sendMessage(chatId, M("removed", { id: doc.id, title: doc.title }));
      return new Response("ok");
    }

    if (command === "/ask" || command === "/q") {
      const question = args.trim();
      if (!question) {
        await bot.sendMessage(chatId, M("ask_usage"));
        return new Response("ok");
      }
      const pro = await isPro(env.DB, user.id).catch(() => false);

      // Retrieve BEFORE any charging: zero-match questions cost nothing.
      const docIdStr = await env.KV.get(`dm:active:${user.id}`);
      const pinned = docIdStr ? await findDoc(env.DB, user.id, parseInt(docIdStr, 10)) : null;
      const doc = pinned ?? (await latestDoc(env.DB, user.id));
      if (!doc) {
        await bot.sendMessage(chatId, M("no_docs_yet"));
        return new Response("ok");
      }
      const rows = await env.DB.prepare("SELECT n, text FROM dm_chunks WHERE doc_id = ? ORDER BY n")
        .bind(doc.id)
        .all<{ n: number; text: string }>()
        .catch(() => ({ results: [] as { n: number; text: string }[] }));
      const chunks = (rows.results ?? []).map((r) => ({ n: r.n, text: r.text }));
      const scored = retrieve(chunks, question);
      if (!scored.length) {
        await bot.sendMessage(chatId, M("no_match"));
        return new Response("ok");
      }

      // Beyond the free window one credit covers one question.
      const limiter = new RateLimiter(env.KV, {
        freeLimit: FREE_QUESTION_LIMIT,
        windowSeconds: QUOTA_WINDOW_DAYS * 86400,
      });
      const gate = await limiter.consume("documind", `q:${user.id}`, pro);
      let creditBalance: number | null = null;
      if (!gate.allowed && !pro) {
        creditBalance = await spendCredits(env.DB, user.id, 1, `ask:${doc.id}`).catch(() => null);
        if (creditBalance === null) {
          await bot.sendMessage(chatId, M("quota_questions", { limit: FREE_QUESTION_LIMIT, days: QUOTA_WINDOW_DAYS }));
          return new Response("ok");
        }
      }

      const { answer } = await answerQuestion(env.AI, DOCUMIND_MODEL, question, scored);
      await env.DB.prepare("INSERT INTO usage_log (bot, tg_user_id, action, detail) VALUES ('documind', ?, 'ask', ?)")
        .bind(user.id, `doc:${doc.id}`)
        .run()
        .catch(() => null);
      // Remember the structured Q&A so /export pdf can re-render it (Pro perk).
      await env.KV.put(
        lastAnswerKey(user.id),
        JSON.stringify({ docTitle: doc.title, question, answer } satisfies QaDoc),
        { expirationTtl: 7 * 86400 },
      );
      const suffix = creditBalance !== null ? M("balance", { balance: creditBalance }) : "";
      await bot.sendMessage(chatId, `${answer}${suffix}`);
      return new Response("ok");
    }

    return new Response("ok");
  },
};
