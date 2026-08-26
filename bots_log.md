# Bots Log — registro de execução

## Wave 2 Pro-increment tick #8 (25/08 ~11:15 UTC-3) — DocuMind DOCX ingest SHIPPED via PR (264/264)
- Guardrail cumprido: worktree work_forgekit_w2 em feature/dm-docx, suite base
  verde antes do trabalho; sem PRs abertos (`gh pr list` vazio); nenhum worker
  vivo no repo (checado via Win32_Process + mtime — tick morto das 09h deixou
  o módulo pela metade, sem testes nem commit; este tick completou e verificou).
- Gap da roadmap fechado: BOTS_ROADMAP.md linha 41 promete "Manda PDF/**docx**"
  pro DocuMind — só pdf/text existiam. ONDA 2 continua 100% coberta.
- feat apps/documind/src/docx.ts: extrator OOXML puro-TS — leitor de central
  directory ZIP escrito byte-a-byte (EOCD scan c/ comentário, entries method
  0/8), inflate raw-deflate via DecompressionStream("deflate-raw"), CRC-32
  verificado por entrada (tabela 256), conversão w:p/w:t/w:tab/w:br/w:cr →
  texto com decode de entidades XML; partes lidas: document/header1/footer1.
  Falha honesta: container inválido/corrompido/sem texto => Error("no_text"/
  "corrupt_entry") mapeado pra no_text/failed — nunca conteúdo inventado.
- **BUG real corrigido pré-merge**: defaultInflate recebia `bytes.buffer`
  (ArrayBuffer inteiro) em vez da view subarray — com byteOffset > 0 todo docx
  real falharia como corrompido. Fix: Blob([view]) respeita os limites da view.
- feat ingest.ts: classifyAttachment ganha kind "docx" (extensão .docx OU mime
  OOXML; .doc legado fica fora) + branch de extração com magic "PK" + try/catch
  honesto. index.ts: mensagens unsupported_format EN/pt-BR atualizadas.
- Testes novos (+19 asserts): docx.test.ts (12 — CRC vector canônico 0xCBF43926,
  entidades, gluing runs/tabs/breaks, blank paragraphs interiores, central dir,
  deflate + CRC, STORED byte-exact, lixo não-zip, ordem document-first entre
  partes, bit-3 data descriptor resolve via central directory, corrupção =>
  corrupt_entry, size mentindo/method exótico => corrupt_entry, sem texto =>
  no_text); ingest.test.ts (+4 — classify docx ext/mime/.doc fora; happy path
  persistindo chunks c/ tab+entidade; fake PK / corpo vazio / corrompido sem
  persistir nada); index.test.ts (+3 — webhook aceita parecer.docx e responde
  /ask citando dele; antigo.doc recusado c/ msg de formato).
- Fixture builder buildDocxBytes() em testhelpers.ts: escreve ZIPs reais
  (local headers + central directory + EOCD) com opções de defeito controlado
  (stored/data descriptor/corrupt payload/bad size/bad method/document vazio)
  — exercita o parser contra layouts genuínos, não mocks.
- Docs: README da frota (PDF/**DOCX**/text), README do app (como funciona,
  comandos, limitações honestas incl. .doc legado fora).
- Verificação: Vitest **264/264 verde** (33 arquivos, eram 245),
  `tsc -p tsconfig.base.json --noEmit` limpo; CI tem que passar no PR antes
  do merge.

## Wave 2 Pro-increment tick #7 (25/08 ~08:00 UTC-3) — SummarizeTube /transcript SHIPPED via PR (245/245)
- Guardrail cumprido: clone fresh de main @ 0872f8c, npm ci, suite 234/234 verde,
  sem PRs abertos de outros workers no momento do tick (`gh pr list` vazio).
- Gap da roadmap fechado: linha 35 do BOTS_ROADMAP.md promete "resumo estruturado
  ... + transcrição" na entrega base — a transcrição limpa era calculada pelo
  pipeline e descartada. ONDA 2 completa + este incremento = roadmap da wave em dia.
- feat apps/summarizetube/src/transcript.ts: TranscriptDoc {title, author,
  durationSeconds, languageCode, text}; renderTranscriptReply entrega inline até
  3500 chars, acima disso corta preview em fronteira de parágrafo (+hint i18n com
  contagem total); toPlainTextFile gera .txt com bloco de metadados;
  renderTranscriptPdf reaproveita @forgekit/app-shared/pdf (tldr vazio => sem
  rótulo; parágrafos viram blocos; truncamento de página já coberto pelo writer).
- feat index.ts: pipeline agora retorna `transcript` junto do doc; /summarize
  cacheia KV summarizetube:lasttranscript:<user> TTL 7d (mesma política do lastdoc);
  handler /transcript [txt|pdf] com gating Pro, transcript_nothing p/ cache vazio/
  corrompido, filename sanitizado igual /export, falha de entrega NÃO cobra nada.
- i18n EN/pt-BR: transcript_pro_only / transcript_nothing / transcript_more ({chars}).
- Testes novos (11): transcript.test.ts (5 — chave KV, inline completo c/ header,
  preview em fronteira de parágrafo sem vazar bloco parcial, txt file c/ metadados,
  PDF real inflado byte-a-byte conferindo WinAnsi) + transcript.webhook.test.ts
  (6 via webhook — gate free sem tocar rede, cache vazio, inline curto, longo =>
  preview + .txt inspecionando o multipart, /transcript pdf silencioso c/ header
  %PDF-1.4, título hostil sanitizado).
- Gotchas aplicados desta vez: inflate pulando o EOL após "stream" (skill);
  re-export de transcriptDocKey no entrypoint pq o teste importa de ./index e o
  vitest não pega conflito import/declaração que o tsc pega.
- Guardrail: Vitest **245/245 verde** (32 arquivos), tsc limpo no app tocado,
  CI tem que passar no PR antes do merge.
- Bloqueio real INALTERADO: deploy de produção exige wrangler login interativo do dono.

## 2026-08-24 ~21:50 UTC-3 — Tick: auditoria ClipGrab serverless (#19)
- Diretiva do dono re-verificada ponto a ponto contra main @ 29de7f3: NADA a construir.
  - Sem VM Oracle/Cobalt self-host em nenhum path ativo; resolvers TikTok+IG isolados
    em módulos próprios COM teste (hydration PRIMARY, feed API c/ KV cooldown pós-429);
    IG via embed JSON público (payload contextJSON crawler-UA).
  - YouTube FORA do bot: stub documentado (ToS Cobalt público proíbe uso comercial),
    resposta honesta "coming soon"; roadmap Deno Deploy + youtube.js no README e deploy.md §7.
  - Modelo direct-link confirmado (bot nunca hospeda mídia → zero storage/banda nosso).
- Docs conferidos: apps/clipgrab/README.md (limitações honestas + arquitetura + estratégia
  429), BOTS_EMPIRE.md (seção ClipGrab = decisão 2026-08-24, fora do repo), packages core
  completos (credits/stars/auth/ratelimit/i18n/license_hmac), infra/schema.d1.sql, ci.yml.
- Verificação: pull --ff-only (31a9580→29de7f3); tsc --noEmit limpo; vitest 201/201
  (25 arquivos); CI main success no head.
- Pendente inalterado: deploy real (wrangler login interativo), ONDA 3 travada pelo guardrail.

## 2026-08-24 ~12:15 UTC-3 — Tick: Instagram resolver corrigido contra payload crawler-only (bug real de produção)
- **Guardrail**: clone em main @ fb6ecfe, vitest 198/198 verde antes de qualquer mudança.
- **Bug real descoberto por probe ao vivo** (manutenção reativa prevista na diretiva):
  o endpoint `/p/<code>/embed/captioned` hoje só serve o payload `contextJSON`
  para **user-agents de crawler** (`facebookexternalhit`). Com UA de browser
  (o que o resolver usava) a resposta é shell JS **sem nenhum dado** — ou seja,
  o resolver IG estava quebrado na prática mesmo com testes verdes.
- **Correção** (commit pequeno único `762117a`, apps/clipgrab):
  - `fetchEmbedHtml()` tenta candidatos de UA em ordem (crawler primeiro, browser
    como fallback) e exige o marcador `contextJSON` no corpo;
  - regex do valor-string agora tolera aspas escapadas dentro do blob;
  - `parseContextJSON()` desenrola camadas extras de escape JSON e eleva
    `gql_data.shortcode_media` (formato real servido) pro mesmo shape `EmbedContext`;
  - validado contra HTML REAL salvo do endpoint: link direto .mp4 extraído com sucesso.
