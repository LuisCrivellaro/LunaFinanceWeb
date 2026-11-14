import { loadConfig, type Config } from "./config.js";
import { createLogger, type AppContext } from "./context.js";
import { createDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { setTimezone } from "./lib/clock.js";
import { createAssistant } from "./telegram/assistant.js";
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
    ai: config.ai.enabled ? createAssistant({ apiKey: config.ai.apiKey, model: config.ai.model, effort: config.ai.effort, log }) : null,
  };
}
