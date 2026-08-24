/**
 * documind test helpers — D1/KV/fetch fakes shared by the worker suite.
 */
import { buildIndex } from "./rag";

export const PDF_TEXT =
  "O prazo de garantia é de doze meses. A multa rescisória é de quarenta por cento.";

/** Real FlateDecode PDF around one text stream (native CompressionStream). */
export async function buildPdfBytes(): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const content = `BT (${PDF_TEXT}) Tj ET`;
  const buf = await new Response(new Blob([content]).stream().pipeThrough(cs)).arrayBuffer();
  const z = new Uint8Array(buf);
  let bin = "";
  for (const b of z) bin += String.fromCharCode(b);
  const s = `%PDF-1.4\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n${bin}\nendstream\n%%EOF`;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

export interface DocRowStub {
  id: number;
  tg_user_id: number;
  title: string;
  n_pages: number;
  n_chunks: number;
}

/** D1 stub covering every statement the worker + credits package issue. */
export function makeDocD1() {
  const docs: DocRowStub[] = [];
  const chunks: { doc_id: number; n: number; text: string }[] = [];
  const usage: unknown[][] = [];
  const subs = new Map<number, string>();
  const balances = new Map<number, number>();
  const charges = new Set<string>();
  let nextId = 1;

  function prepare(sql: string) {
    let args: unknown[] = [];
    const api = {
      bind(...a: unknown[]) {
        args = a;
        return api;
      },
      async run() {
        if (sql.startsWith("INSERT OR IGNORE INTO users")) {
          const id = args[0] as number;
          if (!balances.has(id)) balances.set(id, 0);
          return { meta: {} };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO star_payments")) {
          const chargeId = args[0] as string;
          if (charges.has(chargeId)) return { meta: { changes: 0 } }; // idempotency PK
          charges.add(chargeId);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO credit_events")) {
          // The UPDATE users SET balance branch mirrors the cached column;
          // the ledger row itself must not apply the delta twice.
          return { meta: {} };
        }
        if (sql.startsWith("UPDATE users SET balance")) {
          // Mirror of D1 semantics: report meta.changes so the credits
          // package's compare-and-set debit behaves like production.
          const [amount, userId] = args as [number, number];
          if (sql.includes("balance + ?")) {
            balances.set(userId, (balances.get(userId) ?? 0) + amount);
            return { meta: { changes: 1 } };
          }
          const cur = balances.get(userId) ?? 0;
          const min = args[2] as number | undefined; // CAS guard: balance >= ?
          if (min !== undefined && cur < min) return { meta: { changes: 0 } };
          balances.set(userId, cur - amount);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO dm_docs")) {
          const [userId, title, pages, nChunks] = args as [number, string, number, number];
          const row = { id: nextId++, tg_user_id: userId, title, n_pages: pages, n_chunks: nChunks };
          docs.push(row);
          return { meta: { last_row_id: row.id } };
        }
        if (sql.startsWith("INSERT INTO dm_chunks")) {
          const [docId, n, text] = args as [number, number, string];
          chunks.push({ doc_id: docId, n, text });
          return { meta: {} };
        }
        if (sql.startsWith("DELETE FROM dm_chunks WHERE doc_id IN")) {
          const uid = args[0] as number;
          for (let i = chunks.length - 1; i >= 0; i--) {
            const doc = docs.find((d) => d.id === chunks[i]!.doc_id);
            if (doc?.tg_user_id === uid) chunks.splice(i, 1);
          }
          return { meta: {} };
        }
        if (sql.startsWith("DELETE FROM dm_chunks")) {
          const docId = args[0] as number;
          for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i]!.doc_id === docId) chunks.splice(i, 1);
          return { meta: {} };
        }
        if (sql.startsWith("DELETE FROM dm_docs WHERE id")) {
          const [id, uid] = args as [number, number];
          for (let i = docs.length - 1; i >= 0; i--) {
            if (docs[i]!.id === id && docs[i]!.tg_user_id === uid) docs.splice(i, 1);
          }
          return { meta: {} };
        }
        if (sql.startsWith("DELETE FROM dm_docs")) {
          const uid = args[0] as number;
          for (let i = docs.length - 1; i >= 0; i--) if (docs[i]!.tg_user_id === uid) docs.splice(i, 1);
          return { meta: {} };
        }
        if (sql.startsWith("INSERT INTO usage_log")) {
          usage.push(args);
          return { meta: {} };
        }
        throw new Error(`unexpected run(): ${sql}`);
      },
      async first<T>(): Promise<T | null> {
        if (sql.startsWith("SELECT pro_until")) {
          const until = subs.get(args[0] as number);
          return (until ? { pro_until: until } : null) as T | null;
        }
        if (sql.startsWith("SELECT COUNT(*)")) {
          const uid = args[0] as number;
          return { n: docs.filter((d) => d.tg_user_id === uid).length } as T | null;
        }
        if (sql.startsWith("SELECT balance FROM users")) {
          return { balance: balances.get(args[0] as number) ?? 0 } as T | null;
        }
        if (sql.includes("dm_docs") && sql.includes("AND id = ?")) {
          const [uid, id] = args as [number, number];
          return (docs.find((d) => d.id === id && d.tg_user_id === uid) as T) ?? null;
        }
        if (sql.includes("ORDER BY id DESC LIMIT 1")) {
          const uid = args[0] as number;
          const list = docs.filter((d) => d.tg_user_id === uid).sort((a, b) => b.id - a.id);
          return (list[0] as T) ?? null;
        }
        throw new Error(`unexpected first(): ${sql}`);
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes("SELECT id, title, n_pages, n_chunks FROM dm_docs")) {
          const uid = args[0] as number;
          return {
            results: docs.filter((d) => d.tg_user_id === uid).sort((a, b) => b.id - a.id).slice(0, 10),
          } as { results: T[] };
        }
        if (sql.includes("SELECT n, text FROM dm_chunks")) {
          const docId = args[0] as number;
          return {
            results: chunks
              .filter((c) => c.doc_id === docId)
              .sort((x, y) => x.n - y.n)
              .map((c) => ({ n: c.n, text: c.text })),
          } as { results: T[] };
        }
        throw new Error(`unexpected all(): ${sql}`);
      },
    };
    return api;
  }

  return { db: { prepare } as unknown as D1Database, docs, chunks, usage, subs, balances };
}

export interface CapturingFetchOpts {
  fileBytes?: Uint8Array;
  /** Collected sendMessage texts (in order). */
  sent: string[];
}

/** Global-fetch fake: Telegram getFile/download + outgoing message capture. */
export function makeCaptureFetch(opts: CapturingFetchOpts): typeof fetch {
  const impl = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = String(input);
    if (url.includes("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "d/f.pdf" } }));
    }
    if (url.includes("/file/bot")) {
      return new Response(opts.fileBytes ?? new Uint8Array());
    }
    if (url.includes("/sendMessage")) {
      let text = "";
      try {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { text?: string };
        text = String(body.text ?? "");
      } catch {
        text = "";
      }
      opts.sent.push(text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response("nf", { status: 404 });
  };
  return impl as unknown as typeof fetch;
}
