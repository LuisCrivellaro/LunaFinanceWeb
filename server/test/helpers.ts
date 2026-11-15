import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createLogger, type AppContext } from "../src/context.js";
import { createDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { setNow } from "../src/lib/clock.js";
import { hashPassword } from "../src/lib/crypto.js";
import type { SendOptions, TelegramApi } from "../src/telegram/api.js";
import type { Assistant } from "../src/telegram/assistant.js";

export const PASSWORD = "SenhaForte123";
export const WEBHOOK_SECRET = "test-webhook-secret-0123456789abcdef";

export interface SentMessage {
  method: string;
  chatId?: number;
  text?: string;
  opts?: SendOptions;
}

/**
 * Telegram falso: grava tudo que o bot "enviou" e permite simular falhas da
 * API (`failNext("sendMessage", erro)` faz a próxima chamada desse método falhar).
 */
export function fakeTelegram() {
  const sent: SentMessage[] = [];
  const failures: Array<{ method: string; error: Error }> = [];
  let nextId = 100;
  const maybeFail = (method: string) => {
    const i = failures.findIndex((f) => f.method === method);
    if (i >= 0) throw failures.splice(i, 1)[0].error;
  };
  const api: TelegramApi = {
    async sendMessage(chatId, text, opts) {
      maybeFail("sendMessage");
      sent.push({ method: "sendMessage", chatId, text, opts });
      return { message_id: nextId++ };
    },
    async editMessageText(chatId, _messageId, text, opts) {
      maybeFail("editMessageText");
      sent.push({ method: "editMessageText", chatId, text, opts });
    },
    async answerCallbackQuery(_id, text) {
      maybeFail("answerCallbackQuery");
      sent.push({ method: "answerCallbackQuery", text });
    },
    async call(method) {
      maybeFail(method);
      sent.push({ method });
      return {} as never;
    },
  };
  return {
    api,
    sent,
    last: () => sent[sent.length - 1],
    clear: () => sent.splice(0),
    failNext: (method: string, error: Error) => failures.push({ method, error }),
  };
}

export const FAMILY = [
  { key: "luciana", name: "Luciana", email: "luciana@familia.test", role: "member" },
  { key: "luis", name: "Luís Carlos", email: "luis@familia.test", role: "member" },
  { key: "lipe", name: "Lipe", email: "lipe@familia.test", role: "admin" },
  { key: "joao", name: "João", email: "joao@familia.test", role: "member" },
] as const;

export type FamilyKey = (typeof FAMILY)[number]["key"];

export async function setupTestApp(opts: { now?: string; ai?: Assistant | null } = {}) {
  setNow(opts.now ?? "2026-11-14T15:00:00Z"); // 12h em São Paulo
  const config = {
    ...loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    databaseUrl: "pglite://memory",
    appUrl: "https://luna.test",
    telegram: { botToken: "test", botUsername: "LunaFinanceTestBot", webhookSecret: WEBHOOK_SECRET, webhookUrl: "https://luna.test/telegram/webhook", enabled: true, webhookGuard: false },
    cronSecret: "cron-secret-0123456789abcdef0123456789",
    schedulerEnabled: false,
    loginRateMax: 10000,
  };
  const db = await createDb(config.databaseUrl);
  await migrate(db, () => {});
  const tg = fakeTelegram();
  const ctx: AppContext = { db, config, log: createLogger(!process.env.LUNA_TEST_LOG), telegram: tg.api, ai: opts.ai ?? null };
  const app = createApp(ctx);

  const hash = await hashPassword(PASSWORD);
  const ids = {} as Record<FamilyKey, number>;
  for (const m of FAMILY) {
    const { rows } = await db.query<{ id: number }>(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id",
      [m.name, m.email, hash, m.role],
    );
    ids[m.key] = rows[0].id;
    await db.query("INSERT INTO accounts (owner_id, name, is_default) VALUES ($1, 'Conta principal', TRUE)", [rows[0].id]);
  }

  /** Agente HTTP já logado como um integrante. */
  async function as(key: FamilyKey) {
    const agent = request.agent(app);
    const email = FAMILY.find((f) => f.key === key)!.email;
    const res = await agent.post("/api/auth/login").set("x-luna-client", "web").send({ email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${JSON.stringify(res.body)}`);
    const wrap = (method: "get" | "post" | "patch" | "delete") => (url: string) => {
      const r = agent[method](url);
      return method === "get" ? r : r.set("x-luna-client", "web");
    };
    return { agent, get: wrap("get"), post: wrap("post"), patch: wrap("patch"), del: wrap("delete") };
  }

  async function categoryId(name: string) {
    const { rows } = await db.query<{ id: number }>("SELECT id FROM categories WHERE name = $1", [name]);
    return rows[0].id;
  }

  async function setAccess(key: FamilyKey, access: "none" | "summary" | "full") {
    await db.query("UPDATE users SET family_access = $2 WHERE id = $1", [ids[key], access]);
  }

  return { ctx, db, app, tg, ids, as, categoryId, setAccess, close: () => db.close() };
}

export type TestApp = Awaited<ReturnType<typeof setupTestApp>>;
