/**
 * forgekit-telegram — minimal Telegram Bot API client for Workers.
 *
 * Deliberately tiny: only the calls our bots make. No bot framework.
 */

const API = "https://api.telegram.org";

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
  language_code?: string;
}

export interface Chat {
  id: number;
  type: string;
}

export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; from?: TgUser; chat: Chat; text?: string };
  pre_checkout_query?: { id: string; from: TgUser; invoice_payload: string };
  successful_payment_message?: never;
}

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class BotApi {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as ApiResponse<T>;
    if (!json.ok || json.result === undefined) {
      throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
    }
    return json.result;
  }

  sendMessage(
    chatId: number,
    text: string,
    opts?: { reply_markup?: unknown; parse_mode?: "HTML" },
  ): Promise<Message> {
    return this.call<Message>("sendMessage", {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...opts,
    });
  }

  answerPreCheckoutQuery(id: string, ok: boolean, errorMessage?: string): Promise<boolean> {
    return this.call<boolean>("answerPreCheckoutQuery", {
      pre_checkout_query_id: id,
      ok,
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  }

  /** One-off: register the webhook with a shared secret. Run during deploy. */
  async setWebhook(url: string, secret: string): Promise<boolean> {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message", "pre_checkout_query"],
    });
  }
}

export interface Message {
  message_id: number;
  chat: Chat;
}