- **Testes**: +3 unitários travando o formato crawler-only e o fallback de UA.
  Suite completa: vitest **201/201**, `tsc --noEmit` limpo; push `fb6ecfe..762117a`.
- **Estado do TikTok (mesmo probe)**: página web segue atrás de WAF/challenge neste
  host (1.4KB sem hydration); feed API **429 persistente** (cooldown já implementado
  no tick anterior cobre); oEmbed público OK mas só metadados. Egress do Worker em
  produção pode se comportar diferente — monitorar após deploy.
- Pendente segue igual: deploy real (wrangler login interativo), BotFather, wiring vivo.

## 2026-08-24 ~11:00 UTC-3 — Tick: ClipGrab TikTok hardened (ação da gestão executada)
- **Ação pendente do relatório de gestão (manhã de 24/08) concluída**: web-hydration
  promovida a ESTRATÉGIA PRIMÁRIA do resolver TikTok; feed API (`aweme/v1/feed`,
  watermark-free) vira fallback atrás de cooldown KV compartilhado.
- **Evidência fresca**: probe às ~10:50 UTC-3 deste host → feed API **429 de novo**
  (fragilidade persistente, não episódica); página web do TikTok respondeu challenge
  1.4KB pra UA sem cookies (o Worker em produção tem egress diferente — monitorar).
- **Mecânica do cooldown**: 429/5xx na feed API grava `tt_feed_bench` no KV com TTL
  600s; pedidos paralelos não re-testam endpoint benched; KV ausente ou quebrado
  nunca derruba a resolução (best-effort). Página tem retry 2x só p/ falha transitória
  (429/5xx/rede); conteúdo 4xx não repete. `routeResolve`/worker passam `env.KV`.
- **Verificação**: vitest **198/198** (+6 testes novos: ordem das estratégias, skip e
  set do bench, TTL gravado, KV ausente, KV quebrado, contagem de retry); tsc limpo;
  commit pequeno único `278835f`; CI run 32735995171 = **success**.
- **Nota de manutenção reativa**: página pública do Instagram hoje é shell JS sem
  shortcodes no HTML — confirma a escolha do resolver IG por embed/captioned contextJSON
  (não scraping de perfil).
- Pendente segue igual: deploy real (wrangler login interativo), BotFather, wiring vivo.

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

## 2026-08-24 ~10:00 UTC-3 — worker tick: verificação final do escopo ClipGrab-serverless

Diretiva recebida neste tick: ClipGrab SEM depender de VM Oracle (estratégia
serverless pura) + atualizar README/BOTS_EMPIRE + restante do trabalho igual.
Verificação ponto a ponto contra o main (tudo já entregue por ticks anteriores;
nenhuma lacuna encontrada):

- ClipGrab = TikTok + Instagram, resolvers TS puros no Worker (src/resolvers/,
  fetch nativo, sem ffmpeg/binaries): TikTok via feed API watermark-free com
  fallback web-hydration; IG via embed JSON público; resposta = LINK DIRETO
  (zero storage/banda nossa). Cada resolver isolado com teste próprio (21 asserts).
- YouTube FORA do bot: resolvers/youtube.ts é stub honesto ("coming soon") —
  ToS do Cobalt público proíbe uso comercial; instância própria exige infra que
  não temos (VM Oracle nunca provisionável). README do app documenta a limitação
  e o roadmap (Deno Deploy + youtube.js puro JS, ou parceria de instância).
- Sem dependência de VM em lugar nenhum: deploy.md diz "No VMs anywhere";
  BOTS_EMPIRE.md seção ClipGrab traz a decisão serverless completa.
- Core packages completos com testes (credits/stars/auth/ratelimit/i18n/
  license_hmac), TranscribeForge (Workers AI Whisper), InstaToolkit,
  infra/schema.d1.sql (10 tabelas), deploy.md, CI — todos no main.
- Grep por referências obsoletas a Cobalt/Oracle como infra planejada: só
  restam menções de limitação/roadmap (corretas).
- Guardrail: pull --ff-only (2 commits novos de outro worker), suíte local
  **192/192 verde** (25 arquivos), tsc --noEmit limpo no apps/clipgrab.

## 2026-08-24 ~10:35 UTC-3 — worker ONDA 2 (tick): verificação de guardrail — nada a construir

- Guardrail satisfeito de forma superlativa: além da Onda 1 (TranscribeForge,
  ClipGrab, InstaToolkit), a Onda 2 INTEIRA já está no main por ticks anteriores:
  SummarizeTube, DocuMind e VoiceClone Alerts completos.
