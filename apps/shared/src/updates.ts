/**
 * forgekit-telegram — update parsing helpers.
 *
 * The webhook contract: Telegram POSTs one Update per request. We extract
 * (user, chat, text) for commands and the two payment shapes, then route.
 */

import type { TgUpdate, TgUser } from "./botapi";

export interface CommandContext {
  user: TgUser;
  chatId: number;
  /** e.g. "/start" from "/start extra" */
  command: string;
  args: string;
}

/** Raw `message.successful_payment` shape (only fields we consume). */
export interface SuccessfulPaymentMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  successful_payment: {
    currency: string; // "XTR" for Stars
    total_amount: number;
    invoice_payload: string;
    telegram_payment_charge_id: string;
    from?: { id: number };
  };
}

export type Route =
  | { kind: "command"; ctx: CommandContext }
  | {
      kind: "channel_post";
      ctx: { chatId: number; chatType: string; messageId: number; text: string };
    }
  | { kind: "pre_checkout"; queryId: string; payload: string; user: TgUser }
  | {
      kind: "successful_payment";
      ctx: { user: TgUser | undefined; chatId: number };
      payment: SuccessfulPaymentMessage["successful_payment"];
    }
  | { kind: "unhandled" };

export function parseUpdate(update: TgUpdate): Route {
  const pcq = update.pre_checkout_query;
  if (pcq) {
    return { kind: "pre_checkout", queryId: pcq.id, payload: pcq.invoice_payload, user: pcq.from };
  }
  const msg = update.message;
  if (msg && typeof msg === "object" && "successful_payment" in msg) {
    const sp = (msg as unknown as SuccessfulPaymentMessage).successful_payment;
    if (sp) {
      return {
        kind: "successful_payment",
        ctx: { user: msg.from, chatId: msg.chat.id },
        payment: sp,
      };
    }
  }
  // Channel posts (VoiceClone Alerts): admin-only channels push these as
  // dedicated updates; text-less posts (media) are ignored.
  const cp = update.channel_post;
  if (cp?.chat && typeof cp.text === "string") {
    const text = cp.text.trim();
    if (text) {
      return {
        kind: "channel_post",
        ctx: { chatId: cp.chat.id, chatType: cp.chat.type, messageId: cp.message_id, text },
      };
    }
  }
  if (msg?.from && !msg.from.is_bot && typeof msg.text === "string") {
    const text = msg.text.trim();
    if (text.startsWith("/")) {
      const [rawCmd = "", ...rest] = text.split(/\s+/);
      // strip @botname suffix from group commands
      const command = rawCmd.split("@")[0]!.toLowerCase();
      return {
        kind: "command",
        ctx: { user: msg.from, chatId: msg.chat.id, command, args: rest.join(" ").trim() },
      };
    }
  }
  return { kind: "unhandled" };
}

/** Parse a URL-ish argument out of a message; returns null when absent/invalid. */
export function extractUrl(text: string): URL | null {
  const candidate = text.trim().split(/\s+/)[0];
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}
