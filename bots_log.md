# Bots Log — registro de execução

## 2026-08-24 — Tick 3: auditoria anti-false-done ClipGrab + buraco de pagamento fechado

**Guardrail:** clone fresco → 147/147 verde, tsc limpo, CI success no main (run 32707401748).

### Achado principal: pagamentos nunca eram creditados (toda a frota)
`parseUpdate` ignorava `message.successful_payment` (o tipo nem existia:
`successful_payment_message?: never`). O bot aprovava o pré-checkout e DEPOIS
descartava o update de confirmação → usuário pagava em Stars e não recebia nada.
Corrigido em camadas, um commit por módulo:
1. `packages/ratelimit`: + `peek()` (lê uso da janela sem consumir) — testado.
2. `apps/shared`: `TgUpdate.message.successful_payment` tipado; `parseUpdate`
   roteia `{kind:"successful_payment", ctx, payment}` (pagamento vence texto
   quando ambos presentes) — 2 testes novos.
3. Todos os 5 workers: handler de fulfillment via `fulfillSuccessfulPayment`
   (idempotente por charge id), confirmação ao usuário ANTES dependia de nada —
   crédito/grante acontece primeiro; ClipGrab/DocuMind/SummarizeTube/TranscribeForge
   com mensagem i18n. InstaToolkit ganhou binding `DB` no wrangler.toml.
4. TranscribeForge ganhou catálogo Stars que não tinha (`pack:t300`, 150⭐ = 300 min).

### ClipGrab conforme diretiva do dono (serverless puro, sem VM Oracle)
Auditoria confirmou que a arquitetura nova já estava no repo: resolvers TS puros
(TikTok feed-API + web hydration; IG embed), YouTube FORA (stub documentado com
ToS do Cobalt público), roadmap Deno Deploy + youtube.js anotado. BOTS_EMPIRE.md
(saas_factory) já refletia a decisão 2026-08-24. Nada a reconstruir — só lacunas:
- `/status` era citado nas mensagens mas não existia → implementado (plataformas
  suportadas, cota usada via peek, estado Pro).
- README do app + README raiz + deploy.md atualizados (fluxo de pagamento
  documentado ponta a ponta).

### Testes
147 → **150** (+3: peek, successful_payment routing, payment-not-command).
Suite completa verde local; tsc --noEmit limpo.

---

## 2026-08-24 — ONDA 2, tick 1 (worker wave2)

**Guardrail:** ONDA 1 verificada antes de construir. Estado recebido: 82/83 testes,
CI vermelho no push inicial (subpath import sem mapa de exports). Base estabilizada
PRIMEIRO, depois bot novo.

### Commits desta rodada

1. `fix(core)` — base estabilizada:
   - `apps/shared/package.json`: mapa `exports` (`./botapi`, `./updates`) — corrige o
     failure de CI no Linux (subpath imports sem resolução).
   - `apps/transcribeforge/src/index.ts`: fallback de segmento aplicado a SRT/VTT/TXT
     (antes só TXT) + import de `wordsToSegments` apontado para `./whisper` (estava
     importado de `./formatters`, que não exporta).
2. `fix(apps)` — bug real de runtime pego pelo tsc: todos os handlers faziam
   `const { command, chatId, user } = route` mas o `parseUpdate` retorna
   `{ kind: "command", ctx: CommandContext }`. Em produção NENHUM comando seria
   respondido. Corrigido em transcribeforge, clipgrab e instatoolkit
   (`route.ctx`). O SummarizeTube já nasceu certo.
3. `feat(summarizetube)` — Bot 4 da ONDA 2:
   - `youtube.ts` (puro JS, zero binários): parse de URL em todas as formas
     (watch/youtu.be/shorts/embed/live/nocookie), extração do
     `ytInitialPlayerResponse` por brace-matching com normalizador de literal JS
     (chaves sem aspas, vírgula solta), escolha de trilha de legenda (manual >
     ASR, preferência pt-BR > pt > en), fetch+parse timedtext json3 e XML legado,
     transcript com dedup de rolling captions, índice de timestamps [mm:ss] em
     blocos ~45s, chunking por sentença.
   - `summarizer.ts`: Workers AI llama-3.1-8b-instruct map-reduce (parcial por
     chunk → merge TLDR+bullets), parser tolerante da resposta do modelo,
     fallback extrativo determinístico (nunca inventa conteúdo).
   - `index.ts`: worker completo — webhook com secret, /start /help /buy /buy,
     /summarize + alias /s, quota free 3/dia via KV, crédito do pacote cobre
     resumo além do limite (reembolso automático se o pipeline falha — falha
     nunca cobra), catálogo Stars (Pro 200 Stars/30d, pack 100 = 150 Stars),
     pre-checkout review, deep mode exclusivo Pro.
   - Testes: 29 novos asserts-blocos (fakes de fetch/Ai, sem rede) — suíte toda
     **112/112 verde** em ~1s. tsc limpo nos apps.

### Notas técnicas
- `extractPlayerResponse` pega a ÚLTIMA atribuição do marcador na página
  (páginas reais trazem placeholder cedo + objeto populado depois).
- Decodificação de entidades XML: strip de tags ANTES de decodificar
  (`&lt;b&gt;` viraria tag se decodificasse primeiro).
- Free tier: 1 GET youtube.com/watch + 1 GET timedtext + neurons só das legendas;
  nada perto dos limites do plano free.
- YouTube download (ClipGrab) segue fora do escopo comercial: documentado no README.

