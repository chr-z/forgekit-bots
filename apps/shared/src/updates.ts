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

export type Route =
  | { kind: "command"; ctx: CommandContext }
  | { kind: "pre_checkout"; queryId: string; payload: string; user: TgUser }
  | { kind: "unhandled" };

export function parseUpdate(update: TgUpdate): Route {
  const pcq = update.pre_checkout_query;
  if (pcq) {
    return { kind: "pre_checkout", queryId: pcq.id, payload: pcq.invoice_payload, user: pcq.from };
  }
  const msg = update.message;
  if (msg?.from && !msg.from.is_bot && typeof msg.text === "string") {
    const text = msg.text.trim();
    if (text.startsWith("/")) {
      const [rawCmd, ...rest] = text.split(/\s+/);
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
