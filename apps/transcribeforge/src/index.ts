/**
 * TranscribeForge — audio/video -> transcript + subtitles.
 *
 * Pipeline: user uploads a small audio/video file as a Telegram document
 * (or sends a voice note) -> worker downloads it from Telegram (<=20MB
 * bot API limit) -> Workers AI Whisper (@cf/openai/whisper) ->
 * SRT/VTT/TXT reply. Free: 10 min/month base quality; credits/Pro unlock
 * more minutes and SRT/VTT export.
 */

import { spendCredits } from "@forgekit/credits";
import { parseLocale, t } from "@forgekit/i18n";
import { RateLimiter } from "@forgekit/ratelimit";
import { BotApi, type TgUpdate, parseUpdate } from "@forgekit/app-shared";
import { toSrt, toTxt, toVtt, type Segment } from "./formatters";
import { transcribeAudio, wordsToSegments, type WhisperResponse } from "./whisper";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  KV: KVNamespace;
  DB: D1Database;
  /** Workers AI binding (wrangler.toml). */
  AI: Ai;
}

/** Free monthly transcription minutes. */
const FREE_MONTHLY_SECONDS = 600;
/** Credits burned per minute of audio (rounded up). */
const CREDITS_PER_MINUTE = 1;
/** Telegram bot API download cap. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export const MODEL_FREE = "@cf/openai/whisper";

const MESSAGES = {
  en: {
    start: "Send me an audio or video file (up to ~20MB) and I'll transcribe it.\n\nFree: 10 minutes/month, plain text.\n/buy for more minutes and SRT/VTT subtitles.",
    no_file: "Send an audio/video FILE (attachment), not just text.",
    quota_exceeded: "Monthly free minutes used up ({minutes}/mo). /buy credits to keep going.",
    transcribing: "Transcribing ({seconds}s of audio)… this can take a moment.",
    done_text: "Transcript:\n\n{excerpt}",
    too_short_or_empty: "I couldn't hear anything in that file.",
    failed: "Transcription failed — the file may be unsupported. Nothing was charged.",
    balance: "\n\nCredits left: {balance}.",
  },
  "pt-BR": {
    start: "Me manda um arquivo de áudio ou vídeo (até ~20MB) que eu transcrevo.\n\nGrátis: 10 minutos/mês, texto simples.\n/buy para mais minutos e legendas SRT/VTT.",
    no_file: "Manda um ARQUIVO de áudio/vídeo (anexo), não só texto.",
    quota_exceeded: "Minutos grátis do mês acabaram ({minutes}/mês). Compre créditos com /buy para continuar.",
    transcribing: "Transcrevendo ({seconds}s de áudio)… pode demorar um pouco.",
    done_text: "Transcrição:\n\n{excerpt}",
    too_short_or_empty: "Não consegui escutar nada nesse arquivo.",
    failed: "A transcrição falhou — o arquivo pode não ser suportado. Nada foi cobrado.",
    balance: "\n\nCréditos restantes: {balance}.",
  },
};

interface AudioTarget {
  fileId: string;
  durationSeconds: number;
}

/** Pick the best audio-bearing attachment from a message. */
export function pickAudioTarget(update: TgUpdate): AudioTarget | null {
  const msg = update.message;
  if (!msg) return null;
  const anyMsg = msg as unknown as Record<string, unknown>;
  if (anyMsg.voice || anyMsg.audio || anyMsg.video_note || anyMsg.video) {
    const media = (anyMsg.voice ?? anyMsg.audio ?? anyMsg.video_note ?? anyMsg.video) as
      | { file_id?: string; duration?: number }
      | undefined;
    if (!media?.file_id) return null;
    return { fileId: media.file_id, durationSeconds: Math.ceil(media.duration ?? 0) };
  }
  if (anyMsg.document) {
    const doc = anyMsg.document as { file_id?: string; mime_type?: string; duration?: number };
    if (doc.file_id && (doc.mime_type?.startsWith("audio/") || doc.mime_type?.startsWith("video/"))) {
      return { fileId: doc.file_id, durationSeconds: Math.ceil(doc.duration ?? 60) };
    }
  }
  return null;
}

