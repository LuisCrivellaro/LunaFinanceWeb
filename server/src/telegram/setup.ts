/**
 * Preparação automática do bot ao iniciar o servidor (produção):
 *  - descobre o @ do bot (getMe) se TELEGRAM_BOT_USERNAME não foi informado;
 *  - registra o webhook e o menu de comandos se ainda não estiverem certos.
 * Assim, publicar exige só as variáveis de ambiente — sem rodar scripts à mão.
 * O vigia (ensureWebhook) roda de novo a cada rodada do agendador.
 */
import type { AppContext } from "../context.js";
import { BOT_COMMANDS, registerWebhook } from "./api.js";

/**
 * Se o webhook registrado no Telegram não for o nosso (nunca registrado, removido ou
 * apontando para outro endereço — sinal de que alguém com o token tentou desviar as
 * mensagens), registra de novo. Retorna true se precisou registrar.
 */
export async function ensureWebhook(ctx: AppContext): Promise<boolean> {
  const t = ctx.config.telegram;
  if (!ctx.telegram || !t.enabled || !t.webhookGuard || !t.webhookUrl.startsWith("https://")) return false;
  const info = await ctx.telegram.call<{ url?: string }>("getWebhookInfo");
  if (info?.url === t.webhookUrl) return false;
  if (info?.url) {
    let found = "(inválido)";
    try {
      found = new URL(info.url).host;
    } catch {
      /* mantém "(inválido)" */
    }
    ctx.log.error("telegram.webhook_alterado", { encontrado: found });
  }
  await registerWebhook(ctx.telegram, t.webhookUrl, t.webhookSecret);
  await ctx.telegram.call("setMyCommands", { commands: BOT_COMMANDS });
  ctx.log.warn("telegram.webhook_registrado", { host: new URL(t.webhookUrl).host });
  return true;
}

/** Chamado uma vez ao iniciar. Nunca derruba o servidor: falhas vão para o log. */
export async function prepareTelegram(ctx: AppContext): Promise<void> {
  const t = ctx.config.telegram;
  if (!ctx.telegram || !t.enabled) return;
  try {
    const me = await ctx.telegram.call<{ username?: string }>("getMe");
    if (me?.username && !t.botUsername) t.botUsername = me.username;
    else if (me?.username && t.botUsername !== me.username)
      ctx.log.warn("telegram.username_divergente", { configurado: t.botUsername, real: me.username });
    await ensureWebhook(ctx);
    ctx.log.info("telegram.pronto", { bot: t.botUsername || null, webhook: t.webhookGuard ? "conferido" : "manual" });
  } catch (err) {
    // token inválido/revogado aparece aqui como 401 Unauthorized
    ctx.log.error("telegram.preparacao_falhou", { err: (err as Error).message.slice(0, 200) });
  }
}