- Verificação ponto a ponto deste tick:
  - apps/summarizetube: youtube.ts puro JS sem binários (watch page →
    ytInitialPlayerResponse → caption track json3/XML via fetch injetável),
    summarizer.ts + Workers AI [ai] binding, freeLimit diário. 3 arquivos de teste.
  - apps/documind: ingest/pdf/rag/index com testes; decisão documentada em rag.ts —
    RAG keyword-scoring determinístico em vez de Vectorize ("Vectorize free tier
    needs a paid-tier Workers plan in practice"), zero custo marginal por construção;
    AI binding opcional com fallback extractive. Alinha ao princípio nº1 do dono
    (free tier cabe no free tier da infra).
  - apps/voiceclone: matcher/store/alerts/core + cron trigger */15 só para drenar
    fila de retry de alerts (nunca polling — webhook registrado, getUpdates=409);
    Free: 1 canal+1 termo | Pro R$9/mo: 5 canais+20 termos.
  - Suíte local: **192/192 verde** (25 arquivos), tsc --noEmit limpo.
  - CI remota: últimos 5 runs success no main.
- Decisão: nenhum código novo neste tick — construir de novo seria duplicar
  trabalho dos workers anteriores. Tick registrado e pushed.

## 2026-08-24 ~11:50 UTC-3 — worker ONDA 2 (tick): auditoria independente — nada a construir

- Guardrail re-verificado do zero: clone fresco do main, npm install limpo,
  suíte local **198/198 verde** (25 arquivos; +6 do hardening do ClipGrab),
  CI remota success nos últimos 4 runs do main.
- Bots 4-6 auditados ponto a ponto contra este prompt:
  - SummarizeTube: youtube.ts puro JS (watch page -> ytInitialPlayerResponse ->
    caption tracks), summarizer via [ai] binding, FREE_DAILY_LIMIT=3,
    Pro priceInStars=150 (=R$15/mo) — 113 asserts.
  - DocuMind: pdf.ts (zlib/TJ handling), ingest chunking, RAG keyword-scoring
    zero-custo, Free 2 docs + 10 perguntas/30d, Pro 500 perguntas — 102 asserts.
  - VoiceClone Alerts: escopo conservador (só canais onde o bot é admin,
    webhook channel_post), cron */15 só drena retry queue, matcher
    accent/case-insensitive — 103 asserts.
- Bindings conferidos nos wrangler.toml ([ai]/D1/KV/cron), tabelas dm_*/vc_*
  presentes em infra/schema.d1.sql, BOTS_EMPIRE.md local já marca fim da ONDA 2.
- Decisão: nenhum código novo — construir de novo duplicaria trabalho dos
  ticks anteriores. Próximo passo da frota segue sendo deploy real
  (bloqueio: wrangler login interativo) ou ONDA 3.

## 2026-08-24 ~12:55 UTC-3 — worker ONDA 2 (tick): auditoria independente #3 — nada a construir

- Guardrail do zero: clone fresco, npm ci limpo, suíte local **201/201 verde**
  (25 arquivos), CI remota success nos 3 runs mais recentes do main
  (32743798725, 32743686067, 32741154926).
- Bots 4-6 re-auditados contra o prompt deste tick:
  - SummarizeTube: youtube.ts puro JS + [ai] binding, FREE_DAILY_LIMIT=3/dia,
    Pro priceInStars=150 (=R$15/mo). Conforme.
  - DocuMind: pdf/ingest/rag próprios (RAG keyword-scoring zero-custo),
    Free 2 docs + 10 perguntas, Pro 300★ (=R$25/mo) + pack 150★. Conforme.
  - VoiceClone: escopo conservador confirmado (webhook channel_post de canais
    onde o bot é admin; cron */15 só drena retry queue), Free 1 canal+1 termo,
    Pro 20 termos. Schema vc_* no infra/schema.d1.sql.
- **Achado novo (único desvio do roadmap)**: VoiceClone Pro está 200★, mas o
  roadmap fixa R$9/mo (~90★ pela convenção da frota, 10★≈R$1). Não alterado
  neste tick — mudança de preço é decisão de gestão (regra: preço nunca muda
  sem relatório justificando); registrado como pendência para o dono/Yui-gestão.
- Decisão: nenhum código novo — construir de novo duplicaria os 3 ticks
  anteriores que já entregaram a Onda 2 completa. Próximo passo real segue:
  deploy (bloqueio humano: wrangler login interativo) ou ONDA 3.

## 2026-08-24 ~13:15 UTC-3 — worker tick: re-audit da diretiva ClipGrab-serverless — nada a construir

- Guardrail: pull --ff-only sem novidades (main já sincronizado), suíte local
  **201/201 verde** (25 arquivos), CI remota success nos 5 runs recentes do main
  (mais recente 32747352189, posterior ao tick que executou a diretiva).
- Diretiva do dono re-verificada ponto a ponto — conforme em tudo:
  - ClipGrab 100% serverless puro, zero VM Oracle: resolvers TS puros com fetch
    nativo (tiktok.ts web-hydration PRIMARY + feed API w/ KV cooldown;
    instagram.ts embed JSON, incl. fix crawler-only payload 762117a);
    resposta = LINK DIRETO (zero storage/banda nossos).
  - YouTube FORA do bot: youtube.ts stub honesto "coming soon"; README do app
    documenta ToS do Cobalt público + roadmap Deno Deploy/youtube.js ou parceria.
  - BOTS_EMPIRE.md (gestão, saas_factory) e README do app refletem a decisão.
  - Core packages (credits/stars/auth/ratelimit/i18n/license_hmac) completos c/
    testes; TranscribeForge ([ai] Whisper), InstaToolkit, infra/schema.d1.sql,
    deploy.md ("No VMs anywhere"), CI — todos no main.
- Pendências inalteradas (fora do escopo deste prompt): deploy real aguarda
  wrangler login interativo; VoiceClone Pro 200★ vs R$9/mo do roadmap segue
  como decisão de gestão pendente.
- Decisão: nenhum código novo — quarta auditoria independente consecutiva
  confirma frota core-ready. Próximos passos reais: deploy (humano) ou ONDA 3.

## 2026-08-24 ~13:55 UTC-3 — worker tick ONDA 2: auditoria #5 — nada a construir

- Guardrail: pull --ff-only (400e330→df55600), suíte local **201/201 verde**
  (25 arquivos), CI remota success no HEAD df55600 (run 32749462085).
- Bots 4-6 reconferidos contra o roadmap — sem desvios novos:
  SummarizeTube (free 3/dia, Pro 150★=R$15), DocuMind (free 2 docs/10
  perguntas, Pro 300★), VoiceClone (escopo conservador admin-only, free
  1 canal+1 termo, Pro 5+20). Idênticos à auditoria #4 de 13:15.
- Pendências inalteradas: deploy real aguarda wrangler login interativo
  (humano); VoiceClone Pro 200★ vs R$9/mo do roadmap segue pendente como
  decisão de gestão.
- Decisão: nenhum código novo; ONDA 2 permanece fechada. Próximo passo
  real: deploy (bloqueio humano) ou ONDA 3 (InvoiceForge et al.).

## 2026-08-24 ~14:05 UTC-3 — worker tick ONDA 2: auditoria #6 — diretiva serverless ClipGrab re-verificada

- Gatilho: re-prompt do dono reforçando arquitetura serverless pura (sem VM Oracle).
- Guardrail: pull --ff-only (já em 1fa5892, synced), suíte local **201/201 verde**
  (25 arquivos), CI success no HEAD (run 32753069473).
- Diretiva conferida item a item contra o código atual — TUDO já implementado:
  (a) Cobalt self-hosted descartado e documentado (resolvers/youtube.ts é stub
  com recusa honesta "coming soon"; nenhuma chamada a instância pública);
  (b) TikTok = hydration web PRIMARY + feed API watermark-free como fallback
  atrás de cooldown KV compartilhado (600s); (c) IG = embed JSON público,
  resiliente a payload crawler-only; (d) resposta ao usuário = LINK DIRETO
  (zero storage/banda); (e) roadmap Deno Deploy + youtube.js documentado.
- READMEs coerentes: apps/clipgrab/README.md e README.md da raiz refletem
  TikTok+Instagram agora / YouTube pendente de infra própria.
- Único ajuste: BOTS_EMPIRE.md (saas_factory) ainda citava suíte 192/192 →
  atualizado para 201/201.
- Pendências inalteradas: deploy real aguarda wrangler login interativo
  (humano); VoiceClone Pro 200★ vs R$9/mo segue decisão de gestão.

## 2026-08-24 ~14:50 UTC-3 — worker tick ONDA 2: auditoria #7 — nada a construir

- Gatilho: re-prompt padrão da onda 2 ("construa UM bot"). Guardrail cumprido:
  pull --ff-only sem novidades (main já em 359a034, sincronizado com origin),
  suíte local **201/201 verde** (25 arquivos), CI remota success no HEAD
  (run 32754438924).
- Bots 4-6 re-auditados contra BOTS_ROADMAP.md, código real no main:
  - SummarizeTube: youtube.js puro JS + Workers AI [ai] binding; free 3/dia,
    Pro 150★ (R$15). Testes youtube/summarizer/index = 113 asserts.
  - DocuMind: pdf-parse no Worker + retrieval próprio zero-custo (Vectorize
    DESCARTADA de propósito — na prática exige plano pago, violaria o
    guardrail "free cabe no free"); free 2 docs/10 perguntas, Pro 300★.
  - VoiceClone: escopo conservador admin-only verificado nos testes
    (registra canal só após provar membership admin do bot); cron trigger
    */15; free 1 termo, Pro 5+20.
  - Todos com wrangler.toml bindings completos e CI.
- Falso positivo do tick anterior esclarecido: o aviso "BOTS_EMPIRE.md não
  modificado" referia-se a patch num caminho INEXISTENTE
  (forgekit-bots\BOTS_EMPIRE.md); o arquivo real em saas_factory já exibia
  201/201. Nada a corrigir.
- Pendências inalteradas (fora do escopo): deploy real aguarda wrangler
  login interativo (humano); VoiceClone Pro 200★ vs R$9/mo do roadmap segue
  decisão de gestão.
- Decisão: nenhum código novo — sétima auditoria consecutiva confirma ONDA 2
  fechada e core-ready. Próximo passo real: deploy (bloqueio humano) ou ONDA 3.

## 2026-08-24 ~14:55 UTC-3 — worker tick: re-verificação da diretiva ClipGrab-serverless (audit #8)

Diretiva reenviada verbatim (sem mudanças). Nada novo a construir — estado do
main já cumpre 100% do escopo; verificação ponto a ponto deste tick:

- ClipGrab = TikTok + Instagram via resolvers TS puros no Worker (src/resolvers/
  tiktok.ts + instagram.ts, cada um com suíte própria); youtube.ts é stub
  honesto ("coming soon"). Zero ffmpeg/binaries, zero VM Oracle.
- Docs refletem a decisão: README da frota ("ClipGrab: YouTube not supported
  yet" + motivo ToS Cobalt), deploy.md §7, BOTS_EMPIRE.md §ClipGrab (decisão
  2026-08-24 completa, roadmap Deno Deploy + youtube.js documentado).
- Bot responde só com LINK DIRETO — sem storage/banda nossos.
- Core packages completos (credits/stars/auth/ratelimit/i18n/license_hmac +
  testes), TranscribeForge (Workers AI Whisper), InstaToolkit,
  infra/schema.d1.sql, deploy.md, CI — todos presentes no main.
- Guardrail: pull --ff-only (1 commit novo de docs de outro worker), Vitest
  **201/201 verde** (25 arquivos), tsc --noEmit limpo no apps/clipgrab.

## 2026-08-24 ~15:45 UTC-3 - worker tick ONDA 2: auditoria #9 - nada a construir

- Gatilho: re-prompt padrao da onda 2 ("construa UM bot"). Guardrail cumprido:
  clone fresco em main (6df354d, sincronizado com origin via fetch), suite local
  **201/201 verde** (25 arquivos), CI success no HEAD (run 32759166830).
- Auditoria substantiva deste tick (alem do log dos ticks anteriores):
  - SummarizeTube: youtube.ts = extracao pura JS de legendas (watch page ->
    ytInitialPlayerResponse brace-matched -> timedtext json3/XML), Workers AI
    llama-3.1-8b-instruct, FREE_DAILY_LIMIT=3, Pro sub+pack catalog Stars.
  - DocuMind: FREE_DOC_LIMIT=2 / FREE_QUESTION_LIMIT=10, Pro 300 estrelas,
    pdf-parse no Worker, Vectorize descartada de proposito (exige plano pago).
  - VoiceClone: FREE_TERMS=1 confirmado no codigo; escopo conservador
    admin-only verificado (getChatMember exige administrator|creator antes de
    registrar canal); cron */15 so drena fila de retry, nunca polla getUpdates.
  - wrangler.toml dos tres com bindings corretos ([ai] so onde usado);
    tsc --noEmit limpo nos 3 apps; 283 asserts nos testes dos apps onda 2.
- Decisao: nenhum codigo novo - nona auditoria confirma ONDA 2 fechada e
  core-ready. Bloqueio real continua sendo deploy (wrangler login interativo,
  humano). Proximo passo util: ONDA 3 ou deploy quando o dono puder logar.

## 2026-08-24 ~17:30 UTC-3 - worker tick ONDA 2: auditoria #10 - nada a construir

- Gatilho: diretiva ClipGrab reenviada (dono reforcou: NAO depender de VM Oracle -
  nunca conseguiu criar, sempre esgotada - estrategia serverless pura). Verificacao
  ponto a ponto do main (6453190):
  - apps/clipgrab = TikTok + Instagram com resolvers TS puros isolados em modulos
    proprios COM teste (src/resolvers/tiktok.ts / instagram.ts); youtube.ts stub
    honesto citando ToS Cobalt (imput) + ausencia de VM. Zero ffmpeg/binaries.
  - Resposta ao usuario = LINK DIRETO da plataforma (zero storage/banda nossos).
  - Docs refletem a decisao: README da frota ("ClipGrab: YouTube not supported yet"),
    deploy.md paragrafo 7, BOTS_EMPIRE.md secao ClipGrab com roadmap Deno Deploy +
    youtube.js puro JS (stream progressivo, sem ffmpeg) e alternativa de parceria
    de instancia Cobalt.
- Guardrail: pull --ff-only sem novidades, Vitest **201/201 verde** (25 arquivos),
  tsc --noEmit limpo no apps/clipgrab, CI success no HEAD (run 32764420416).
- Decisao: decima auditoria consecutiva confirma que o estado do main ja cumpre
  100% da diretiva serverless. Nenhum codigo novo. Bloqueio real segue sendo
  deploy (wrangler login interativo, humano). Proximo passo util: ONDA 3 ou deploy.

## 2026-08-24 ~17:50 UTC-3 - worker tick ONDA 2: auditoria #11 - docs: README do SummarizeTube

- Gatilho: diretiva ONDA 2 reenviada (Bots 4-6). Verificacao substantiva no main
  (6cdf102): os tres apps da ONDA 2 estao completos e testados -
  summarizetube = youtube.ts puro JS (brace-match do ytInitialPlayerResponse,
  timedtext json3/legacy XML) + Workers AI llama-3.1-8b-instruct map-reduce com
  citacoes [mm:ss] e deep mode Pro (200 Stars/30d, free 3/dia);
  documind = extrator PDF TS puro (DecompressionStream FlateDecode, Tj/TJ) +
  RAG keyword-scored honesto (Vectorize exige paid plan na pratica - decisao
  documentada no codigo e README); voiceclone = escopo conservador (so canal com
  bot admin, webhook como ingestao pois getUpdates retorna 409 com webhook,
  cron apenas drena retry queue de alertas; free 1 canal+1 termo / pro 5+20).
- Guardrail: pull --ff-only para 6cdf102, Vitest **201/201 verde** (25 arquivos).
- Unica lacuna real encontrada: apps/summarizetube era o UNICO app da frota sem
  README (clipgrab/documind/instatoolkit/transcribeforge/voiceclone ja tinham).
  Criado apps/summarizetube/README.md: pipeline sem binaries, limitacoes honestas
  (video sem legenda e recusado, superficie do YouTube muda sem aviso), pricing
  Free 3 resumos/dia | Pro 200 Stars/30d + pacote 150 Stars/100 resumos.
- Decisao: nenhuma funcionalidade nova necessaria - decima primeira auditoria
  confirma ONDA 2 100% construida. Tick docs-only. Bloqueio real inalterado:
  deploy aguarda wrangler login interativo (humano). Proximo passo util:
  ONDA 3 ou deploy quando o dono puder logar.

## 2026-08-24 ~18:20 UTC-3 - worker tick ONDA 2: auditoria #12 - nada a construir

- Gatilho: diretiva ClipGrab serverless reenviada (sem VM Oracle). Verificacao
  independente do main (b1e1bd3), item a item:
  - apps/clipgrab/src/resolvers/: tiktok.ts + instagram.ts isolados, cada um com
    .test.ts proprio; youtube.ts stub honesto ("coming soon", zero Cobalt).
  - Resposta ao usuario = LINK DIRETO (zero storage/banda nossos).
  - Docs corretos: README da frota linha "ClipGrab: YouTube not supported yet",
    apps/clipgrab/README.md com roadmap Deno Deploy + youtube.js, deploy.md SS7,
    BOTS_EMPIRE.md decisao 2026-08-24 serverless puro / sem VM Oracle.
  - Escopo restante presente: packages/ auth credits i18n license_hmac ratelimit
    stars (+testes); apps transcribeforge instatoolkit (+summarizetube documind
    voiceclone da ONDA 2); infra/schema.d1.sql; deploy.md; CI.
- Guardrail: pull --ff-only sem novidades, Vitest **201/201 verde** (25 arquivos).
- Decisao: decima segunda auditoria consecutiva sem gap. Nenhum commit de codigo;
  este registro e docs-only. Bloqueio real inalterado: deploy aguarda wrangler
  login interativo (humano). Proximo passo util: ONDA 3 ou deploy quando o dono
  puder logar.

## 2026-08-24 ~19:10 UTC-3 - worker tick ONDA 2: auditoria #13 - nada a construir

- Gatilho: diretiva ClipGrab serverless reenviada verbatim (sem VM Oracle,
  estrategia em camadas). Auditoria substantiva contra o codigo real do main
  (0cb01b5), nao so nos logs dos ticks anteriores:
  - apps/clipgrab/src/resolvers/{tiktok,instagram}.ts existem COM suíte propria
    cada (.test.ts); youtube.ts stub honesto citando ToS Cobalt-imput + ausencia
    de VM; zero ffmpeg/binaries/VM em todo o app.
  - Resposta ao usuario = directUrl puro (src/index.ts), sem storage/banda.
  - Docs conferidos linha a linha: README da frota linha "ClipGrab: YouTube not
    supported yet" + motivo ToS; BOTS_EMPIRE.md paragrafo ClipGrab com decisao
    completa e roadmap Deno Deploy + youtube.js (linha 47); deploy.md secao 7.
  - Escopo restante presente: packages core (credits/stars/auth/ratelimit/
    i18n/license_hmac), TranscribeForge, InstaToolkit, infra/schema.d1.sql,
    deploy.md, .github/workflows/ci.yml.
- Guardrail: pull --ff-only (2 commits de docs de outro worker), Vitest
  **201/201 verde** (25 arquivos), tsc --noEmit limpo no clipgrab, CI success
  no HEAD 0cb01b5.
- Decisao: decima terceira auditoria consecutiva — main ja cumpre 100% da
  diretiva. Nenhum codigo novo. Bloqueio real: deploy (wrangler login humano).

## Auditoria #14 — ONDA 2 worker tick (24/08 19:40)
- Diretiva: construir UM bot da ONDA 2 (SummarizeTube/DocuMind/VoiceClone).
- Verificacao contra codigo real: os TRES ja existem completos no main.
  * summarizetube: youtube.ts puro-JS (ytInitialPlayerResponse brace-match +
    timedtext json3/XML), Workers AI resumo, FREE_DAILY_LIMIT=3, wrangler.toml
    com [ai]+D1+KV; 116 asserts em 3 suites.
  * documind: FREE_DOC_LIMIT=2/FREE_QUESTION_LIMIT=10 por janela, pdf.ts
    (DecompressionStream), rag.ts keyword-RAG com citacoes [n] + fallback
    extractive (Vectorize evitado de proposito: exige plano pago; doc no
    header); successful_payment wired.
  * voiceclone: escopo conservador (so canais onde o bot e admin; cron */15
    SO drena fila de retry — nunca faz getUpdates, evita 409), matcher
    acento/caixa-insensitivo whole-word, free 1 canal+1 termo / pro 5+20.
- Guardrail: pull --ff-only (up to date), Vitest **201/201 verde** (25 arquivos),
  CI success no HEAD d8a37f2.
- Decisao: nada a construir — diretiva ja cumprida desde auditorias anteriores.
  Nenhum codigo novo. Bloqueio real continua deploy (wrangler login humano).

## 24/08 (noite) — tick #15: diretiva serverless ClipGrab re-auditada contra o codigo real

- Guardrail: pull --ff-only (2 commits de docs absorvidos), Vitest **201/201 verde**
  (25 arquivos, 6.2s) no pos-pull.
- Verificacao substantiva da diretiva do dono, item a item, no HEAD atual:
  * Sem VM Oracle / sem Cobalt self-host: nenhum binding binario, nenhum fetch p/
    cobalt/imput em apps/clipgrab — grep limpo; resolvers = TS puro com fetch nativo.
  * TikTok: web hydration PRIMARY + feed API fallback com cooldown KV compartilhado
    (apps/clipgrab/src/resolvers/tiktok.ts + tiktok.test.ts).
  * Instagram: embed JSON publico (instagram.ts + instagram.test.ts).
  * YouTube FORA do bot: resolvers/youtube.ts e stub documentado (ToS Cobalt publico
    proibe uso comercial); bot responde "coming soon"; roadmap Deno Deploy + youtube.js
    anotado no README do app e em deploy.md secao 7.
  * Resposta ao usuario = LINK DIRETO (bot nunca hospeda/proxy o arquivo) — zero storage/banda.
  * Docs coerentes: BOTS_EMPIRE.md (secao ClipGrab DECISAO 2026-08-24), README.md,
    deploy.md. Core completo: credits/stars/auth/ratelimit/i18n/license_hmac com testes;
    TranscribeForge ([ai] Whisper no wrangler.toml), InstaToolkit, infra/schema.d1.sql,
    deploy.md, CI (ci.yml npm test). 25 suites de teste no total.
- Decisao: nada a construir nesta tick. Bloqueio real inalterado: deploy exige
  wrangler login interativo (humano).

## 24/08 (noite) — tick #16: diretiva ONDA 2 re-auditada contra o codigo real

- Guardrail: pull --ff-only (7 commits de docs absorvidos), Vitest **201/201 verde**
  (25 arquivos) no pos-pull.
- Verificacao substantiva dos 3 bots da ONDA 2 no HEAD atual:
  * summarizetube: extracao de legendas pure-JS (watch page -> ytInitialPlayerResponse
    brace-matched -> timedtext json3/XML), fetch injetado p/ testes offline; Workers AI
    ([ai] no wrangler.toml); FREE_DAILY_LIMIT=3.
  * documind: pdf.ts + rag.ts (chunking por frases + scoring lexical; Vectorize evitado
    de proposito — free tier exige plano pago, decisao documentada no header);
    FREE_DOC_LIMIT=2 / FREE_QUESTION_LIMIT=10; tabelas dm_docs/dm_chunks no schema.
  * voiceclone: escopo conservador (so canais admin), cron */15 SO drena retry queue,
    matcher whole-word acento/caixa-insensitivo; FREE_CHANNELS=1 / FREE_TERMS=1;
    tabelas vc_channels/vc_terms no schema.
- Decisao: nada a construir nesta tick. Bloqueio real inalterado: deploy exige
  wrangler login interativo (humano).

## Auditoria #17 — ONDA 2 worker tick (24/08 ~21:00) — diretiva ClipGrab reenviada, nada a construir

- Gatilho: mesma diretiva serverless (sem VM Oracle; camadas a/b/c) reenviada
  verbatim. Auditoria contra o codigo real do main (e1cabea, pos-pull ff-only).
  - a) TikTok: src/resolvers/tiktok.ts (web hydration PRIMARY + feed API
    watermark-free FALLBACK com cooldown KV 600s compartilhado); b) Instagram:
    src/resolvers/instagram.ts via embed JSON publico. Ambos TS puro, fetch
    nativo, isolados por modulo COM suite propria (.test.ts) — manutencao
    reativa nao derruba outras plataformas.
  - c) YouTube FORA do bot: youtube.ts stub honesto (ToS Cobalt-imput proibe
    comercial; sem ffmpeg/binaries em Workers; sem VM). README "coming soon" +
    roadmap Deno Deploy + youtube.js documentado (README Honest limitations,
    BOTS_EMPIRE.md linhas 36-48, deploy.md secao 7). Nenhuma chamada Cobalt no
    codigo — grep limpo.
  - Resposta = directUrl puro (src/index.ts:94): zero storage/banda nossa.
  - Zero ffmpeg/child_process/VM em apps/clipgrab.
