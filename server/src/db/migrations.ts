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
];
