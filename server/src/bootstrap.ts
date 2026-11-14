import { loadConfig, type Config } from "./config.js";
import { createLogger, type AppContext } from "./context.js";
import { createDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { setTimezone } from "./lib/clock.js";
import { createAiParser } from "./telegram/ai.js";
import { createTelegramApi } from "./telegram/api.js";

export async function createContext(config: Config = loadConfig()): Promise<AppContext> {
  setTimezone(config.timezone);
  const log = createLogger(config.env === "test");
  const db = await createDb(config.databaseUrl);
  await migrate(db, (m) => log.info(m));
  return {
    db,
    config,
    log,
    telegram: config.telegram.botToken ? createTelegramApi(config.telegram.botToken) : null,
    ai: config.ai.enabled ? createAiParser(config.ai.apiKey, config.ai.model, log) : null,
  };
}