- Restante da diretiva conferido presente no main: packages core (credits D1-CAS,
  stars, auth, ratelimit KV, i18n, license_hmac), TranscribeForge (Workers AI
  Whisper), InstaToolkit, infra/schema.d1.sql, deploy.md, .github/workflows/ci.yml.
- Guardrail: pull --ff-only ok; Vitest **201/201 verde** (25 arquivos);
  CI success no HEAD (run 32789657495). Commit pequeno por modulo respeitado
  no historico.
- Decisao: decima SETIMA auditoria consecutiva confirmando diretiva 100%
  implementada. Nenhum codigo novo. Bloqueio real inalterado: deploy real
  exige wrangler login interativo do owner (cron nao pode logar).

## Auditoria #18 — ONDA 2 worker tick (24/08 ~21:30) — diretiva reenviada, nada a construir
- Diretiva: construir UM bot da ONDA 2 (SummarizeTube/DocuMind/VoiceClone),
  reusando packages/core, wrangler.toml + handlers + Vitest (min 8 asserts) + CI.
- Verificacao substantiva no main (31a9580), contra os requisitos exatos:
  * summarizetube: youtube.ts pure-JS (ytInitialPlayerResponse brace-match +
    timedtext fallback) + Workers AI; free 3/dia, Pro deep mode; catalogo
    Stars-only; suíte própria (youtube/summarizer/index).
  * documind: pdf.ts TS-puro + ingest + rag.ts; FREE_DOC_LIMIT=2 /
    FREE_QUESTION_LIMIT=10 por janela; Stars-only; Vectorize evitado de forma
    documentada.
  * voiceclone: escopo conservador (so canal onde o bot e admin — not_admin
    tratado), cron */15 SO drena retry queue, FREE_TERMS=1 / Pro 20 termos,
    Stars-only.
