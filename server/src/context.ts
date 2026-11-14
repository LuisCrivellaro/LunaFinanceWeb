import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { TelegramApi } from "./telegram/api.js";
import type { Assistant } from "./telegram/assistant.js";

/** Dependências compartilhadas, injetadas (facilita testes com fakes). */
export interface AppContext {
  db: Db;
  config: Config;
  telegram: TelegramApi | null;
  /** Assistente com IA (opcional). */
  ai: Assistant | null;
  log: Logger;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Logger JSON de uma linha. Nunca registre tokens, senhas ou corpo de mensagens financeiras. */
export function createLogger(silent = false): Logger {
  const write = (level: string, msg: string, meta?: Record<string, unknown>) => {
    if (silent) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta });
    if (level === "error") console.error(line);
    else console.log(line);
  };
  return {
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
  };
}