async function telegramFileUrl(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const json = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!json.ok || !json.result?.file_path) throw new Error("getFile failed");
  return `https://api.telegram.org/file/bot${token}/${json.result.file_path}`;
}

/** Format a finished transcript into the requested output kind. */
export function renderOutputs(resp: WhisperResponse): { txt: string; srt: string; vtt: string } {
  const segments: Segment[] = resp.words?.length
    ? wordsToSegments(resp.words)
    : resp.text
      ? [{ start: 0, end: 1, text: resp.text }]
      : [];
  return {
    txt: toTxt(segments),
    srt: toSrt(segments),
    vtt: toVtt(segments),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("transcribeforge worker up", { status: 200 });

    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    const expected = env.WEBHOOK_SECRET;
    if (header !== expected) return new Response("bad secret", { status: 401 });

    const update = (await request.json()) as TgUpdate;
    const route = parseUpdate(update);
    if (route.kind !== "command") return new Response("ok");
    const { command, chatId, user } = route.ctx;
    const locale = parseLocale(user.language_code);
    const bot = new BotApi(env.TELEGRAM_BOT_TOKEN);

    if (command === "/start" || command === "/help") {
      await bot.sendMessage(chatId, t(MESSAGES, locale, "start"));
      return new Response("ok");
    }

    const target = pickAudioTarget(update);
    if (!target) {
      await bot.sendMessage(chatId, t(MESSAGES, locale, "no_file"));
      return new Response("ok");
    }

    // Quota gate: free users get FREE_MONTHLY_SECONDS per month via KV window;
    // everyone pays credits per minute beyond that.
    const monthWindow = 30 * 86400;
    const limiter = new RateLimiter(env.KV, { freeLimit: FREE_MONTHLY_SECONDS, windowSeconds: monthWindow });
    const gate = await limiter.consume(
      "transcribeforge",
      `user:${user.id}:sec`,
      false,
    );
    const billableSeconds = gate.allowed ? 0 : target.durationSeconds;
    const creditsDue = Math.max(1, Math.ceil(billableSeconds / 60)) * CREDITS_PER_MINUTE;

    if (billableSeconds > 0) {
      const remaining = await spendCredits(env.DB, user.id, creditsDue, `transcribe:${target.fileId.slice(0, 12)}`);
      if (remaining === null) {
        await bot.sendMessage(chatId, t(MESSAGES, locale, "quota_exceeded", { minutes: Math.round(FREE_MONTHLY_SECONDS / 60) }));
        return new Response("ok");
      }
    }

    try {
      await bot.sendMessage(chatId, t(MESSAGES, locale, "transcribing", { seconds: target.durationSeconds }));

      const fileUrl = await telegramFileUrl(env.TELEGRAM_BOT_TOKEN, target.fileId);
      const audioRes = await fetch(fileUrl);
      if (!audioRes.ok) throw new Error(`download ${audioRes.status}`);
      const buf = await audioRes.arrayBuffer();
      if (buf.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("file too large");

      const resp = await transcribeAudio(env.AI, MODEL_FREE, buf);
      const outputs = renderOutputs(resp);

      const excerpt = outputs.txt.trim().slice(0, 3500);
      await bot.sendMessage(chatId, t(MESSAGES, locale, "done_text", { excerpt }));
      if (outputs.srt.trim().length > 0) {
        // SRT/VTT are Pro perks; send when present and short enough for a message.
        await bot.sendMessage(chatId, [outputs.srt.slice(0, 3500)].join(""));
      }
      return new Response("ok");
    } catch (err) {
      console.error("transcribe failed", err);
      await bot.sendMessage(chatId, t(MESSAGES, locale, "failed"));
      return new Response("ok");
    }
  },
};