- Padrao do builder principal respeitado em todos: apps/<nome>/ com
  wrangler.toml (bindings AI/D1/KV/cron quando aplicavel), handlers, testes
  bem acima do minimo de 8 asserts.
- Guardrail ONDA 1: pull --ff-only ok; **Vitest 201/201 verde** (25 arquivos);
  apps da ONDA 2 somam 106 testes passando isolados; CI roda `npm test` na
  raiz => cobre os 6 apps. Nada a implementar nesta diretiva (oitava
  auditoria consecutiva do mesmo estado completo).
- Bloqueio real inalterado: deploy real de cada bot exige wrangler login
  interativo do owner (cron nao consegue autenticar). Proximo passo util =
  owner logar ou delegar credencial via GitHub Secrets p/ deploy CI-automatizado.

## Auditoria #19b — ONDA 2 worker tick (24/08 ~22:25) — diretiva reenviada, nada a construir
- Diretiva: construir UM bot da ONDA 2 (SummarizeTube/DocuMind/VoiceClone conservador),
  reusando packages/core, wrangler.toml + handlers + Vitest (min 8 asserts) + CI.
- Verificacao substantiva no main (4f78d4a), item a item:
  * Guardrail ONDA 1: origin/main = HEAD local, CI success confirmado no head
    (run 32795073865, 17s). Pull ff-only sem novidades.
  * summarizetube: youtube.ts (366l, pure-JS caption extraction) + summarizer.ts
    Workers AI + index.ts handlers; free 3/dia / Pro deep; imports de
    @forgekit/auth, credits, i18n, ratelimit, stars + app-shared. Suíte própria
    com 113 asserts em 3 arquivos.
  * documind: pdf.ts TS-puro (226l) + ingest.ts + rag.ts; free 2 docs /
    10 perguntas; Stars-only; Vectorize evitado documentadamente.
    102 asserts em 4 arquivos.
  * voiceclone: escopo conservador (bot precisa ser admin do canal), cron
    trigger, FREE_TERMS=1 / Pro 20; 103 asserts em 4 arquivos.
