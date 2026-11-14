/**
 * Modo de DESENVOLVIMENTO: recebe mensagens por long polling (getUpdates),
 * sem precisar de domínio público/HTTPS. Em produção use o webhook.
 *   npm run telegram:poll
 * O Telegram não entrega getUpdates enquanto houver webhook ativo — este
 * script avisa e para se encontrar um.
 */
import { loadConfig } from "../config.js";
import { createContext } from "../bootstrap.js";
import { handleUpdate, type TgUpdate } from "../telegram/bot.js";
import { startScheduler } from "../notifications/jobs.js";

const config = loadConfig();
if (config.env === "production") throw new Error("Use o webhook em produção (npm run telegram:set-webhook).");
if (!config.telegram.botToken) throw new Error("Defina TELEGRAM_BOT_TOKEN no .env");

const ctx = await createContext({ ...config, telegram: { ...config.telegram, enabled: true } });
const tg = ctx.telegram!;
const info = await tg.call<{ url: string }>("getWebhookInfo");
if (info.url) {
  console.error(`Há um webhook ativo (${info.url}). Rode "npm run telegram:delete-webhook" antes de usar o polling.`);
  process.exit(1);
}
const me = await tg.call<{ username: string }>("getMe");
console.log(`Bot @${me.username} ouvindo mensagens (Ctrl+C para sair)…`);
if (config.schedulerEnabled) startScheduler(ctx);

let offset = 0;
for (;;) {
  try {
    const updates = await tg.call<TgUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
    for (const u of updates) {
      offset = u.update_id + 1;
      await handleUpdate(ctx, u);
    }
  } catch (err) {
    console.error("Falha no polling:", (err as Error).message);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
