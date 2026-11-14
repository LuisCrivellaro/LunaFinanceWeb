/**
 * Gerencia o webhook do bot na Telegram Bot API.
 *   npm run telegram:set-webhook     → registra APP_URL/telegram/webhook + comandos
 *   npm run telegram:webhook-info    → mostra o estado atual (erros recentes, pendências)
 *   npm run telegram:delete-webhook  → remove o webhook
 */
import { loadConfig } from "../config.js";
import { BOT_COMMANDS, createTelegramApi } from "../telegram/api.js";

const cfg = loadConfig();
const mode = process.argv[2];
if (!cfg.telegram.botToken) throw new Error("Defina TELEGRAM_BOT_TOKEN no .env");
const tg = createTelegramApi(cfg.telegram.botToken);

if (mode === "set") {
  if (cfg.telegram.webhookSecret.length < 32) throw new Error("Defina TELEGRAM_WEBHOOK_SECRET com 32+ caracteres (A-Z, a-z, 0-9, _ e -)");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(cfg.telegram.webhookSecret)) throw new Error("TELEGRAM_WEBHOOK_SECRET só pode ter A-Z, a-z, 0-9, _ e -");
  if (!cfg.appUrl.startsWith("https://")) throw new Error("APP_URL precisa ser https:// (exigência do Telegram)");
  const url = `${cfg.appUrl}/telegram/webhook`;
  await tg.call("setWebhook", {
    url,
    secret_token: cfg.telegram.webhookSecret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 10,
  });
  await tg.call("setMyCommands", { commands: BOT_COMMANDS });
  const me = await tg.call<{ username: string }>("getMe");
  console.log(`Webhook registrado em ${url}`);
  console.log(`Bot: @${me.username}${cfg.telegram.botUsername && cfg.telegram.botUsername !== me.username ? `  (atenção: TELEGRAM_BOT_USERNAME está como ${cfg.telegram.botUsername})` : ""}`);
} else if (mode === "info") {
  const info = await tg.call<Record<string, unknown>>("getWebhookInfo");
  console.log(JSON.stringify(info, null, 2));
} else if (mode === "delete") {
  await tg.call("deleteWebhook", { drop_pending_updates: false });
  console.log("Webhook removido.");
} else {
  console.log("Uso: telegram-webhook.ts set|info|delete");
}