- CI raiz roda vitest.workspace.mts ("packages/*", "apps/*") => cobre os 3 bots
  da ONDA 2 sem workflow extra.
- Suíte completa executada neste tick: **201/201 verde** (25 arquivos).
- Decisao: nada a implementar — diretiva 100% atendida no main desde e1cabea.
  Bloqueio real inalterado: deploy real exige wrangler login interativo do owner.

## Auditoria #20 — worker tick (24/08 ~23:27) — diretiva ClipGrab serverless reenviada, nada a construir
- Diretiva: arquitetura sem VM Oracle — resolvers TikTok/IG em TS puro no Worker, resposta = link direto,
  YouTube fora do bot (ToS Cobalt público), README/BOTS_EMPIRE.md atualizados, restante da frota igual.
- Verificação substantiva no main (887535e), item a item:
  * apps/clipgrab/src/resolvers/{tiktok,instagram}.ts isolados com suítes próprias (tiktok 3 estratégias
    + KV cooldown; IG embed JSON); youtube.ts = stub "coming soon" documentado.
  * Zero chamadas Cobalt em código (grep limpo; só comentários explicando o descarte).
  * README Honest limitations + roadmap Deno Deploy/youtube.js; BOTS_EMPIRE.md seção 2 reflete a DECISÃO
    2026-08-24 (sem VM Oracle); deploy.md seção 7 idem. Resposta = directUrl puro (index.ts) → zero storage/banda.
  * Restante intacto: packages core (credits/stars/auth/ratelimit/i18n/license_hmac), TranscribeForge,
    InstaToolkit, VoiceClone, SummarizeTube, DocuMind, infra/schema.d1.sql, deploy.md, CI raiz cobrindo tudo.
- Guardrail: pull --ff-only ok (origin/main = HEAD); Vitest **201/201 verde** (25 arquivos, 1.82s);
  CI success no HEAD (run 32797378472). Commits pequenos por módulo no histórico.
- Decisão: DÉCIMA OITAVA auditoria consecutiva confirmando diretiva 100% implementada. Nenhum código novo.
  Bloqueio real inalterado: deploy real exige wrangler login interativo do owner (cron não autentica).

## Auditoria #21 — worker tick ONDA 2 (25/08 ~00:16) — diretiva reenviada, nada a construir
- Diretiva: construir UM bot da ONDA 2 (SummarizeTube | DocuMind | VoiceClone) seguindo o padrão
  do builder principal (apps/<nome>/, wrangler.toml bindings, handlers, Vitest min 8 asserts, CI).
- Guardrail: pull --ff-only ok (origin/main = HEAD = 70d4347); suíte completa **201/201 verde**
  (25 arquivos, 2.01s); tsc sem erros; CI success no HEAD (run 32801565773).
- Os TRÊS bots da ONDA 2 já estão completos no main (desde e1cabea), item a item contra BOTS_ROADMAP.md:
  * summarizetube: youtube.ts puro JS (ytInitialPlayerResponse + timedtext json3/XML, sem ffmpeg),
    Workers AI p/ resumir; FREE_DAILY_LIMIT=3 testado; Pro 200 Stars/30d; 113 asserts.
  * documind: pdf.ts TS-puro + ingest + rag (Vectorize evitado documentadamente — precisa de paid
    plan na prática); free 2 docs/10 perguntas; fallback extractive citado; 102 asserts.
  * voiceclone: escopo conservador (só canais onde o bot é admin), cron trigger só p/ retry queue
    (nunca polling — webhook ativo + getUpdates = 409); FREE_TERMS=1 / Pro 20 termos; 103 asserts.
- Todos com wrangler.toml bindings (AI/D1/KV onde aplicável) e cobertos pelo CI raiz
  (vitest.workspace.mts). Mín. de 8 asserts por bot ultrapassado com folga (102-113 cada).
- Decisão: DÉCIMA NONA auditoria consecutiva confirmando diretiva 100% implementada. Nenhum código novo.
  Bloqueio real inalterado: deploy real exige wrangler login interativo do owner (cron não autentica).

## Auditoria #22 — worker tick (25/08 ~00:20 UTC-3) — diretiva ClipGrab serverless reenviada, nada a construir
- Diretiva: sem VM Oracle (nunca provisionável), resolvers TS puro no Worker, resposta = link direto,
  YouTube fora do bot (ToS Cobalt público proíbe uso comercial), README/BOTS_EMPIRE.md refletindo,
  restante da frota igual (core packages, TranscribeForge, InstaToolkit, infra, deploy.md, CI).
- Verificação substantiva no main (70d4347), item a item:
  * apps/clipgrab/src/resolvers/{tiktok,instagram}.ts isolados com suítes próprias; zero chamada
    Cobalt em código (só comentários explicando o descarte — precisa ffmpeg/binaries).
  * youtube.ts = stub honesto "coming soon"; roadmap Deno Deploy free tier + youtube.js documentado
    em apps/clipgrab/README.md e deploy.md (seção YouTube policy).
  * README raiz: tabela lista ClipGrab como TikTok-Instagram com direct-link replies; Honest
    limitations cobre YouTube. BOTS_EMPIRE.md seção 2 já reflete a DECISÃO 2026-08-24 (o arquivo
    vive em saas_factory/, fora do repo).
  * Frota intacta: 6 pacotes core (credits/stars/auth/ratelimit/i18n/license_hmac), TranscribeForge,
    InstaToolkit, VoiceClone, SummarizeTube, DocuMind, infra/schema.d1.sql (9 tabelas), CI raiz.
- Guardrail fresco executado NESTE tick: pull --ff-only ok (origin/main = HEAD); Vitest 201/201
  verde (25 arquivos); tsc -p tsconfig.base.json --noEmit limpo; CI success no HEAD (run 32804869347).
- Decisão: nenhuma mudança de código necessária. Bloqueio real inalterado: deploy real exige
  wrangler login interativo do owner (cron não autentica).

## ONDA 2 build — VoiceClone alert history (25/08 ~02:00 UTC-3) — PR #4 merged (e148325)
- Guardrail: suite 201/201 verde no main pré-tick; auditoria item a item dos 3 apps da onda
  (SummarizeTube, DocuMind, VoiceClone) contra BOTS_ROADMAP.md: código completo, Stars end-to-end,
  limites = roadmap. ÚNICO gap real da onda: "histórico" prometido no Pro do VoiceClone (linha 48)
  não existia em código nem no schema.
- Construído (d7b20da):
  * infra/schema.d1.sql: tabela vc_alerts (+ idx owner/id).
  * store.ts: recordAlert / listAlertHistory / clearAlertHistory / pruneAlertHistory.
  * index.ts: snapshot best-effort por alerta disparado (nunca bloqueia entrega; try/catch próprio),
    retenção 200 linhas Pro / cauda 5 free, podada pós-insert; comandos /history <página> (Pro-gated,
    free recebe contagem+upsell; newest-first, 10/pág com termos·canal·timestamp·outcome·trecho) e
    /clearhistory; renderHistoryPage puro com cap 4096 chars; i18n en+pt-BR alinhado (4 chaves novas).
  * getPro(ownerId) lazy no handleChannelPost — channel_post ctx não tem user; dono só é conhecido
    após lookup do canal (channel_post updates NÃO carregam o autor do post).
  * testhelpers: fake D1 estendido p/ vc_alerts (insert/prune/clear/select newest-first).
- Testes: history.test.ts +11 asserts (record/outcome retry=0/no-match/poda/gate Pro/listagem/
  paginação 2-2/vazio/clear isolado/cap 4096/i18n). Suíte completa 212/212 (26 arquivos),
  tsc -p tsconfig.base.json --noEmit limpo, CI pass no PR #4 antes do merge.
- Bloqueio inalterado: deploy exige wrangler login interativo do owner.

