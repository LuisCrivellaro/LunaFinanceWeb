/**
 * Cliente mínimo da Telegram Bot API (https://core.telegram.org/bots/api).
 * O token fica só no servidor (variável TELEGRAM_BOT_TOKEN) e nunca é logado.
 */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface SendOptions {
  reply_markup?: { inline_keyboard: InlineButton[][] } | { remove_keyboard: true };
  disable_web_page_preview?: boolean;
}

export interface TelegramApi {
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<{ message_id: number } | null>;
  editMessageText(chatId: number, messageId: number, text: string, opts?: SendOptions): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export class TelegramError extends Error {
  constructor(public method: string, public errorCode: number | undefined, description: string) {
    super(`Telegram ${method} falhou: ${description}`);
  }
}

export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const base = `https://api.telegram.org/bot${token}`;
  async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetchImpl(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
      if (!data.ok) throw new TelegramError(method, data.error_code ?? res.status, data.description ?? `HTTP ${res.status}`);
      return data.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    call,
    async sendMessage(chatId, text, opts = {}) {
      return call<{ message_id: number }>("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: opts.disable_web_page_preview ?? true,
        ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
      });
    },
    async editMessageText(chatId, messageId, text, opts = {}) {
      await call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
      });
    },
    async answerCallbackQuery(id, text) {
      await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
    },
  };
}

/** Comandos exibidos no menu do Telegram (setMyCommands). */
export const BOT_COMMANDS = [
  { command: "resumo", description: "Resumo financeiro do mês" },
  { command: "saldo", description: "Seu saldo" },
  { command: "familia", description: "Saldo e resumo da família" },
  { command: "receitas", description: "Receitas do mês" },
  { command: "despesas", description: "Despesas do mês" },
  { command: "contas", description: "Contas pendentes e atrasadas" },
  { command: "vencimentos", description: "Próximos vencimentos" },
  { command: "metas", description: "Metas financeiras" },
  { command: "notificacoes", description: "Preferências de avisos" },
  { command: "ajuda", description: "Como usar o bot" },
  { command: "desvincular", description: "Desconectar esta conta do Telegram" },
];
