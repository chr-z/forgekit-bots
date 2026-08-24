import { describe, expect, it } from "vitest";
import { extractUrl, parseUpdate, type CommandContext } from "./updates";
import type { TgUpdate } from "./botapi";

const from = { id: 42, is_bot: false, first_name: "Zee", language_code: "pt-br" };
const chat = { id: 42, type: "private" };

function msgUpdate(text: string): TgUpdate {
  return { update_id: 1, message: { message_id: 10, from, chat, text } } as TgUpdate;
}

describe("parseUpdate", () => {
  it("routes slash commands with args and locale-bearing users", () => {
    const r = parseUpdate(msgUpdate("/start welcome"));
    expect(r.kind).toBe("command");
    expect((r as { ctx: CommandContext }).ctx).toMatchObject({
      command: "/start",
      args: "welcome",
      chatId: 42,
    });
  });

  it("strips @botname in group commands (case-insensitive)", () => {
    const r = parseUpdate(msgUpdate("/Link@ClipGrabBot https://vt.tiktok.com/abc/"));
    expect(r.kind).toBe("command");
    expect((r as { ctx: CommandContext }).ctx.command).toBe("/link");
  });

  it("routes pre_checkout queries", () => {
    const r = parseUpdate({
      update_id: 2,
      pre_checkout_query: { id: "pcq1", from, invoice_payload: "pack:r10" },
    } as unknown as TgUpdate);
    expect(r).toMatchObject({ kind: "pre_checkout", queryId: "pcq1", payload: "pack:r10" });
  });

  it("routes message.successful_payment with payer + charge id", () => {
    const r = parseUpdate({
      update_id: 4,
      message: {
        message_id: 11,
        from,
        chat,
        successful_payment: {
          currency: "XTR",
          total_amount: 150,
          invoice_payload: "pack:c100",
          telegram_payment_charge_id: "chg_abc123",
        },
      },
    } as unknown as TgUpdate);
    expect(r.kind).toBe("successful_payment");
    if (r.kind === "successful_payment") {
      expect(r.ctx).toMatchObject({ chatId: 42 });
      expect(r.payment).toMatchObject({
        invoice_payload: "pack:c100",
        telegram_payment_charge_id: "chg_abc123",
        total_amount: 150,
      });
    }
  });

  it("a successful payment is not mistaken for a command", () => {
    const r = parseUpdate({
      update_id: 5,
      message: {
        message_id: 12,
        from,
        chat,
        text: "/start",
        successful_payment: {
          currency: "XTR",
          total_amount: 300,
          invoice_payload: "sub:clipgrab-pro",
          telegram_payment_charge_id: "chg_def456",
        },
      },
    } as unknown as TgUpdate);
    // payment wins over the text field — fulfillment must not be skipped
    expect(r.kind).toBe("successful_payment");
  });

  it("ignores bots, non-text messages and plain text", () => {
    expect(parseUpdate({ update_id: 3 } as TgUpdate).kind).toBe("unhandled");
    expect(parseUpdate(msgUpdate("hello there")).kind).toBe("unhandled");
    const botMsg = msgUpdate("/start");
    if (botMsg.message?.from) botMsg.message.from.is_bot = true;
    expect(parseUpdate(botMsg).kind).toBe("unhandled");
  });
});

describe("extractUrl", () => {
  it("accepts http(s) URLs and ignores the rest", () => {
    expect(extractUrl("https://vt.tiktok.com/x/")?.hostname).toBe("vt.tiktok.com");
    expect(extractUrl("http://example.com")).toBeInstanceOf(URL);
    expect(extractUrl("ftp://example.com")).toBeNull();
    expect(extractUrl("not a url")).toBeNull();
    expect(extractUrl("")).toBeNull();
  });
});
