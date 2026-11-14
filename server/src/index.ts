import { assertProductionConfig, loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createContext } from "./bootstrap.js";
import { startScheduler } from "./notifications/jobs.js";

async function main() {
  const config = loadConfig();
  assertProductionConfig(config);
  const ctx = await createContext(config);
  const app = createApp(ctx);
  const server = app.listen(config.port, () => {
    ctx.log.info("servidor iniciado", {
      port: config.port,
      env: config.env,
      db: ctx.db.driver,
      telegram: config.telegram.enabled ? "ativo" : "desativado",
      ia: config.ai.enabled ? "ativa" : "desativada",
    });
  });
  const stop = config.schedulerEnabled ? startScheduler(ctx) : () => {};
  const shutdown = async (sig: string) => {
    ctx.log.info("encerrando", { sig });
    stop();
    server.close();
    await ctx.db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
