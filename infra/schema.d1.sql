-- ForgeKit Bots — shared D1 schema (free tier: 5GB, more than enough)
-- Apply once per account:  npx wrangler d1 execute forgekit --file infra/schema.d1.sql

-- Core user registry (one row per Telegram user across all bots).
CREATE TABLE IF NOT EXISTS users (
  tg_user_id INTEGER PRIMARY KEY,
  balance    INTEGER NOT NULL DEFAULT 0,        -- cached credit balance (ledger is source of truth)
  created_at TEXT NOT NULL
);

-- Append-only credits ledger. Balance changes ALWAYS write an event here.
CREATE TABLE IF NOT EXISTS credit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(tg_user_id),
  kind       TEXT NOT NULL CHECK (kind IN ('grant', 'spend')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  reason     TEXT NOT NULL,                     -- e.g. stars:pack:r10:<charge_id>
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_credit_events_user ON credit_events(user_id, created_at);

-- Stars payments: PK on charge_id makes fulfillment idempotent.
CREATE TABLE IF NOT EXISTS star_payments (
  charge_id   TEXT PRIMARY KEY,                 -- telegram_payment_charge_id
  tg_user_id  INTEGER NOT NULL,
  product_id  TEXT NOT NULL,
  stars_amount INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

-- Pro subscriptions (per bot). pro_until = ISO timestamp; stacking extends it.
CREATE TABLE IF NOT EXISTS subscriptions (
  tg_user_id INTEGER PRIMARY KEY,
  product_id TEXT NOT NULL DEFAULT '',
  pro_until  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Generic per-bot usage log for the monthly report cron.
CREATE TABLE IF NOT EXISTS usage_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot        TEXT NOT NULL,                     -- clipgrab | transcribeforge | instatoolkit
  tg_user_id INTEGER NOT NULL,
  action     TEXT NOT NULL,                     -- link | transcribe | profile | tags | ...
  detail     TEXT NOT NULL DEFAULT '',          -- platform / seconds / handle etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_bot_time ON usage_log(bot, created_at);

-- DocuMind: document library (one row per indexed upload).
CREATE TABLE IF NOT EXISTS dm_docs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id INTEGER NOT NULL,
  title      TEXT NOT NULL,
  n_pages    INTEGER NOT NULL DEFAULT 0,        -- content-stream units (approximate pagination)
  n_chunks   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_docs_user ON dm_docs(tg_user_id, created_at);

-- DocuMind: numbered passage index; `n` is the citation id shown to users ([n]).
CREATE TABLE IF NOT EXISTS dm_chunks (
  doc_id INTEGER NOT NULL REFERENCES dm_docs(id) ON DELETE CASCADE,
  n      INTEGER NOT NULL,
  text   TEXT NOT NULL,
  PRIMARY KEY (doc_id, n)
);

-- VoiceClone Alerts: channels where the bot is admin, one row per watch target.
-- chat_id = Telegram chat id (-100...); owner_id = tg_user_id who registered it.
-- title = chat title AT REGISTRATION TIME — display only; the live id is chat_id.
-- Ownership proof happens at /addchannel time via getChatMember(bot). After
-- registration the bot keeps receiving channel_post updates until removed.
CREATE TABLE IF NOT EXISTS vc_channels (
  chat_id   INTEGER PRIMARY KEY,
  owner_id  INTEGER NOT NULL REFERENCES users(tg_user_id),
  title     TEXT NOT NULL DEFAULT '',
  added_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vc_channels_owner ON vc_channels(owner_id);

-- VoiceClone Alerts: watch keywords per channel. Matching is lexical and
-- accent/case-insensitive (apps/voiceclone/src/matcher.ts).
CREATE TABLE IF NOT EXISTS vc_terms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL REFERENCES vc_channels(chat_id) ON DELETE CASCADE,
  term       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (chat_id, term)
);
CREATE INDEX IF NOT EXISTS idx_vc_terms_chat ON vc_terms(chat_id);
