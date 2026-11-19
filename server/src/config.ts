/**
 * Configuração central. Tudo que é segredo vem de variável de ambiente —
 * nada de token no código. Veja `.env.example`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Carrega um arquivo .env simples (KEY=VALUE) sem sobrescrever o ambiente real. */
function loadDotEnv(file = resolve(process.cwd(), ".env")) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

if (process.env.NODE_ENV !== "test") loadDotEnv();

function bool(v: string | undefined, def: boolean) {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number) {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : def;
}

export interface Config {
  env: "development" | "production" | "test";
  port: number;
  databaseUrl: string;
  /** URL pública do site, ex.: https://luna.seudominio.com.br */
  appUrl: string;
  timezone: string;
  sessionDays: number;
  /** Tentativas de login por IP a cada 15 min. */
  loginRateMax: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  telegram: {
    botToken: string;
    botUsername: string;
    webhookSecret: string;
    /** URL pública completa do webhook (padrão: APP_URL + /telegram/webhook). */
    webhookUrl: string;
    enabled: boolean;
    /** Confere o webhook a cada rodada do agendador e o restaura se alguém o trocar (padrão: só em produção). */
    webhookGuard: boolean;
  };
  cronSecret: string;
  schedulerEnabled: boolean;
  ai: {
    apiKey: string;
    model: string;
    effort: "low" | "medium" | "high";
    enabled: boolean;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV as Config["env"]) || "development";
  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const aiKey = env.ANTHROPIC_API_KEY ?? "";
  // Railway e Render informam o domínio público sozinhos: APP_URL vira opcional nelas
  const platformUrl = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : env.RENDER_EXTERNAL_URL;
  const appUrl = (env.APP_URL || platformUrl || "http://localhost:5173").replace(/\/$/, "");
  const cfg: Config = {
    env: nodeEnv,
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL || (nodeEnv === "production" ? "" : "pglite://.data/luna"),
    appUrl,
    timezone: env.APP_TIMEZONE ?? "America/Sao_Paulo",
    sessionDays: int(env.SESSION_DAYS, 30),
    loginRateMax: int(env.LOGIN_RATE_MAX, 20),
    cookieSecure: bool(env.COOKIE_SECURE, nodeEnv === "production"),
    trustProxy: bool(env.TRUST_PROXY, nodeEnv === "production"),
    telegram: {
      botToken,
      botUsername: (env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, ""),
      webhookSecret,
      webhookUrl: (env.TELEGRAM_WEBHOOK_URL || `${appUrl}/telegram/webhook`).replace(/\/$/, ""),
      enabled: Boolean(botToken && webhookSecret),
      webhookGuard: bool(env.TELEGRAM_WEBHOOK_GUARD, nodeEnv === "production"),
    },
    cronSecret: env.CRON_SECRET ?? "",
    schedulerEnabled: bool(env.SCHEDULER_ENABLED, nodeEnv !== "test"),
    ai: {
      apiKey: aiKey,
      model: env.LUNA_AI_MODEL || "claude-opus-5-5",
      effort: (["low", "medium", "high"].includes(env.LUNA_AI_EFFORT ?? "") ? env.LUNA_AI_EFFORT : "low") as "low" | "medium" | "high",
      enabled: Boolean(aiKey) && bool(env.LUNA_AI_ENABLED, true),
    },
  };
  return cfg;
}

/** Falha cedo em produção se faltar algo crítico. */
export function assertProductionConfig(cfg: Config) {
  if (cfg.env !== "production") return;
  const problems: string[] = [];
  if (!cfg.databaseUrl) problems.push("DATABASE_URL não definido");
  if (!cfg.appUrl.startsWith("https://")) problems.push("APP_URL deve usar https:// em produção");
  if (cfg.telegram.botToken && !cfg.telegram.webhookUrl.startsWith("https://"))
    problems.push("TELEGRAM_WEBHOOK_URL deve usar https://");
  if (cfg.telegram.botToken && cfg.telegram.webhookSecret.length < 32)
    problems.push("TELEGRAM_WEBHOOK_SECRET deve ter pelo menos 32 caracteres (gere com: openssl rand -hex 32)");
  else if (cfg.telegram.botToken && !/^[A-Za-z0-9_-]{32,256}$/.test(cfg.telegram.webhookSecret))
    problems.push("TELEGRAM_WEBHOOK_SECRET só pode ter A-Z, a-z, 0-9, _ e -");
  if (cfg.cronSecret && cfg.cronSecret.length < 32) problems.push("CRON_SECRET deve ter pelo menos 32 caracteres");
  if (problems.length) {
    throw new Error("Configuração inválida para produção:\n- " + problems.join("\n- "));
  }
}