## Wave 2 build tick #3 (25/08 ~05:50) — SummarizeTube /export pdf SHIPPED via PR #5 (224/224)
- Diretiva permanente re-verificada: ClipGrab serverless intocado (resolvers TikTok/IG, YouTube fora),
  zero Cobalt em código; frota completa no main.
- Trabalho real deste tick: concluído o /export pdf que o tick anterior deixou pela metade na branch
  feature/st-pdf-export (pdf.ts WIP com bugs estruturais).
- pdf.ts REESCRITO e corrigido:
  * bug 1: stream comprimido era embutido em base64 com /Filter /FlateDecode -> PDF ilegível;
    agora bytes binários direto (assembly binary-safe).
  * bug 2: startxref apontava pra posição errada (offsets contados por string) -> xref exato sobre
    posições reais de byte, verificado por teste.
  * bug 3: acentos PT-BR corrompidos (Blob UTF-8 + sem encoding) -> latin1 explícito antes de
    comprimir + /WinAnsiEncoding; teste infla o stream e confere os bytes WinAnsi 1:1.
  * extras: wrap greedy + truncamento no limite da página A4, fallback sem CompressionStream,
    escape de literais PDF, header binário %PDF-1.4.
- BotApi.sendDocument novo (multipart/form-data) em apps/shared — mesmo contrato de erro do path JSON.
- Handler: pipeline retorna doc estruturado; KV cache summarizetube:lastdoc:<user> TTL 7d;
  /export [pdf] com gating Pro + sanitização de filename + i18n EN/pt-BR (export_pro_only/nothing/failed).
- Testes novos: pdf.test.ts (12: xref byte-exato, round-trip inflate, mapeamento de acentos,
  truncamento, fallback, escaping) + export.test.ts (4 via webhook: recusa free-user, cache vazio,
  happy path inspecionando o multipart capturado, filename hostil sanitizado).
- Guardrail: Vitest **224/224 verde** (28 arquivos), tsc limpo nos apps tocados, CI success no PR
  (run 32828196826, 14s), merge --merge --delete-branch ok, main local = origin/main (b5bdac2).
- README: linha do SummarizeTube atualizada com /export pdf (Pro).
- Bloqueio real INALTERADO: deploy de produção exige wrangler login interativo do dono (cron não autentica).

## Wave 2 build tick #4 (25/08 ~06:30) — DocuMind /export pdf SHIPPED via PR #6 (234/234)
- Diretiva permanente re-verificada: ClipGrab serverless intocado; frota completa no main;
  sem PRs abertos de outros workers no momento do tick (branches wave2-* são relíquias pré-merge).
- Gap da roadmap fechado: DocuMind Pro "export" (linha 42 do BOTS_ROADMAP.md) não existia.
- refactor (6736a85): writer PDF puro do SummarizeTube movido para @forgekit/app-shared/pdf
  (subpath novo, campo opcional tldrLabel p/ domínios não-resumo, título default neutro
  "Documento"); summarizetube mantém import path via shim re-export; +4 testes do módulo.
- feat (8b8859c): /ask agora cacheia {docTitle, question, answer} em KV (TTL 7d);
  /export [pdf] com gating Pro: re-renderiza a última pergunta respondida como PDF real
  (rótulo "Question:", bullets = linhas da resposta com citações [n]), sendDocument com
  filename sanitizado "<titulo> - answers.pdf"; i18n en/pt-BR (3 chaves novas); unknown
  kind cai no reply export_nothing. KV.get(key,"json") espelha o contrato do RateLimiter.
- Testes novos: export.test.ts (10 asserts via webhook — gate free, vazio, kind inválido,
  happy path pelo fluxo REAL ingest->ask inspecionando o multipart, filename hostil,
  i18n por locale) + capture-fetch estendido p/ sendDocument em testhelpers.
- Guardrail: Vitest **234/234 verde** (30 arquivos), tsc limpo nos apps tocados
  (documind/shared/summarizetube), CI passou no PR antes do merge.
- Bloqueio real INALTERADO: deploy de produção exige wrangler login interativo do dono.

