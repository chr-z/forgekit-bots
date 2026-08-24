import { describe, expect, it } from "vitest";
import { classifyAttachment, ingestDocument, MAX_DOC_BYTES } from "./ingest";

/** In-memory D1 stub covering exactly the statements ingestDocument issues. */
function makeD1() {
  const docs: { id: number; tg_user_id: number; title: string; n_pages: number; n_chunks: number }[] = [];
  const chunks: { doc_id: number; n: number; text: string }[] = [];
  let nextId = 1;
  function prepare(sql: string) {
    let args: unknown[] = [];
    const api = {
      bind: (...a: unknown[]) => {
        args = a;
        return api;
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO dm_docs")) {
          const [userId, title, pages, nChunks] = args as [number, string, number, number];
          const id = nextId++;
          docs.push({ id, tg_user_id: userId, title, n_pages: pages, n_chunks: nChunks });
          return { meta: { last_row_id: id } };
        }
        if (sql.startsWith("INSERT INTO dm_chunks")) {
          const [docId, n, text] = args as [number, number, string];
          chunks.push({ doc_id: docId, n, text });
          return { meta: {} };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
    };
    return api;
  }
  return { db: { prepare } as never as D1Database, docs, chunks };
}

function makeFetcher(opts: {
  bytes?: Uint8Array;
  status?: number;
  noFilePath?: boolean;
  networkFail?: boolean;
}) {
  return ((input: unknown) => {
    const url = String(input);
    if (url.includes("/getFile")) {
      if (opts.networkFail) return Promise.reject(new Error("offline"));
      return Promise.resolve(
        new Response(JSON.stringify(opts.noFilePath ? { result: {} } : { result: { file_path: "docs/x.pdf" } }), {
          status: 200,
        }),
      );
    }
    if (url.includes("/file/bot")) {
      if (opts.status) return Promise.resolve(new Response("err", { status: opts.status }));
      return Promise.resolve(new Response(opts.bytes ?? new Uint8Array(), { status: 200 }));
    }
    return Promise.resolve(new Response("nf", { status: 404 }));
  }) as typeof fetch;
}

const PDF_MAGIC = "%PDF-";

describe("classifyAttachment", () => {
  it("routes by extension and mime, defaults title", () => {
    expect(classifyAttachment({ file_name: "contrato.PDF" }).kind).toBe("pdf");
    expect(classifyAttachment({ mime_type: "application/pdf" }).kind).toBe("pdf");
    expect(classifyAttachment({ file_name: "notas.txt", mime_type: "text/plain" }).kind).toBe("text");
    expect(classifyAttachment({ file_name: "dados.csv" }).kind).toBe("text");
    expect(classifyAttachment({ file_name: "foto.jpg", mime_type: "image/jpeg" }).kind).toBeNull();
    expect(classifyAttachment({ file_name: "" }).title).toBe("documento");
    expect(classifyAttachment({ file_name: "relatório-final.pdf" }).title).toBe("relatório-final");
  });
});

describe("ingestDocument", () => {
  it("happy path PDF: extracts, chunks and persists numbered rows", async () => {
    // Build a real flated PDF inline (native CompressionStream in Node 18+).
    const cs = new CompressionStream("deflate");
    const content = "BT (Cláusula quinta: reajuste anual pelo IPCA.) Tj ET";
    const zbuf = await new Response(new Blob([content]).stream().pipeThrough(cs)).arrayBuffer();
    const z = new Uint8Array(zbuf);
    let bin = "";
    for (const b of z) bin += String.fromCharCode(b);
    const pdfText = `${PDF_MAGIC}1.4\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n${bin}\nendstream\n%%EOF`;
    const bytes = new Uint8Array(pdfText.length);
    for (let i = 0; i < pdfText.length; i++) bytes[i] = pdfText.charCodeAt(i);

    const store = makeD1();
    const result = await ingestDocument(
      { fileId: "F1", title: "Contrato", kind: "pdf", userId: 42, botToken: "T" },
      { fetchImpl: makeFetcher({ bytes }), db: store.db },
    );
    expect(result.ok).toBe(true);
    expect(result.doc!.nChunks).toBeGreaterThanOrEqual(1);
    expect(store.docs).toHaveLength(1);
    expect(store.docs[0]!.tg_user_id).toBe(42);
    expect(store.chunks.length).toBe(result.doc!.nChunks);
    expect(store.chunks[0]!.n).toBe(1);
    expect(store.chunks[0]!.text).toContain("IPCA");
  });

  it("maps failure modes to honest reasons without persisting anything", async () => {
    const base = { title: "x", kind: "text" as const, userId: 1 };

    const big = new Uint8Array(MAX_DOC_BYTES + 1);
    const tooBig = await ingestDocument(
      { ...base, fileId: "A", kind: "text", botToken: "T" },
      { fetchImpl: makeFetcher({ bytes: big }), db: makeD1().db },
    );
    expect(tooBig.ok).toBe(false);
    expect(tooBig.reason).toBe("too_large");

    const httpErr = await ingestDocument(
      { ...base, fileId: "B", kind: "text", botToken: "T" },
      { fetchImpl: makeFetcher({ status: 413 }), db: makeD1().db },
    );
    expect(httpErr.reason).toBe("too_large");

    const noPath = await ingestDocument(
      { ...base, fileId: "C", kind: "text", botToken: "T" },
      { fetchImpl: makeFetcher({ noFilePath: true }), db: makeD1().db },
    );
    expect(noPath.reason).toBe("failed");

    const offline = await ingestDocument(
      { ...base, fileId: "D", kind: "text", botToken: "T" },
      { fetchImpl: makeFetcher({ networkFail: true }), db: makeD1().db },
    );
    expect(offline.reason).toBe("failed");
  });

  it("refuses scanned PDFs (no text ops) and faked PDF magic", async () => {
    const store = makeD1();
    const scanned = new TextEncoder().encode(`${PDF_MAGIC}1.4 junk no streams`);
    const noText = await ingestDocument(
      { fileId: "E", title: "Scan", kind: "pdf", userId: 7, botToken: "T" },
      { fetchImpl: makeFetcher({ bytes: scanned }), db: store.db },
    );
    expect(noText.ok).toBe(false);
    expect(noText.reason).toBe("no_text");

    const fakePdf = new TextEncoder().encode("definitely not a pdf but starts weird");
    const notPdf = await ingestDocument(
      { fileId: "F", title: "Fake", kind: "pdf", userId: 7, botToken: "T" },
      { fetchImpl: makeFetcher({ bytes: fakePdf }), db: makeD1().db },
    );
    expect(notPdf.reason).toBe("unsupported_format");
    expect(store.docs).toHaveLength(0); // nothing persisted on failures
  });
});
