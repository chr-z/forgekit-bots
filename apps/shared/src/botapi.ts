export interface Chat {
  id: number;
  type: string;
}

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  language_code?: string;
}

/**
 * Telegram Update shape (only fields this fleet consumes).
 *
 * `message` is intentionally loose: the same object carries plain text
 * commands AND `message.successful_payment`. Narrow it in parseUpdate.
 */
export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: TgUser;
    chat: Chat;
    text?: string;
    successful_payment?: {
      currency: string; // "XTR" for Stars
      total_amount: number;
      invoice_payload: string;
      telegram_payment_charge_id: string;
    };
  };
  pre_checkout_query?: { id: string; from: TgUser; invoice_payload: string };
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
      throw new Error(`BotApi ${method} failed: ${json.description ?? res.status}`);
    }
    return json.result;
  }

  async sendMessage(chatId: number, text: string): Promise<unknown> {
    return this.call("sendMessage", { chat_id: chatId, text });
  }

  async answerPreCheckoutQuery(id: string, ok: boolean, errorMessage?: string): Promise<unknown> {
    return this.call("answerPreCheckoutQuery", {
      pre_checkout_query_id: id,
      ok,
      error_message: errorMessage,
    });
  }

  async setWebhook(url: string, secret: string): Promise<unknown> {
    return this.call("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message", "pre_checkout_query"],
    });
  }

  async getFile(fileId: string): Promise<{ file_path?: string }> {
    return this.call("getFile", { file_id: fileId });
  }

  fileUrl(filePath: string): string {
    return `${FILE_API}/file/bot${this.token}/${filePath}`;
  }

  async sendChatAction(chatId: number, action: string): Promise<unknown> {
    return this.call("sendChatAction", { chat_id: chatId, action });
  }
}

const API = "https://api.telegram.org";
const FILE_API = "https://api.telegram.org";