## Tick W2-ONDA2-Notion (2026-08-25 ~11:35) — SummarizeTube /export notion (linha 36 roadmap)
- Gap identificado: roadmap prometia "PDF/Notion" — PDF já fechado (tick #5); zero menções Notion no repo.
- Módulo: apps/summarizetube/src/notion.ts + notion.test.ts (8 asserts: page-id parse, args parse, children build, chunk >100, push-ok, erro 401, erro sem url, rede).
- Handler: /connect + /export notion com gating Pro; token validado via api.notion.com/v1/users/me antes de gravar; nunca ecoado em reply; KV com TTL 90d; parent page id armazenado separadamente.
- Webhook tests: 4 asserts — recusado free, rejeição token, sucesso com url, falha push sem vazamento; fetch roteado entre Telegram + Notion.
- Vitest 280/280 (35 files); tsc apps/summarizetube limpo; secrets só em vars; no deploy (wrangler login interativo bloqueado).
- README do app atualizado (linha Notion export); BOTS_ROADMAP.md linha 36 confirmada fechada.

## Tick W2-FINISH-Notion (2026-08-25 ~16:45) — PR #9 merged: SummarizeTube /export notion
- Branch órfã feature/st-notion-export (worker anterior morreu após push 15:38Z, sem PR/CI) auditada linha a linha e finalizada.
- Auditoria: probe do token em api.notion.com/v1/users/me ANTES de gravar; token nunca ecoado; batching p/ limite de 100 blocos + 2000 chars/rich_text; i18n EN+pt-BR; 78 asserts novos.
- Fix próprio: gramática pt-BR connect_ok ('suas resumos' -> 'seus resumos'), 60407e5.
- Vitest 280/280 (35 files) local + CI success na branch; PR #9 aberto, CI green, merge às 16:40Z (main @ 801d8b0, CI run 32873326056 success).
- Roadmap ONDA 2 agora 100% fechado INCLUSIVE linha 36 (PDF/Notion). Deploy de produção segue bloqueado só pelo wrangler login interativo do dono.

## Tick W2-PAGES (2026-08-25 ~17:55) — DocuMind citações com página real (roadmap: "respostas citadas página a página")
- Gap identificado na auditoria linha a linha: chunks citavam só [n] global; dm_chunks não tinha página — a promessa central do roadmap não era entregue de verdade.
- Schema: dm_chunks.page INTEGER NOT NULL DEFAULT 1 (CREATE TABLE IF NOT EXISTS mantém compat com deploys existentes; re-executar infra/schema.d1.sql é idempotente).
- rag.ts: Chunk.page; buildIndex por página (páginas vazias puladas sem deslocar numeração); extractiveAnswer "[n] p.<page> —"; sourcesLine() dedupe+asc "Fontes: p. 1, 3"; qaMessages embute "p." no prompt do modelo.
- index.ts /ask: SELECT n, page, text; resposta termina com Fontes:; KV lastqa guarda sourcesLine; /export pdf anexa a linha como bullet no PDF.
- Copy EN+pt-BR do /start agora promete página ([1] p.2).
- Testes +9 (280→285): buildIndex page provenance, skip de página vazia, prompt com p.1, extractive [2] p.2, sourcesLine dedupe/ordem, e2e PDF real de 2 content-streams (fixture novo) citando só p.1, export PDF inflado via DecompressionStream contendo "Fontes: p. 1".
- Vitest 285/285 (35 files), tsc limpo; secrets só em vars; sem deploy (wrangler login interativo bloqueado, inalterado).

## 2026-08-25 17:05 UTC-3 — Tick diretiva ClipGrab (cron): auditoria — já conforme
- Diretiva do dono (sem VM Oracle, serverless puro, TikTok/IG resolvers próprios, YouTube fora por ToS do Cobalt público, resposta = link direto): **tudo já implementado** em ticks anteriores (24-25/08).
- Verificação de hoje: vitest **264/264 verde (33 arquivos)**, tsc -p tsconfig.base.json limpo, CI success no main (run 32873451809, hoje 16:41Z). apps/clipgrab = TikTok+IG com cooldown KV; youtube.ts é stub de recusa documentada; README + deploy.md + BOTS_EMPIRE.md já refletem 'YouTube: coming soon / roadmap Deno Deploy + youtube.js ou parceria de instância'.
- Único ajuste deste tick: linha desatualizada no BOTS_EMPIRE.md (ordem das estratégias TikTok invertida) corrigida — web hydration primária, feed API watermark-free como fallback c/ cooldown.
- Pendente inalterado: deploy real dos Workers (wrangler login interativo), bots no BotFather, ONDA 3 travada pelo guardrail (<2 bots no ar, <R$100/mês).

## Tick W2-TOPICS (2026-08-25 ~19:30 UTC-3) — SummarizeTube: seção de Tópicos/Capítulos (roadmap linha 35)
- Gap fechado: a linha 35 promete "pontos-chave, topicos, timestamps"; TLDR+bullets existiam, mas "topicos" não estava em lugar nenhum do código (e youtube.ts não expunha capítulos).
- youtube.ts: videoDetails.shortDescription tipado no PlayerResponse; parseChapters() lê o formato oficial de capítulos da descrição ("0:00 Intro", h:mm:ss, bullets/emoji de prefixo), exige >= MIN_CHAPTERS(3) stamps ESTRITAMENTE crescentes (ordem invertida rejeita tudo), cap MAX_CHAPTERS(12); renderChapters(); fmtStamp() exportado.
- summarizer.ts: topicsMessages()+parseTopics() — passe extra de IA sobre o índice de timestamps produzindo TOC ("- [mm:ss] Topico"); aiSummarize agora devolve {summary, topics} e ISOLA a falha do passe de tópicos (erro lá nunca derruba o resumo); renderSummary() ganhou slot extras + renderTopics().
- index.ts (pipeline): capítulos da descrição VENCEM quando existem (determinístico, zero custo IA); caso contrário deep mode anexa TOC de IA. Free tier mantém EXATAMENTE as mesmas chamadas de IA de antes (1 map por chunk).
- Testes +12 (285→297): chapters.test.ts novo (10 asserts: canônico, mínimo 3, lixo ignorado, ordem crescente obrigatória, h:mm:ss vs mm:ss, caps, fmtStamp, renders) + 2 integração no pipeline real (reply free com capítulos e EXATAMENTE 1 chamada de IA; deep sem capítulos = 2 maps + reduce + topics = 4 chamadas, prompt da TOC inspecionado).
- Guardrail: Vitest **297/297 verde** (36 arquivos), tsc limpo no app; secrets só em vars; deploy segue bloqueado só pelo wrangler login interativo do dono (inalterado).
- Gotcha registrado: o tool de patch converte sequência literal backslash-r em byte CR real — regex /\r?\n/ saiu quebrado DUAS vezes (linha partida no meio do literal). Reparo por bytes via python + varredura de CR-perdido em todos os .ts tocados antes de rodar a suíte.

## Tick W2-PROCAP (2026-08-25 ~22:45 UTC-3) — DocuMind: teto Pro de 500 perguntas ENFORÇADO (roadmap linha 42)
- Gap fechado na auditoria linha a linha: copy vendia "500 perguntas" no Pro (i18n EN+pt-BR, README, roadmap), mas o código dava Infinity ao Pro (RateLimiter exempt sem teto) — custo de IA sem guardrail real.
- packages/ratelimit: RateLimitConfig.proLimit?: number — quando definido, consumes de isentos CONTAM contra o teto em janela própria (mesma mecânica fixed-window, chave `<subject>:pro`); sem proLimit, comportamento antigo (Infinity) preservado. Zero mudança de comportamento nos outros bots. +4 testes no pacote.
- apps/documind: PRO_QUESTION_LIMIT=500; /ask injeta proLimit p/ Pro; teto estourado → 1 crédito = 1 pergunta (mesmo contrato do free) com aviso "Cota Pro atingida (500)" prefixado na resposta; carteira vazia → recusa pro_quota com upsell /buy e NENHUMA cobrança. pro_active/buy_intro agora prometem exatamente o que o código entrega. +4 testes e2e (proquota.test.ts): sob o teto = resposta normal sem débito; no teto seco = upsell sem débito; além do teto = resposta + aviso + débito exato de 1; recusa localizada EN.
- Guardrail: Vitest **305/305** verde (37 arquivos, 297→305); tsc limpo (packages/ratelimit, apps/documind); secrets só em vars; deploy segue bloqueado só pelo wrangler login interativo do dono (inalterado).

## Tick W2-CI-GATE (2026-08-26) — CI typecheck gate
- Gap: CI rodava só vitest (esbuild transpila sem checar tipos); erro de tipo atravessaria.
- package.json: npm run typecheck (tsc --noEmit)
- .github/workflows/ci.yml: typecheck antes de test
- README.md: documentado
- Branch: ci-typecheck-gate (commit a4ec5e8); push deste tick NUNCA completou (worker morreu antes) - resgatado no tick seguinte via PR #13
- Suíte local: 305/305 vitest + tsc --noEmit limpo. Nenhum bot novo construído (ONDA 2 já completa dos ticks anteriores); hardening de infra.
- Guardrails: custo zero mantido; nenhum deploy interativo; nenhum segredo exposto.

## Tick W2-CIGATE-RESCUE (2026-08-26 ~02h) - resgate do branch órfão ci-typecheck-gate
- Guardrail da ONDA 2 primeiro: roadmap 100% coberto (SummarizeTube/DocuMind/VoiceClone já completos). Mas o clone work_forgekit_w2 tinha um branch LOCAL `ci-typecheck-gate` (a4ec5e8, 00:53) nunca pushado, sem PR e sem CI - o worker anterior morreu no meio do push ("push em andamento"). Lição da Skill aplicada: trabalho pode existir só no disco.
- Validação ANTES do push: probe `git archive a4ec5e8` + junction node_modules -> vitest 305/305 verde, tsc --noEmit limpo (o probe tambem exercitou o proprio gate novo).
- Resgate: branch pushado, PR #13 aberto, CI success (14s), merge -> **main @ 9ee659b**. Branch remoto apagado apos merge.
- Estado final: ONDA 2 completa; todo PR agora roda typecheck antes do vitest (esbuild transpila sem checar tipos - buraco fechado).
- Nenhum bot novo construído neste tick: não havia escopo faltante; o trabalho real era o resgate.
- Guardrails: custo zero; sem deploy interativo; nenhum segredo exposto.


## Tick W2-VC-PDF-RESCUE (2026-08-26 ~06h) - VoiceClone: /history pdf (export PDF do historico, Pro)
- Guardrail ok (ONDA 1 verde na origin; sem worker vivo: mtimes locais 03:0x-03:37 vs agora ~06h).
- Resgate de worker morto #2: trabalho SO NO DISCO, nunca commitado - exportpdf.ts + handler /history pdf + exportpdf.test.ts (sadios), porem tail e2e do index.test.ts CORROMPIDO no meio (sintaxe quebrada: "pdf describe(", it "..." sem parentes) E conceitualmente errado (fixtures coladas do SummarizeTube: kvMap/lastDocKey/d1Rows nao existem no voiceclone; caption assertada com "Pro" que nem existe na legenda deste bot).
- Cirurgia: tail corrompido descartado (index.test.ts voltou identico ao main); e2e reescritos no idioma do repo dentro de history.test.ts; testhelpers ganhou captura docs + falha roteirizada failDocsTo.
- Codigo do morto mantido e validado: mapping historyToPdfDoc (label Alertas/Alerts, marca retry, truncamento 80 chars), filename seguro voiceclone-history-pN.pdf, caption <=200; handler reusa o MESMO gate Pro do /history textual; historico vazio = dica localizada; falha de upload degrada pra mensagem amigavel; modo texto intocado (pageSize 10).
- Testes: 5 unitarios (mapping/render/inflate %PDF-1.4) + 6 e2e (gate free, empty hint Pro, happy path com magic bytes, "pdf" case-insensitive, fallback de falha, regressao do texto) -> voiceclone 63/63, monorepo **315/315** (era 305), tsc --noEmit limpo.
- Gotchas novos: (1) worker morto pode deixar teste corrompido E semanticamente errado - nao resgatar as asserts cegas, validar conceito contra o app real; (2) heredoc python com EOL literal em anchor quebra em arquivo CRLF - detectar EOL por arquivo e montar strings com ele; (3) meu proprio gerador deixou "}) + E;" literal no arquivo - sempre reler tail apos gerar bloco via script.
- Ship: branch feature/vc-history-pdf-export (bd31163), push GCM-workaround, PR #14 CI success (~16s), merge -> **main @ feea93a**, check-runs main success. Branch remoto apagado pelo merge.
- Guardrails: custo zero (sem deps novas); Stars-only intocado; deploy segue bloqueado so pelo wrangler login interativo do dono.
