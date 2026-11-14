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
  readonly transient: boolean;
  readonly retryAfter?: number;
  constructor(public method: string, public errorCode: number | undefined, public description: string, opts: { transient?: boolean; retryAfter?: number } = {}) {
    super(`Telegram ${method} falhou: ${description}`);
    this.transient = opts.transient ?? false;
    this.retryAfter = opts.retryAfter;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cliente com:
 *  - timeout por chamada (10s; long polling usa o próprio timeout + 10s);
 *  - 429: respeita `parameters.retry_after` (até 10s) e tenta mais uma vez;
 *  - falha de rede / 5xx: uma nova tentativa após 1s;
 *  - "message is not modified" em edições é tratado como sucesso.
 * O token nunca entra em mensagens de erro ou logs.
 */
export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const base = `https://api.telegram.org/bot${token}`;
  async function once<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const ctrl = new AbortController();
    const waitMs = typeof params.timeout === "number" ? (params.timeout + 10) * 1000 : 10000;
    const timer = setTimeout(() => ctrl.abort(), waitMs);
    try {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        });
      } catch (err) {
        const aborted = (err as Error).name === "AbortError";
        throw new TelegramError(method, undefined, aborted ? "tempo esgotado" : "falha de rede", { transient: true });
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number };
      };
      if (!data.ok) {
        const code = data.error_code ?? res.status;
        throw new TelegramError(method, code, data.description ?? `HTTP ${res.status}`, {
          retryAfter: data.parameters?.retry_after,
          transient: code >= 500 || code === 429,
        });
      }
      return data.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
  /** Até 3 tentativas com backoff exponencial (0,5s → 1s) para falhas transitórias. */
  async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const maxAttempts = method === "getUpdates" ? 1 : 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await once<T>(method, params);
      } catch (err) {
        if (!(err instanceof TelegramError) || !err.transient || attempt >= maxAttempts) throw err;
        if (err.errorCode === 429 && (err.retryAfter ?? 0) > 10) throw err; // não segura a requisição por muito tempo
        const wait = err.errorCode === 429 ? Math.max(1, err.retryAfter ?? 1) * 1000 : 500 * 2 ** (attempt - 1);
        await sleep(wait);
      }
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
      try {
        await call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
        });
      } catch (err) {
        if (err instanceof TelegramError && /message is not modified/i.test(err.description)) return;
        throw err;
      }
    },
    async answerCallbackQuery(id, text) {
      try {
        await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
      } catch (err) {
        // callback antigo (>15 min) não pode mais ser respondido — não é erro do usuário
        if (err instanceof TelegramError && /query is too old|query ID is invalid/i.test(err.description)) return;
        throw err;
      }
    },
  };
}

/** Comandos exibidos no menu do Telegram (setMyCommands). */
export const BOT_COMMANDS = [
  { command: "menu", description: "Menu principal com botões" },
  { command: "resumo", description: "Resumo do mês e relatórios" },
  { command: "saldo", description: "Saldo disponível" },
  { command: "despesas", description: "Últimas despesas" },
  { command: "receitas", description: "Últimas receitas" },
  { command: "metas", description: "Metas financeiras" },
  { command: "contas", description: "Contas pendentes e atrasadas" },
  { command: "vencimentos", description: "Próximos vencimentos" },
  { command: "familia", description: "Resumo da família" },
  { command: "cancelar", description: "Cancelar operação em andamento" },
  { command: "configuracoes", description: "Preferências e avisos" },
  { command: "ajuda", description: "Como usar o bot" },
];
