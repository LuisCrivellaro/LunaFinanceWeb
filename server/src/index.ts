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
  const shutdown = async (sig: string, code = 0) => {
    ctx.log.info("encerrando", { sig });
    stop();
    server.close();
    await ctx.db.close().catch(() => {});
    process.exit(code);
  };
  // uma falha isolada não derruba o servidor: registra e segue
  process.on("unhandledRejection", (reason) => {
    ctx.log.error("processo.promessa_rejeitada", { err: String((reason as Error)?.message ?? reason).slice(0, 300) });
  });
  process.on("uncaughtException", (err) => {
    // estado do processo é incerto: registra e reinicia de forma controlada
    // (a plataforma/Docker sobe o processo de novo; nenhuma operação fica pela metade
    // porque gravações financeiras são transações atômicas no banco)
    ctx.log.error("processo.excecao", { err: err.message.slice(0, 300) });
    void shutdown("uncaughtException", 1);
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