### Pendente próximo tick
- CI do GitHub precisa ficar verde neste push (primeiro push com exports map).
- DocuMind (Bot 5) e VoiceClone Alerts (Bot 6) — restantes da ONDA 2.
- BOTS_EMPIRE.md raiz ainda descreve a ONDA 1 como "em construção" — atualizar
  quando os 3 bots da ONDA 2 estiverem core-ready.

---

# Tick 24/08 — Wave 2: DocuMind (Bot 5) core-ready

Branch `wave2-documind` -> PR para main. Guardrail respeitado: ONDA 1 verde + SummarizeTube mergeado antes de começar.

## O que foi construído (apps/documind/)
- `pdf.ts`: extrator PDF em TypeScript puro — varre streams `stream...endstream`, infla FlateDecode com DecompressionStream NATIVO do Workers (zero binários/wasm), extrai strings literais/hex dos operadores Tj/TJ (paren balancing, escapes octais, UTF-16BE via BOM). Páginas = unidades de content stream (paginação aproximada, rotulada como tal).
- `rag.ts`: chunking por sentenças com orçamento de chars, retrieval por keywords COM stopwords pt/en (função não decide match), resposta grounded: modelo DEVE citar [n]; sem citação / NOT_IN_DOCUMENT / erro de IA -> degrada para resposta extrativa determinística. Nunca inventa.
- `ingest.ts`: file_id -> getFile -> download (teto 20MB do Bot API), sniff de magic bytes %PDF-, truncamento honesto em 60k chars, persistência dm_docs/dm_chunks. Nada persiste se extração falha.
- `index.ts`: worker completo — ingest por anexo, /ask+/q com recuperação ANTES de cobrar (match zero nunca cobra), quota free 2 docs + 10 perguntas/30d via KV RateLimiter, crédito do pack cobre pergunta além da cota, Pro 300 Stars/30d, pre-checkout review, /docs /use /forget, usage_log, i18n EN/pt-BR. AI binding OPCIONAL (wrangler.toml sem [ai] — roda 100% sem IA).

## Decisão de arquitetura (Vectorize)
Vectorize free tier exige plano pago na prática -> "RAG" = keyword scoring determinístico sobre chunks numerados em D1. Custo marginal ZERO por pergunta por construção. Roadmap: migrar p/ embeddings quando houver receita.

## Testes
- 35 novos asserts-blocos (pdf 12, rag 12, ingest 5, worker 6), fixtures PDF REAIS comprimidos via CompressionStream nativo do Node. Sem rede, sem mocks de LLM fora de fakes locais.
- Suíte do monorepo: **147/147 verde** (112 pré-existentes + 35). tsc --noEmit limpo no app.

## Bugs pegos pelos testes durante o desenvolvimento
- EOL antes de `endstream` ia junto no payload e corrompia o inflate -> trim implementado.
- Falta de separador entre strings adjacentes no TJ grudia palavras ("R$500" vs "R$ 500").
- Stub de D1 sem meta.changes quebrava o CAS do spendCredits; KV stub sem parse json quebrava o RateLimiter -> stubs agora espelham a semântica real.
- Ingest usava URL placeholder sem token do bot -> corrigido para bot<token>/getFile+file/bot<token> (padrão TranscribeForge).

## Infra/docs atualizados neste tick
- infra/schema.d1.sql: +dm_docs, +dm_chunks (PK doc_id+n = id de citação).
- README.md: DocuMind na tabela da frota; deploy.md: KV documind + nota de AI opcional; apps/documind/README.md novo (limitações honestas).

## Pendente próximo tick
- VoiceClone Alerts (Bot 6) fecha a ONDA 2; depois, BOTS_EMPIRE.md raiz.
- Deploy real segue bloqueado por wrangler login interativo (igual aos outros bots).

# Tick 24/08 (tarde) — Wave 2 fechada: VoiceClone Alerts (Bot 6) core-ready

## Estado na chegada deste worker
VoiceClone já estava implementado e mergeado no main por tick anterior
(commits 6e17769..823b496): matcher léxico puro, store D1, fila de retry KV,
worker webhook-driven com /addchannel admin-proof, cron só drena retry,
42 asserts verdes, CI success no último commit do main (run 32715472580).
Guardrail cumprido: suíte local re-verificada neste tick — **192/192 verde**
(25 arquivos), tsc --noEmit limpo no app.

## Lacunas de documentação fechadas NESTE tick
- `bots_log.md` não tinha a entrada do tick VoiceClone (o trabalho existia,
  o log não) → esta entrada.
- `BOTS_EMPIRE.md` (saas_factory) atualizado: ONDA 2 marcada como core-ready
  (3/3 bots), status real da frota = 6 bots core-ready aguardando deploy
  (wrangler login interativo segue o bloqueio comum a todos).

## Pendente próximo tick
- Deploy real dos 6 bots (bloqueio único: wrangler login interativo).
- ONDA 3 (InvoiceForge, PriceWatch, LinguaLeap, HabitForge) — próximo worker.

## 2026-08-24 09:05 UTC-3 — worker ONDA 2 (tick): auditoria + housekeeping
- Guardrail: ONDA 1 verde (192/192 local, CI success em todos os runs do main).
- Bots 4-6 JÁ completos por ticks anteriores: SummarizeTube (PR #1), DocuMind (PR #2),
  VoiceClone Alerts (+ runbook channel_post). Nada a construir — tick virou auditoria.
- Housekeeping: commit do VoiceClone tinha deixado o workspace fora do package-lock;
  registrado e pushed (9f80bf5). Repo limpo, main sincronizado.
- Pendente comum à frota: deploy real bloqueado só pelo wrangler login interativo.
