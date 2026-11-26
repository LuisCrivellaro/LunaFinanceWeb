/**
 * Migrações versionadas. Cada migração roda uma única vez, dentro de uma
 * transação, e fica registrada em `schema_migrations`. Nunca edite uma
 * migração já aplicada em produção — crie uma nova.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
  /** SQL de reversão (npm run db:rollback). Perde apenas o que a migração criou. */
  down?: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: /* sql */ `
CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  password_hash   TEXT,
  -- Papel interno. NUNCA é enviado ao frontend como texto/badge.
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  -- O que a pessoa pode ver dos demais: nada, só totais, ou tudo.
  family_access   TEXT NOT NULL DEFAULT 'full' CHECK (family_access IN ('none','summary','full')),
  color           TEXT NOT NULL DEFAULT '#2a78d6',
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins   INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  notify_due_days INT NOT NULL DEFAULT 3 CHECK (notify_due_days BETWEEN 0 AND 15),
  notify_overdue  BOOLEAN NOT NULL DEFAULT TRUE,
  notify_daily    BOOLEAN NOT NULL DEFAULT FALSE,
  notify_weekly   BOOLEAN NOT NULL DEFAULT TRUE,
  notify_goals    BOOLEAN NOT NULL DEFAULT TRUE,
  notify_anomaly  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,           -- SHA-256 do token (o token em si só existe no cookie)
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Links de definição/redefinição de senha (uso único, com validade).
CREATE TABLE auth_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('setup','reset')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id                    SERIAL PRIMARY KEY,
  owner_id              INT NOT NULL REFERENCES users(id),
  name                  TEXT NOT NULL,
  type                  TEXT NOT NULL DEFAULT 'checking'
                        CHECK (type IN ('checking','savings','cash','investment','wallet','other')),
  initial_balance_cents BIGINT NOT NULL DEFAULT 0,
  is_default            BOOLEAN NOT NULL DEFAULT FALSE,
  archived              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX accounts_owner_idx ON accounts (owner_id);
CREATE UNIQUE INDEX accounts_one_default_uq ON accounts (owner_id) WHERE is_default AND NOT archived;

CREATE TABLE categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('income','expense')),
  icon        TEXT NOT NULL DEFAULT 'tag',
  color       TEXT NOT NULL DEFAULT '#8A8F98',
  keywords    TEXT NOT NULL DEFAULT '',   -- palavras para o bot classificar ("mercado, supermercado")
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  INT REFERENCES users(id),
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_uq ON categories (lower(name), kind) WHERE NOT archived;

CREATE TABLE recurrences (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id),
  account_id    INT NOT NULL REFERENCES accounts(id),
  category_id   INT REFERENCES categories(id),
  kind          TEXT NOT NULL CHECK (kind IN ('income','expense')),
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  description   TEXT NOT NULL,
  nature        TEXT NOT NULL DEFAULT 'fixed' CHECK (nature IN ('fixed','variable')),
  day_of_month  INT NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  start_date    DATE NOT NULL,
  end_date      DATE,
  auto_paid     BOOLEAN NOT NULL DEFAULT FALSE,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    INT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id                 SERIAL PRIMARY KEY,
  user_id            INT NOT NULL REFERENCES users(id),     -- responsável
  account_id         INT NOT NULL REFERENCES accounts(id),
  category_id        INT REFERENCES categories(id),
  kind               TEXT NOT NULL CHECK (kind IN ('income','expense')),
  amount_cents       BIGINT NOT NULL CHECK (amount_cents > 0),
  description        TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 160),
  -- data de competência: quando pago = data do pagamento; quando pendente = vencimento
  date               DATE NOT NULL,
  status             TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','pending')),
  paid_at            DATE,
  nature             TEXT NOT NULL DEFAULT 'variable' CHECK (nature IN ('fixed','variable')),
  notes              TEXT,
  recurrence_id      INT REFERENCES recurrences(id) ON DELETE SET NULL,
  installment_group  TEXT,
  installment_number INT,
  installment_total  INT,
  source             TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','telegram','recurrence','import')),
  created_by         INT NOT NULL REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CHECK ((installment_group IS NULL) = (installment_number IS NULL)),
  CHECK (status = 'pending' OR paid_at IS NOT NULL)
);
CREATE INDEX tx_user_date_idx ON transactions (user_id, date) WHERE deleted_at IS NULL;
CREATE INDEX tx_status_date_idx ON transactions (status, date) WHERE deleted_at IS NULL;
CREATE INDEX tx_account_idx ON transactions (account_id) WHERE deleted_at IS NULL;
-- Impede que a mesma recorrência gere duas ocorrências na mesma data.
CREATE UNIQUE INDEX tx_recurrence_date_uq ON transactions (recurrence_id, date) WHERE recurrence_id IS NOT NULL;

CREATE TABLE goals (
  id            SERIAL PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('individual','family')),
  owner_id      INT NOT NULL REFERENCES users(id),   -- quem criou / dono da meta individual
  name          TEXT NOT NULL,
  target_cents  BIGINT NOT NULL CHECK (target_cents > 0),
  deadline      DATE,
  color         TEXT NOT NULL DEFAULT '#5B6CFF',
  icon          TEXT NOT NULL DEFAULT 'target',
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  achieved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE goal_contributions (
  id            SERIAL PRIMARY KEY,
  goal_id       INT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  user_id       INT NOT NULL REFERENCES users(id),
  amount_cents  BIGINT NOT NULL CHECK (amount_cents <> 0),  -- negativo = retirada
  date          DATE NOT NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX goal_contrib_goal_idx ON goal_contributions (goal_id);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id),
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  source      TEXT NOT NULL DEFAULT 'web',
  ip          TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_log (created_at DESC);

-- ===== Telegram =====
CREATE TABLE telegram_links (
  user_id           INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id  BIGINT NOT NULL UNIQUE,
  chat_id           BIGINT NOT NULL,
  username          TEXT,
  first_name        TEXT,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE telegram_link_codes (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotência: o Telegram reenvia updates se não respondermos 200 a tempo.
CREATE TABLE telegram_updates (
  update_id    BIGINT PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tentativas de vinculação (contra força bruta do código).
CREATE TABLE telegram_link_attempts (
  id                SERIAL PRIMARY KEY,
  telegram_user_id  BIGINT NOT NULL,
  success           BOOLEAN NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tg_attempts_idx ON telegram_link_attempts (telegram_user_id, created_at);

-- Operações aguardando confirmação do usuário no bot.
CREATE TABLE telegram_pending_actions (
  id          TEXT PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     BIGINT NOT NULL,
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','expired')),
  result_id   INT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Evita notificar a mesma coisa duas vezes.
CREATE TABLE notification_log (
  id        BIGSERIAL PRIMARY KEY,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  ref_key   TEXT NOT NULL,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, ref_key)
);
`,
  },
  {
    id: 2,
    name: "telegram_assistant",
    // Somente ADIÇÕES (colunas anuláveis/com default e tabelas novas): não altera
    // nem apaga dados existentes. Reversão em `down`.
    sql: /* sql */ `
ALTER TABLE transactions ADD COLUMN payment_method TEXT
  CHECK (payment_method IN ('pix','credit_card','debit_card','cash','boleto','transfer','other'));

-- Controle de processamento dos updates (permite retentativa após falha)
ALTER TABLE telegram_updates ADD COLUMN status TEXT NOT NULL DEFAULT 'done'
  CHECK (status IN ('processing','done','failed'));
ALTER TABLE telegram_updates ADD COLUMN attempts INT NOT NULL DEFAULT 1;

-- Tipo da ação pendente (lançamento, meta, contribuição)
ALTER TABLE telegram_pending_actions ADD COLUMN kind TEXT NOT NULL DEFAULT 'transaction'
  CHECK (kind IN ('transaction','goal','contribution'));
ALTER TABLE telegram_pending_actions ADD COLUMN version INT NOT NULL DEFAULT 1;
CREATE INDEX tg_pending_user_idx ON telegram_pending_actions (user_id, status);

-- Estado da conversa (ex.: aguardando o valor, editando a descrição)
-- Palavras-chave extras nas categorias padrão (só acrescenta; não apaga nada)
UPDATE categories SET keywords = keywords || ', trabalho, job'
 WHERE is_default AND name = 'Freelance' AND keywords NOT LIKE '%trabalho%';
UPDATE categories SET keywords = keywords || ', camiseta, camisa, calça, tênis, tenis, sapato, blusa, vestido'
 WHERE is_default AND name = 'Compras' AND keywords NOT LIKE '%camiseta%';

CREATE TABLE telegram_conversations (
  user_id     INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
    down: /* sql */ `
DROP TABLE IF EXISTS telegram_conversations;
DROP INDEX IF EXISTS tg_pending_user_idx;
ALTER TABLE telegram_pending_actions DROP COLUMN IF EXISTS version;
ALTER TABLE telegram_pending_actions DROP COLUMN IF EXISTS kind;
ALTER TABLE telegram_updates DROP COLUMN IF EXISTS attempts;
ALTER TABLE telegram_updates DROP COLUMN IF EXISTS status;
ALTER TABLE transactions DROP COLUMN IF EXISTS payment_method;
`,
  },
  {
    id: 3,
    name: "transfers_and_bot_context",
    // Somente adições. Transferências entre contas da MESMA pessoa: mexem no saldo
    // de cada conta, mas não contam como receita nem despesa.
    sql: /* sql */ `
CREATE TABLE transfers (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL REFERENCES users(id),
  from_account_id  INT NOT NULL REFERENCES accounts(id),
  to_account_id    INT NOT NULL REFERENCES accounts(id),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  date             DATE NOT NULL,
  description      TEXT,
  source           TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','telegram')),
  created_by       INT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CHECK (from_account_id <> to_account_id)
);
CREATE INDEX transfers_user_idx ON transfers (user_id, date) WHERE deleted_at IS NULL;
CREATE INDEX transfers_from_idx ON transfers (from_account_id) WHERE deleted_at IS NULL;
CREATE INDEX transfers_to_idx ON transfers (to_account_id) WHERE deleted_at IS NULL;

-- novos tipos de rascunho do bot (transferência, edição e exclusão)
ALTER TABLE telegram_pending_actions DROP CONSTRAINT telegram_pending_actions_kind_check;
ALTER TABLE telegram_pending_actions ADD CONSTRAINT telegram_pending_actions_kind_check
  CHECK (kind IN ('transaction','goal','contribution','transfer','tx_update','tx_delete'));

-- contexto da última consulta (permite "e no mês passado?")
CREATE TABLE telegram_context (
  user_id     INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_query  JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
    down: /* sql */ `
DROP TABLE IF EXISTS telegram_context;
DELETE FROM telegram_pending_actions WHERE kind IN ('transfer','tx_update','tx_delete');
ALTER TABLE telegram_pending_actions DROP CONSTRAINT telegram_pending_actions_kind_check;
ALTER TABLE telegram_pending_actions ADD CONSTRAINT telegram_pending_actions_kind_check
  CHECK (kind IN ('transaction','goal','contribution'));
DROP TABLE IF EXISTS transfers;
`,
  },
  {
    id: 4,
    name: "card_last4",
    // Final (4 dígitos) do cartão de crédito de cada pessoa, para identificar o
    // cartão no painel. Só o final — o número completo nunca é guardado.
    sql: /* sql */ `
ALTER TABLE users ADD COLUMN card_last4 TEXT CHECK (card_last4 ~ '^[0-9]{4}$');
`,
    down: /* sql */ `
ALTER TABLE users DROP COLUMN IF EXISTS card_last4;
`,
  },
  {
    id: 5,
    name: "openbot_whatsapp",
    // Integração externa (OpenBot + WhatsApp), cartões/fatura e orçamentos.
    // Somente adições: nada existente é removido ou reescrito.
    sql: /* sql */ `
-- origem "whatsapp" e identificador externo da mensagem
ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('web','telegram','recurrence','import','whatsapp'));
ALTER TABLE transactions ADD COLUMN external_ref TEXT;
ALTER TABLE transfers DROP CONSTRAINT transfers_source_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_source_check CHECK (source IN ('web','telegram','whatsapp'));

-- rascunhos: o mesmo mecanismo do Telegram, separado por canal
ALTER TABLE telegram_pending_actions ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram'
  CHECK (channel IN ('telegram','whatsapp'));
ALTER TABLE telegram_pending_actions ADD COLUMN external_ref TEXT;
CREATE UNIQUE INDEX pending_external_ref_uq ON telegram_pending_actions (channel, user_id, external_ref) WHERE external_ref IS NOT NULL;
ALTER TABLE telegram_pending_actions DROP CONSTRAINT telegram_pending_actions_kind_check;
ALTER TABLE telegram_pending_actions ADD CONSTRAINT telegram_pending_actions_kind_check
  CHECK (kind IN ('transaction','goal','contribution','transfer','tx_update','tx_delete','invoice_payment'));

-- configuração da integração (uma linha por provedor)
CREATE TABLE integration_settings (
  provider       TEXT PRIMARY KEY CHECK (provider IN ('openbot')),
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  auto_confirm   BOOLEAN NOT NULL DEFAULT FALSE,
  pin_required   BOOLEAN NOT NULL DEFAULT TRUE,
  session_hours  INT NOT NULL DEFAULT 12 CHECK (session_hours BETWEEN 1 AND 72),
  updated_by     INT REFERENCES users(id),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO integration_settings (provider) VALUES ('openbot');

-- credenciais revogáveis (só o hash é guardado)
CREATE TABLE integration_credentials (
  id            SERIAL PRIMARY KEY,
  provider      TEXT NOT NULL DEFAULT 'openbot' CHECK (provider IN ('openbot')),
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  scopes        TEXT[] NOT NULL,
  created_by    INT NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    INT REFERENCES users(id)
);

-- WhatsApp de cada pessoa (E.164) e códigos de vinculação de uso único
CREATE TABLE whatsapp_links (
  user_id       INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone_e164    TEXT NOT NULL UNIQUE CHECK (phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  linked_via    TEXT NOT NULL CHECK (linked_via IN ('code','admin')),
  linked_by     INT REFERENCES users(id),
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);
CREATE TABLE whatsapp_link_codes (
  code_hash    TEXT PRIMARY KEY,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_e164   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_link_codes_user_idx ON whatsapp_link_codes (user_id);

-- PIN pessoal para abrir sessões no canal (hash scrypt, igual às senhas)
ALTER TABLE users ADD COLUMN channel_pin_hash TEXT;
ALTER TABLE users ADD COLUMN channel_pin_failed INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN channel_pin_locked_until TIMESTAMPTZ;

-- sessões curtas por pessoa (o token fica com o OpenBot; aqui só o hash)
CREATE TABLE integration_sessions (
  id             TEXT PRIMARY KEY,
  user_id        INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id  INT NOT NULL REFERENCES integration_credentials(id),
  phone_e164     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);
CREATE INDEX integration_sessions_user_idx ON integration_sessions (user_id);

-- idempotência: a mesma chave devolve a mesma resposta
CREATE TABLE integration_requests (
  credential_id  INT NOT NULL REFERENCES integration_credentials(id),
  idem_key       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','done')),
  status         INT,
  response       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (credential_id, idem_key)
);

-- histórico de operações (sem valores, textos ou telefones)
CREATE TABLE integration_events (
  id             BIGSERIAL PRIMARY KEY,
  credential_id  INT REFERENCES integration_credentials(id),
  user_id        INT REFERENCES users(id) ON DELETE SET NULL,
  operation      TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','error','denied')),
  status         INT,
  error_code     TEXT,
  duration_ms    INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX integration_events_created_idx ON integration_events (created_at DESC);

-- fila persistente de avisos para o canal (a entrega fica com o OpenBot)
CREATE TABLE notification_queue (
  id            BIGSERIAL PRIMARY KEY,
  channel       TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  dedup_key     TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','delivered','failed','cancelled')),
  attempts      INT NOT NULL DEFAULT 0,
  claim_token   TEXT,
  claimed_at    TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (channel, user_id, kind, dedup_key)
);
CREATE INDEX notification_queue_status_idx ON notification_queue (status, created_at);

-- orçamentos mensais (pessoa ou família; geral ou por categoria)
CREATE TABLE budgets (
  id            SERIAL PRIMARY KEY,
  scope         TEXT NOT NULL CHECK (scope IN ('individual','family')),
  owner_id      INT REFERENCES users(id),
  category_id   INT REFERENCES categories(id),
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  created_by    INT NOT NULL REFERENCES users(id),
  archived      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'individual') = (owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX budgets_uq ON budgets (scope, COALESCE(owner_id, 0), COALESCE(category_id, 0)) WHERE NOT archived;

-- cartões da família: fatura única (titular, fechamento, vencimento, limite compartilhado)
CREATE TABLE card_settings (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  product_name    TEXT NOT NULL DEFAULT 'Itaú Personnalité LATAM Pass Visa Infinite',
  holder_user_id  INT REFERENCES users(id),
  closing_day     INT CHECK (closing_day BETWEEN 1 AND 28),
  due_day         INT CHECK (due_day BETWEEN 1 AND 28),
  limit_cents     BIGINT CHECK (limit_cents > 0),
  updated_by      INT REFERENCES users(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO card_settings (id) VALUES (1);

-- pagamento da fatura: só marca a fatura como paga; NÃO é uma despesa nova
CREATE TABLE card_invoice_payments (
  id             SERIAL PRIMARY KEY,
  invoice_month  TEXT NOT NULL UNIQUE CHECK (invoice_month ~ '^[0-9]{4}-[0-9]{2}$'),
  amount_cents   BIGINT NOT NULL CHECK (amount_cents > 0),
  paid_at        DATE NOT NULL,
  paid_by        INT NOT NULL REFERENCES users(id),
  source         TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','whatsapp')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
    down: /* sql */ `
DROP TABLE IF EXISTS card_invoice_payments;
DROP TABLE IF EXISTS card_settings;
DROP TABLE IF EXISTS budgets;
DROP TABLE IF EXISTS notification_queue;
DROP TABLE IF EXISTS integration_events;
DROP TABLE IF EXISTS integration_requests;
DROP TABLE IF EXISTS integration_sessions;
ALTER TABLE users DROP COLUMN IF EXISTS channel_pin_locked_until;
ALTER TABLE users DROP COLUMN IF EXISTS channel_pin_failed;
ALTER TABLE users DROP COLUMN IF EXISTS channel_pin_hash;
DROP TABLE IF EXISTS whatsapp_link_codes;
DROP TABLE IF EXISTS whatsapp_links;
DROP TABLE IF EXISTS integration_credentials;
DROP TABLE IF EXISTS integration_settings;
DELETE FROM telegram_pending_actions WHERE channel <> 'telegram' OR kind = 'invoice_payment';
ALTER TABLE telegram_pending_actions DROP CONSTRAINT telegram_pending_actions_kind_check;
ALTER TABLE telegram_pending_actions ADD CONSTRAINT telegram_pending_actions_kind_check
  CHECK (kind IN ('transaction','goal','contribution','transfer','tx_update','tx_delete'));
DROP INDEX IF EXISTS pending_external_ref_uq;
ALTER TABLE telegram_pending_actions DROP COLUMN IF EXISTS external_ref;
ALTER TABLE telegram_pending_actions DROP COLUMN IF EXISTS channel;
UPDATE transfers SET source = 'web' WHERE source = 'whatsapp';
ALTER TABLE transfers DROP CONSTRAINT transfers_source_check;
ALTER TABLE transfers ADD CONSTRAINT transfers_source_check CHECK (source IN ('web','telegram'));
ALTER TABLE transactions DROP COLUMN IF EXISTS external_ref;
UPDATE transactions SET source = 'web' WHERE source = 'whatsapp';
ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('web','telegram','recurrence','import'));
`,
  },
];
