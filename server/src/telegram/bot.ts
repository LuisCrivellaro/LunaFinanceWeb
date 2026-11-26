/**
 * Bot do Luna Finance — roteamento de mensagens e botões.
 *
 * Fluxo de cada update:
 *   1. idempotência por update_id (com retentativa controlada após falha);
 *   2. só chats privados;
 *   3. identidade = Telegram ID vinculado (nunca o nome digitado);
 *   4. permissões = as mesmas do site (services/access.ts);
 *   5. gravações financeiras só após confirmação explícita, de forma atômica.
 */
import type { AppContext } from "../context.js";
import { HttpError } from "../lib/errors.js";
import { monthRange, today } from "../lib/clock.js";
import type { AuthUser } from "../services/access.js";
import { listAccounts } from "../services/accounts.js";
import { listCategories } from "../services/categories.js";
import { contributeWith, createGoalWith, listGoals } from "../services/goals.js";
import {
  createTransactionWith, deleteTransactionWith, getTransactions, markPaid, PAYMENT_LABELS, PAYMENT_METHODS, updateTransactionWith, type PaymentMethod,
} from "../services/transactions.js";
import { executePending, type ExecResult } from "../channels/execute.js";
import type { InlineButton } from "./api.js";
import { isPermanentTelegramError, TelegramError } from "./api.js";
import { findPossibleDuplicate } from "./data.js";
import { brl, dtFull, esc } from "./format.js";
import { consumeLinkCode, unlinkTelegram, userByTelegramId } from "./linking.js";
import { followUp, interpret, monthPeriod, parseAmountReply, type Intent, type NluContext, type Query } from "./nlu.js";
import { aiLimiter, messageLimiter } from "./throttle.js";
import type { Draft } from "./parser.js";
import { matchCategory, normalize, parseDateText } from "./parser.js";
import { buildReply, dateLabel, REPORT_MENU, reportQuery } from "./replies.js";
import {
  cancelAllPending, cancelPending, clearConversation, confirmPending, createPending, getConversation, getLastQuery, getPending, pendingProblem,
  saveLastQuery, setConversation, setPendingMessage, updatePending, type ConvState, type Pending, type PendingPayload,
  type TransferPayload, type TxDeletePayload, type TxUpdatePayload, type WizardFlow,
} from "./state.js";

// ----- Tipos mínimos da Bot API -----
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Falha de infraestrutura: o update pode ser reprocessado (o Telegram reenvia). */
export class RetryableError extends Error {}

const MAX_ATTEMPTS = 3;
type User = AuthUser & { chatId: number };

// =========================== entrada (idempotente) ===========================

export async function handleUpdate(ctx: AppContext, update: TgUpdate): Promise<void> {
  if (!ctx.telegram || typeof update?.update_id !== "number") return;
  const op = `tg-${update.update_id}`;
  const started = Date.now();
  // Reserva o update. Repetições de um update já concluído (ou em andamento) são ignoradas;
  // um update que falhou pode ser tentado de novo até MAX_ATTEMPTS.
  const claim = await ctx.db.query<{ attempts: number }>(
    `INSERT INTO telegram_updates (update_id, status, attempts) VALUES ($1, 'processing', 1)
     ON CONFLICT (update_id) DO UPDATE SET status = 'processing', attempts = telegram_updates.attempts + 1
       WHERE telegram_updates.status = 'failed' AND telegram_updates.attempts < $2
     RETURNING attempts`,
    [update.update_id, MAX_ATTEMPTS],
  );
  if (!claim.rows.length) {
    ctx.log.info("telegram.update_duplicado", { op });
    return;
  }
  const attempt = claim.rows[0].attempts;
  try {
    if (update.message) await onMessage(ctx, update.message, op);
    else if (update.callback_query) await onCallback(ctx, update.callback_query, op);
    await ctx.db.query("UPDATE telegram_updates SET status = 'done' WHERE update_id = $1", [update.update_id]);
    ctx.log.info("telegram.update_ok", { op, ms: Date.now() - started });
  } catch (err) {
    const msg = (err as Error).message;
    // erro permanente do Telegram (bot bloqueado, chat inexistente, requisição inválida): repetir não resolve
    const permanent = isPermanentTelegramError(err);
    ctx.log.error("telegram.update_erro", { op, attempt, permanent, err: msg.slice(0, 200) });
    await ctx.db
      .query("UPDATE telegram_updates SET status = 'failed', attempts = $2 WHERE update_id = $1", [update.update_id, permanent ? MAX_ATTEMPTS : attempt])
      .catch(() => {});
    if (attempt < MAX_ATTEMPTS && !permanent) throw new RetryableError(msg);
    // última tentativa: avisa o usuário sem afirmar que algo foi concluído
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId && update.message?.chat.type !== "group" && update.message?.chat.type !== "supergroup") {
      await ctx.telegram
        .sendMessage(chatId, "⚠️ Tive um problema técnico e não consegui concluir esta mensagem. Antes de tentar de novo, confira /despesas para não lançar em duplicidade.")
        .catch(() => {});
    }
  }
}

// =========================== mensagens ===========================

async function onMessage(ctx: AppContext, msg: TgMessage, op: string) {
  const tg = ctx.telegram!;
  if (!msg.from || msg.from.is_bot) return;
  if (msg.chat.type !== "private") {
    await tg.sendMessage(msg.chat.id, "Por segurança, o Luna Finance só funciona em conversa privada comigo.");
    return;
  }
  const text = (msg.text ?? "").trim();
  if (!text) {
    await tg.sendMessage(msg.chat.id, "Por enquanto eu entendo apenas mensagens de texto. 🙂");
    return;
  }
  if (text.length > 1000) {
    await tg.sendMessage(msg.chat.id, "Mensagem muito longa. Envie uma frase curta, como <i>gastei 45 no almoço</i>.");
    return;
  }
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.startsWith("/") ? rawCmd.slice(1).split("@")[0].toLowerCase() : null;
  const arg = rest.join(" ");

  if (cmd === "start" && arg.toLowerCase().startsWith("link_")) return doLink(ctx, msg, arg);
  if (cmd === "vincular") return doLink(ctx, msg, arg);

  const user = await userByTelegramId(ctx.db, msg.from.id);
  if (!user || user.chatId !== msg.chat.id) {
    await tg.sendMessage(
      msg.chat.id,
      "Olá! Eu sou o assistente do <b>Luna Finance</b>.\n\nPara começar, conecte sua conta:\n" +
        "1. Entre no site do Luna Finance\n2. Abra <b>Configurações → Telegram</b> e toque em <b>Conectar</b>\n" +
        "3. Abra o link gerado ou me envie <code>/vincular CÓDIGO</code>\n\nSem esse código eu não mostro nenhuma informação.",
    );
    return;
  }
  ctx.log.info("telegram.mensagem", { op, user_id: user.id, cmd: cmd ?? "texto" });
  if (!messageLimiter.take(`u${user.id}`)) {
    ctx.log.warn("telegram.limite_mensagens", { op, user_id: user.id });
    await tg.sendMessage(user.chatId, "Muitas mensagens em pouco tempo. Aguarde um minuto e tente de novo.");
    return;
  }

  if (cmd) {
    // qualquer comando encerra uma pergunta em andamento
    await clearConversation(ctx.db, user.id);
    return runCommand(ctx, user, cmd);
  }
  const state = await getConversation(ctx.db, user.id);
  if (state && (await handleConversationReply(ctx, user, state, text))) return;
  return handleFreeText(ctx, user, text);
}

async function runCommand(ctx: AppContext, user: User, cmd: string) {
  const tg = ctx.telegram!;
  switch (cmd) {
    case "start":
      return sendWelcome(ctx, user);
    case "menu":
      return sendMenu(ctx, user);
    case "ajuda":
    case "help":
      return sendHelp(ctx, user);
    case "saldo":
      return answer(ctx, user, { q: "balance" });
    case "resumo":
    case "relatorio":
    case "relatorios":
      return answer(ctx, user, { q: "summary", period: monthPeriod(today().slice(0, 7)) });
    case "despesas":
      return answer(ctx, user, { q: "last", kind: "expense", limit: 10 });
    case "receitas":
      return answer(ctx, user, { q: "last", kind: "income", limit: 10 });
    case "metas":
      return answer(ctx, user, { q: "goals" });
    case "contas":
    case "pendentes":
      return answer(ctx, user, { q: "bills" });
    case "vencimentos":
      return answer(ctx, user, { q: "upcoming" });
    case "familia":
      return answer(ctx, user, { q: "family" });
    case "cancelar": {
      const n = await cancelAllPending(ctx.db, user.id);
      await tg.sendMessage(user.chatId, n ? `Ok, cancelei ${n === 1 ? "a operação em andamento" : `${n} operações em andamento`}. Nada foi registrado.` : "Não havia nenhuma operação em andamento.");
      return;
    }
    case "configuracoes":
    case "config":
    case "notificacoes":
      return sendSettings(ctx, user);
    case "desvincular":
      await tg.sendMessage(user.chatId, "Desconectar este Telegram da sua conta do Luna Finance?", {
        reply_markup: { inline_keyboard: [[{ text: "Sim, desconectar", callback_data: "u:yes" }, { text: "Não", callback_data: "x:none" }]] },
      });
      return;
    default:
      await tg.sendMessage(user.chatId, "Não conheço esse comando. Envie /ajuda para ver o que eu sei fazer.");
  }
}

async function doLink(ctx: AppContext, msg: TgMessage, code: string) {
  const tg = ctx.telegram!;
  if (!code) {
    await tg.sendMessage(msg.chat.id, "Envie no formato <code>/vincular CÓDIGO</code>. O código é gerado no site, em Configurações → Telegram.");
    return;
  }
  const r = await consumeLinkCode(ctx.db, { telegramUserId: msg.from!.id, chatId: msg.chat.id, username: msg.from!.username, firstName: msg.from!.first_name }, code);
  if (!r.ok) {
    await tg.sendMessage(
      msg.chat.id,
      r.reason === "rate_limited"
        ? "Muitas tentativas com códigos inválidos. Aguarde 15 minutos e gere um novo código no site."
        : "Código inválido ou expirado. Gere um novo no site (ele vale por 10 minutos).",
    );
    return;
  }
  ctx.log.info("telegram.vinculado", { user_id: r.userId });
  await tg.sendMessage(
    msg.chat.id,
    `Tudo certo, ${esc(r.name.split(" ")[0])}! Sua conta está conectada. ✅\n\nExperimente:\n• <i>Gastei 45 reais no almoço</i>\n• <i>Recebi 2.500 de salário</i>\n• <i>Quanto gastei este mês?</i>\n• /ajuda`,
  );
}

/** Menu principal (Inline Keyboard). Callbacks: w:<fluxo>, q:<consulta>, cfg. */
export const MAIN_MENU: InlineButton[][] = [
  [{ text: "💸 Gastei", callback_data: "w:expense" }, { text: "💰 Recebi", callback_data: "w:income" }],
  [{ text: "📈 Economizei", callback_data: "w:save" }, { text: "📊 Meu resumo", callback_data: "q:summary" }],
  [{ text: "🎯 Minhas metas", callback_data: "q:goals" }, { text: "⚙️ Configurações", callback_data: "cfg" }],
];
const MENU_BUTTON: InlineButton = { text: "🏠 Menu principal", callback_data: "menu" };

function quickQuery(key: string): Query | null {
  switch (key) {
    case "summary":
      return { q: "summary", period: monthPeriod(today().slice(0, 7)) };
    case "balance":
      return { q: "balance" };
    case "spendable":
      return { q: "spendable" };
    case "goals":
      return { q: "goals" };
    case "last_expense":
      return { q: "last", kind: "expense", limit: 10 };
    default:
      return null;
  }
}

async function sendWelcome(ctx: AppContext, user: User) {
  await ctx.telegram!.sendMessage(
    user.chatId,
    `Oi, ${esc(user.name.split(" ")[0])}! 🌙 Sou o assistente do <b>Luna Finance</b>.\n\n` +
      "Escolha uma opção abaixo — ou, se preferir, escreva normalmente, como <i>gastei 45 no almoço</i> ou <i>quanto gastei essa semana?</i>\n\n" +
      "Eu sempre mostro um resumo e só registro depois que você confirmar.",
    { reply_markup: { inline_keyboard: MAIN_MENU } },
  );
}

async function sendMenu(ctx: AppContext, user: User, messageId?: number) {
  const text = "🏠 <b>Menu principal</b>\nO que você quer fazer?";
  if (messageId) {
    try {
      await ctx.telegram!.editMessageText(user.chatId, messageId, text, { reply_markup: { inline_keyboard: MAIN_MENU } });
      return;
    } catch {
      /* mensagem antiga demais para editar: envia uma nova */
    }
  }
  await ctx.telegram!.sendMessage(user.chatId, text, { reply_markup: { inline_keyboard: MAIN_MENU } });
}

// =========================== assistente do menu (Gastei / Recebi / Economizei) ===========================

const WIZ_TITLE = { expense: "💸 <b>Gastei</b>", income: "💰 <b>Recebi</b>", save: "📈 <b>Economizei</b>" } as const;

async function startWizard(ctx: AppContext, user: User, flow: WizardFlow) {
  await cancelAllPending(ctx.db, user.id); // rascunhos antigos não competem com o novo fluxo
  await setConversation(ctx.db, user.id, { step: "wiz", flow, stage: "amount" });
  const hint = flow === "save" ? "Quanto você guardou? (ex.: 200)" : flow === "income" ? "Qual o valor recebido? (ex.: 2.500)" : "Qual foi o valor? (ex.: 45,90)";
  await ctx.telegram!.sendMessage(user.chatId, `${WIZ_TITLE[flow]}\n\n${hint}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}

/** Total já separado: contribuições da pessoa em metas + saldo das contas de reserva (poupança/investimento). */
async function savingsTotal(ctx: AppContext, user: AuthUser) {
  const { rows } = await ctx.db.query<{ v: number }>("SELECT COALESCE(sum(amount_cents),0)::bigint AS v FROM goal_contributions WHERE user_id = $1", [user.id]);
  const reserves = (await listAccounts(ctx.db, user, [user.id])).filter((a) => a.type === "savings" || a.type === "investment");
  return { goalsCents: rows[0].v, reservesCents: reserves.reduce((s2, a) => s2 + a.balanceCents, 0) };
}

async function wizardAmount(ctx: AppContext, user: User, state: Extract<ConvState, { step: "wiz" }>, cents: number) {
  const tg = ctx.telegram!;
  if (state.flow === "save") {
    const goals = (await listGoals(ctx.db, user, {})).filter((g) => !g.archived && !g.achievedAt && (g.scope === "family" ? user.family_access !== "none" : g.ownerId === user.id));
    const reserves = (await listAccounts(ctx.db, user, [user.id])).filter((a) => !a.isDefault);
    if (!goals.length && !reserves.length) {
      await clearConversation(ctx.db, user.id);
      await tg.sendMessage(
        user.chatId,
        "Para registrar uma economia, ela precisa ir para uma <b>meta</b> ou para uma <b>conta de reserva</b> (ex.: poupança).\n" +
          "Assim o valor não é contado como receita — ele já está no seu saldo, só fica separado.\n\nCrie uma meta agora:",
        { reply_markup: { inline_keyboard: [[{ text: "➕ Criar meta", callback_data: "gn" }], [MENU_BUTTON]] } },
      );
      return;
    }
    await setConversation(ctx.db, user.id, { ...state, stage: "destination", amountCents: cents });
    const rows: InlineButton[][] = [
      ...goals.slice(0, 6).map((g) => [{ text: `🎯 ${g.name.slice(0, 34)}`, callback_data: `ws:g${g.id}` }]),
      ...reserves.slice(0, 4).map((a) => [{ text: `🏦 ${a.name.slice(0, 34)}`, callback_data: `ws:a${a.id}` }]),
      [MENU_BUTTON],
    ];
    await tg.sendMessage(user.chatId, `${WIZ_TITLE.save} · ${brl(cents)}\n\nOnde você guardou esse dinheiro?`, { reply_markup: { inline_keyboard: rows } });
    return;
  }
  await setConversation(ctx.db, user.id, { ...state, stage: "category", amountCents: cents });
  const cats = (await listCategories(ctx.db)).filter((c) => c.kind === state.flow);
  const rows: InlineButton[][] = [];
  for (let i = 0; i < cats.length; i += 2) rows.push(cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `wc:${c.id}` })));
  rows.push([MENU_BUTTON]);
  const question = state.flow === "income" ? "Qual a origem dessa receita? Toque numa opção ou escreva (ex.: <i>salário</i>, <i>freela</i>)." : "Em qual categoria?";
  await tg.sendMessage(user.chatId, `${WIZ_TITLE[state.flow]} · ${brl(cents)}\n\n${question}`, { reply_markup: { inline_keyboard: rows } });
}

async function wizardCategory(ctx: AppContext, user: User, state: Extract<ConvState, { step: "wiz" }>, categoryId: number | null, typedOrigin?: string) {
  if (state.flow === "income") {
    // receita: valor + origem bastam — vai direto para a confirmação
    await clearConversation(ctx.db, user.id);
    const cats = await listCategories(ctx.db);
    const cat = cats.find((c) => c.id === categoryId);
    return proposeWizardEntry(ctx, user, "income", state.amountCents!, categoryId, typedOrigin?.trim() || cat?.name || "Receita");
  }
  await setConversation(ctx.db, user.id, { ...state, stage: "description", categoryId });
  const cat = (await listCategories(ctx.db)).find((c) => c.id === categoryId);
  await ctx.telegram!.sendMessage(user.chatId, `${WIZ_TITLE.expense} · ${brl(state.amountCents!)} · ${esc(cat?.name ?? "Sem categoria")}\n\nDescreva o gasto (ex.: <i>almoço com a equipe</i>):`, {
    reply_markup: { inline_keyboard: [[{ text: `Usar “${cat?.name ?? "Despesa"}”`, callback_data: "wd:skip" }], [MENU_BUTTON]] },
  });
}

async function proposeWizardEntry(ctx: AppContext, user: User, kind: "income" | "expense", cents: number, categoryId: number | null, description: string) {
  const draft: Draft = {
    kind, amountCents: cents, description: description.slice(0, 160), categoryId, date: today(), status: "paid",
    installments: null, paymentMethod: null, accountId: null, amountText: String(cents),
  };
  await sendCard(ctx, user, { kind: "transaction", draft, flow: kind });
}

async function wizardDestination(ctx: AppContext, user: User, state: Extract<ConvState, { step: "wiz" }>, dest: string) {
  const tg = ctx.telegram!;
  const cents = state.amountCents!;
  if (dest.startsWith("g")) {
    const goal = (await listGoals(ctx.db, user, {})).find((g) => g.id === Number(dest.slice(1)) && (g.scope === "family" || g.ownerId === user.id));
    if (!goal) return void (await tg.sendMessage(user.chatId, "Não encontrei essa meta entre as suas.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }));
    await clearConversation(ctx.db, user.id);
    return sendCard(ctx, user, { kind: "contribution", contribution: { goalId: goal.id, goalName: goal.name, amountCents: cents }, flow: "save" });
  }
  const accounts = await listAccounts(ctx.db, user, [user.id]);
  const to = accounts.find((a) => a.id === Number(dest.slice(1)) && !a.isDefault);
  const from = accounts.find((a) => a.isDefault) ?? null;
  if (!to || !from) return void (await tg.sendMessage(user.chatId, "Essa conta não está disponível.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }));
  await clearConversation(ctx.db, user.id);
  return sendCard(ctx, user, { kind: "transfer", transfer: { amountCents: cents, fromAccountId: from.id, toAccountId: to.id, date: today() }, flow: "save" });
}

async function sendHelp(ctx: AppContext, user: User) {
  await ctx.telegram!.sendMessage(
    user.chatId,
    `Oi, ${esc(user.name.split(" ")[0])}! Eu registro e consulto suas finanças no Luna Finance.\n\n` +
      "<b>Registrar</b> (sempre peço confirmação)\n" +
      "• <i>Gastei 45 reais no almoço</i>\n• <i>Paguei 250 de mercado no Pix</i>\n• <i>Recebi 2.500 de salário</i>\n" +
      "• <i>Conta de internet de 120 para dia 20</i>\n• <i>Comprei um celular de 2.400 em 12x</i>\n\n" +
      "<b>Perguntar</b>\n• <i>Quanto gastei este mês?</i>\n• <i>Quanto gastei com alimentação?</i>\n• <i>Compare meus gastos com o mês anterior</i>\n\n" +
      "<b>Metas</b>\n• <i>Criar meta de 10 mil para viagem até 12/2027</i>\n• <i>Guardei 300 na meta viagem</i>\n\n" +
      "<b>Outros</b>\n• <i>Transferi 500 do Nubank para a poupança</i>\n• <i>Apaga a última despesa</i> · <i>Corrige o último lançamento</i>\n" +
      "• <i>Despesas acima de 100 este mês</i> · <i>Quais meus gastos recorrentes?</i>\n• <i>Faz uma análise dos meus gastos</i>\n\n" +
      "<b>Comandos</b>\n/saldo · /resumo · /despesas · /receitas\n/metas · /contas · /vencimentos · /familia\n/cancelar · /configuracoes",
  );
}

async function nluContext(ctx: AppContext, user: AuthUser): Promise<NluContext> {
  const [cats, accounts, goals] = await Promise.all([listCategories(ctx.db), listAccounts(ctx.db, user, [user.id]), listGoals(ctx.db, user, {})]);
  return {
    categories: cats.map((c) => ({ id: c.id, name: c.name, kind: c.kind, keywords: c.keywords })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    goals: goals.filter((g) => g.scope === "family" || g.ownerId === user.id).map((g) => ({ id: g.id, name: g.name })),
    today: today(),
  };
}

async function handleFreeText(ctx: AppContext, user: User, text: string) {
  const nctx = await nluContext(ctx, user);
  // continuação da última consulta ("e no mês passado?")
  const follow = followUp(text, await getLastQuery<Query>(ctx.db, user.id), nctx);
  let intent: Intent = follow ? { type: "query", query: follow } : interpret(text, nctx);

  // IA só entra quando as regras não resolveram (ou para explicações) — com teto por pessoa
  const wantsExplanation = /\b(por que|porque|explique|explica|dica|tend[eê]ncia)\b/i.test(text);
  const needsAi = intent.type === "unknown" || wantsExplanation || (intent.type === "incomplete" && intent.missing.includes("kind"));
  if (ctx.ai && needsAi && text.trim().length >= 4 && aiLimiter.take(`ai${user.id}`)) {
    let r: Awaited<ReturnType<NonNullable<AppContext["ai"]>["respond"]>>;
    try {
      r = await ctx.ai.respond(text, { db: ctx.db, user, today: nctx.today, categories: nctx.categories, accounts: nctx.accounts, goals: nctx.goals });
    } catch (err) {
      // provedor de IA fora do ar nunca derruba o bot: segue com as regras
      ctx.log.warn("ia.indisponivel", { user_id: user.id, err: (err as Error).message.slice(0, 120) });
      r = { type: "none", reason: "erro" };
    }
    if (r.type === "text") {
      await ctx.telegram!.sendMessage(user.chatId, esc(r.text) + "\n\n<i>Resposta gerada com IA a partir dos seus dados.</i>");
      return;
    }
    if (r.type === "proposal") intent = r.intent;
  }

  switch (intent.type) {
    case "greeting":
      return sendWelcome(ctx, user);
    case "menu":
      return sendMenu(ctx, user);
    case "thanks":
      await ctx.telegram!.sendMessage(user.chatId, "Por nada! 🌙 Se precisar, é só mandar mensagem.");
      return;
    case "manage_last":
      return manageLast(ctx, user, intent.action, intent.kind);
    case "transfer":
      return startTransfer(ctx, user, intent.amountCents, intent.fromAccountId, intent.toAccountId, intent.date);
    case "query":
      return answer(ctx, user, intent.query);
    case "entry":
      return proposeEntry(ctx, user, intent.draft);
    case "goal_create":
      return startGoal(ctx, user, intent.name, intent.targetCents, intent.deadline);
    case "goal_contribute":
      return startContribution(ctx, user, intent.goalId, intent.amountCents, intent.withdraw, nctx);
    case "incomplete": {
      if (intent.missing.includes("amount")) {
        const kind = intent.partial.kind;
        if (kind) {
          await setConversation(ctx.db, user.id, { step: "await_amount", draft: { ...intent.partial, kind } });
          await ctx.telegram!.sendMessage(user.chatId, `Qual foi o valor${intent.partial.description ? ` de <b>${esc(intent.partial.description)}</b>` : ""}? (ex.: 45,90)`);
          return;
        }
        break;
      }
      // tem valor, falta saber se é receita ou despesa
      const draft: Draft = {
        kind: "expense",
        amountCents: intent.partial.amountCents!,
        description: text.replace(/r\$\s*/gi, "").replace(/[\d.,]+/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "Lançamento",
        categoryId: null,
        date: intent.partial.date ?? today(),
        status: intent.partial.status ?? "paid",
        installments: null,
        paymentMethod: intent.partial.paymentMethod ?? null,
        accountId: intent.partial.accountId ?? null,
        amountText: intent.partial.amountText ?? "",
      };
      const p = await createPending(ctx.db, user.id, user.chatId, { kind: "transaction", draft });
      await ctx.telegram!.sendMessage(user.chatId, `Entendi o valor de <b>${brl(draft.amountCents)}</b>. É uma despesa ou uma receita?`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💸 Despesa", callback_data: `k:${p.id}:expense` }, { text: "💰 Receita", callback_data: `k:${p.id}:income` }],
            [{ text: "🔁 Transferência entre minhas contas", callback_data: `k:${p.id}:transfer` }],
            [{ text: "Cancelar", callback_data: `x:${p.id}` }],
          ],
        },
      });
      return;
    }
  }
  await ctx.telegram!.sendMessage(
    user.chatId,
    "Não entendi. Você pode registrar algo como <i>Gastei 45 no almoço</i> ou perguntar <i>Quanto gastei este mês?</i>. Envie /ajuda para mais exemplos.",
  );
}

/** Responde a uma pergunta que o bot fez antes. Retorna false se a mensagem não for uma resposta. */
async function handleConversationReply(ctx: AppContext, user: User, state: ConvState, text: string): Promise<boolean> {
  const tg = ctx.telegram!;
  switch (state.step) {
    case "await_amount": {
      const cents = parseAmountReply(text);
      if (!cents) {
        // talvez seja uma nova frase completa — trata como nova mensagem
        const nctx = await nluContext(ctx, user);
        if (interpret(text, nctx).type !== "unknown") {
          await clearConversation(ctx.db, user.id);
          return false;
        }
        await tg.sendMessage(user.chatId, "Não entendi o valor. Envie só o número, por exemplo <b>45,90</b> — ou /cancelar.");
        return true;
      }
      await clearConversation(ctx.db, user.id);
      const d = state.draft;
      await proposeEntry(ctx, user, {
        kind: d.kind,
        amountCents: cents,
        description: d.description || (d.kind === "income" ? "Receita" : "Despesa"),
        categoryId: d.categoryId ?? null,
        date: d.date ?? today(),
        status: d.status ?? "paid",
        installments: d.installments ?? null,
        paymentMethod: d.paymentMethod ?? null,
        accountId: d.accountId ?? null,
        amountText: text,
      });
      return true;
    }

    case "edit_field": {
      const p = await getPending(ctx.db, state.pendingId);
      const problem = pendingProblem(p, user.id);
      if (problem) {
        await clearConversation(ctx.db, user.id);
        await tg.sendMessage(user.chatId, problem);
        return true;
      }
      const payload = p!.payload;
      const err = applyTextEdit(payload, state.field, text);
      if (err) {
        await tg.sendMessage(user.chatId, `${err} Tente de novo ou envie /cancelar.`);
        return true;
      }
      await clearConversation(ctx.db, user.id);
      await refreshCard(ctx, user, p!, payload);
      return true;
    }

    case "goal_name": {
      const name = text.trim().slice(0, 60);
      if (name.length < 2) {
        await tg.sendMessage(user.chatId, "Qual o nome da meta? (ex.: Viagem de férias)");
        return true;
      }
      await setConversation(ctx.db, user.id, { step: "goal_amount", name });
      await tg.sendMessage(user.chatId, `Quanto você quer juntar para <b>${esc(name)}</b>? (ex.: 10.000)`);
      return true;
    }

    case "goal_amount": {
      const cents = parseAmountReply(text);
      if (!cents) {
        await tg.sendMessage(user.chatId, "Não entendi o valor. Envie só o número, por exemplo <b>10.000</b>.");
        return true;
      }
      await setConversation(ctx.db, user.id, { step: "goal_deadline", name: state.name, targetCents: cents });
      await tg.sendMessage(user.chatId, "Tem um prazo? Envie no formato <b>12/2027</b> ou <b>31/12/2027</b>.", {
        reply_markup: { inline_keyboard: [[{ text: "Sem prazo", callback_data: "gd:none" }]] },
      });
      return true;
    }

    case "goal_deadline": {
      const deadline = parseDeadline(text);
      if (deadline === undefined) {
        await tg.sendMessage(user.chatId, "Não entendi a data. Use <b>12/2027</b> ou <b>31/12/2027</b>, ou toque em “Sem prazo”.", {
          reply_markup: { inline_keyboard: [[{ text: "Sem prazo", callback_data: "gd:none" }]] },
        });
        return true;
      }
      await clearConversation(ctx.db, user.id);
      await proposeGoal(ctx, user, { name: state.name, targetCents: state.targetCents, deadline, scope: "individual" });
      return true;
    }

    case "wiz": {
      if (state.stage === "amount") {
        const cents = parseAmountReply(text);
        if (!cents) {
          // frase completa no meio do fluxo: respeita a linguagem natural
          const nctx = await nluContext(ctx, user);
          if (interpret(text, nctx).type !== "unknown") {
            await clearConversation(ctx.db, user.id);
            return false;
          }
          await tg.sendMessage(user.chatId, "Não entendi o valor. Envie só o número, por exemplo <b>45,90</b>.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
          return true;
        }
        await wizardAmount(ctx, user, state, cents);
        return true;
      }
      if (state.stage === "description") {
        const d = text.trim();
        if (!d || d.length > 160) {
          await tg.sendMessage(user.chatId, "A descrição precisa ter entre 1 e 160 caracteres.");
          return true;
        }
        await clearConversation(ctx.db, user.id);
        await proposeWizardEntry(ctx, user, "expense", state.amountCents!, state.categoryId ?? null, d.charAt(0).toUpperCase() + d.slice(1));
        return true;
      }
      if (state.stage === "category" && state.flow === "income") {
        // origem digitada: tenta casar com uma categoria de receita pelas palavras-chave
        const nctx = await nluContext(ctx, user);
        const cat = matchCategory(normalize(text), "income", nctx.categories) ?? nctx.categories.find((c) => c.kind === "income" && /^outr/i.test(c.name));
        await wizardCategory(ctx, user, state, cat?.id ?? null, text.trim().slice(0, 80));
        return true;
      }
      await tg.sendMessage(user.chatId, "Escolha uma das opções acima — ou toque em 🏠 Menu principal.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
      return true;
    }

    case "edit_tx": {
      await clearConversation(ctx.db, user.id);
      await proposeTxUpdate(ctx, user, state.txId, state.field, text);
      return true;
    }

    case "transfer_amount": {
      const cents = parseAmountReply(text);
      if (!cents) {
        await tg.sendMessage(user.chatId, "Não entendi o valor. Envie só o número, por exemplo <b>500</b> — ou /cancelar.");
        return true;
      }
      await clearConversation(ctx.db, user.id);
      await startTransfer(ctx, user, cents, state.fromAccountId, state.toAccountId, state.date);
      return true;
    }

    case "contrib_amount": {
      const cents = parseAmountReply(text);
      if (!cents) {
        await tg.sendMessage(user.chatId, "Não entendi o valor. Envie só o número, por exemplo <b>300</b>.");
        return true;
      }
      await clearConversation(ctx.db, user.id);
      await proposeContribution(ctx, user, { goalId: state.goalId, goalName: state.goalName, amountCents: state.withdraw ? -cents : cents });
      return true;
    }
  }
  return false;
}

/** "12/2027" → último dia do mês; "31/12/2027" → data; texto vazio/sem → null; inválido → undefined */
function parseDeadline(text: string): string | null | undefined {
  const t = text.trim().toLowerCase();
  if (/^(sem( prazo)?|nao|não|-)$/.test(t)) return null;
  const my = t.match(/^(\d{1,2})\/(\d{4})$/);
  if (my) {
    const ym = `${my[2]}-${my[1].padStart(2, "0")}`;
    if (Number(my[1]) < 1 || Number(my[1]) > 12) return undefined;
    const end = monthRange(ym).end;
    return end > today() ? end : undefined;
  }
  const d = parseDateText(t, today());
  return d && d > today() ? d : undefined;
}

// =========================== cartões de confirmação ===========================

async function draftCard(ctx: AppContext, user: AuthUser, d: Draft): Promise<string> {
  const cats = await listCategories(ctx.db, true);
  const cat = cats.find((c) => c.id === d.categoryId);
  const accounts = await listAccounts(ctx.db, user, [user.id]);
  const account = accounts.find((a) => a.id === d.accountId) ?? accounts.find((a) => a.isDefault) ?? accounts[0];
  const dup = await findPossibleDuplicate(ctx.db, user.id, d.kind, d.amountCents, d.date);
  const head = d.kind === "income" ? `💰 <b>Receita: ${brl(d.amountCents)}</b>` : `💸 <b>${d.status === "pending" ? "Conta a pagar" : "Despesa"}: ${brl(d.amountCents)}</b>`;
  const lines = [
    "Entendi! Confira a movimentação:\n",
    head,
    d.installments ? `🔢 Parcelas: ${d.installments}x de ~${brl(Math.round(d.amountCents / d.installments))}` : null,
    `📝 Descrição: ${esc(d.description)}`,
    `📂 Categoria: ${esc(cat?.name ?? "Sem categoria")}`,
    `📅 ${d.status === "pending" ? "Vencimento" : "Data"}: ${dateLabel(d.date)}`,
    d.paymentMethod ? `💳 Pagamento: ${PAYMENT_LABELS[d.paymentMethod]}` : null,
    accounts.length > 1 || d.accountId ? `🏦 Conta: ${esc(account?.name ?? "Conta principal")}` : null,
    `📌 Situação: ${d.status === "pending" ? (d.kind === "income" ? "A receber" : "A pagar") : d.kind === "income" ? "Recebido" : "Pago"}`,
    dup ? `\n⚠️ <b>Possível duplicidade:</b> já existe “${esc(dup.description)}” de ${brl(d.amountCents)} em ${dtFull(dup.date)}${dup.source === "telegram" ? " (registrado pelo Telegram)" : ""}. Confirme só se for outro lançamento.` : null,
    "\nDeseja confirmar?",
  ];
  return lines.filter(Boolean).join("\n");
}

function goalCard(g: { name: string; targetCents: number; deadline: string | null; scope: string }) {
  return (
    "🎯 <b>Nova meta</b>\n\n" +
    `Nome: ${esc(g.name)}\nValor: <b>${brl(g.targetCents)}</b>\nPrazo: ${g.deadline ? dtFull(g.deadline) : "sem prazo"}\n` +
    `Tipo: ${g.scope === "family" ? "da família (todos podem contribuir)" : "individual"}\n\nDeseja criar?`
  );
}

async function contributionCard(ctx: AppContext, user: AuthUser, c: { goalId: number; goalName: string; amountCents: number }) {
  const goal = (await listGoals(ctx.db, user, {})).find((g) => g.id === c.goalId);
  const after = goal ? goal.savedCents + c.amountCents : null;
  return (
    `🎯 <b>${c.amountCents < 0 ? "Retirada da meta" : "Guardar na meta"}</b>\n\n` +
    `Meta: ${esc(c.goalName)}\nValor: <b>${brl(Math.abs(c.amountCents))}</b>\n` +
    (goal && after !== null ? `Depois disso: ${brl(after)} de ${brl(goal.targetCents)} (${Math.min(100, Math.round((after / goal.targetCents) * 100))}%)\n` : "") +
    "\nDeseja confirmar?"
  );
}

async function transferCard(ctx: AppContext, user: AuthUser, t: TransferPayload) {
  const accounts = await listAccounts(ctx.db, user, [user.id]);
  const name = (id: number | null) => (id ? esc(accounts.find((a) => a.id === id)?.name ?? "?") : "<i>escolha abaixo</i>");
  return (
    `🔁 <b>Transferência: ${brl(t.amountCents)}</b>\n\n` +
    `De: ${name(t.fromAccountId)}\nPara: ${name(t.toAccountId)}\nData: ${dateLabel(t.date)}\n\n` +
    "Não conta como receita nem despesa — só move o dinheiro entre suas contas.\n\n" +
    (t.fromAccountId && t.toAccountId ? "Deseja confirmar?" : "De qual conta para qual conta?")
  );
}

function txUpdateCard(u: TxUpdatePayload) {
  const label = { amount: "Valor", description: "Descrição", date: "Data", category: "Categoria" }[u.field];
  return `✏️ <b>Alterar lançamento</b>\n\n${esc(u.description)}\n${label}: ${esc(u.fromLabel)} → <b>${esc(u.toLabel)}</b>\n\nA alteração também aparece no site. Deseja confirmar?`;
}

function txDeleteCard(d: TxDeletePayload) {
  return (
    `🗑️ <b>Excluir ${d.kind === "income" ? "receita" : "despesa"}?</b>\n\n${esc(d.description)} — <b>${brl(d.amountCents)}</b> (${dtFull(d.date)})\n\n` +
    "Ela deixa de contar no saldo e nos relatórios (o site mantém o registro no histórico de auditoria)."
  );
}

/** Botões do cartão. Transferências sem contas definidas mostram as contas para escolher. */
async function cardKeyboardFor(ctx: AppContext, user: AuthUser, p: { id: string; version: number }, payload: PendingPayload): Promise<InlineButton[][]> {
  if (payload.kind === "transfer" && (!payload.transfer.fromAccountId || !payload.transfer.toAccountId)) {
    const side = payload.transfer.fromAccountId ? "to" : "from";
    const other = side === "to" ? payload.transfer.fromAccountId : payload.transfer.toAccountId;
    const accounts = (await listAccounts(ctx.db, user, [user.id])).filter((a) => a.id !== other);
    return [
      ...accounts.slice(0, 8).map((a) => [{ text: `${side === "from" ? "De" : "Para"}: ${a.name}`, callback_data: `s:${p.id}:${side}:${a.id}` }]),
      [{ text: "✖️ Cancelar", callback_data: `x:${p.id}` }],
    ];
  }
  if (payload.kind === "tx_update" || payload.kind === "tx_delete") {
    return [[
      { text: payload.kind === "tx_delete" ? "🗑️ Excluir" : "✅ Confirmar", callback_data: `c:${p.id}:${p.version}` },
      { text: "✖️ Cancelar", callback_data: `x:${p.id}` },
    ]];
  }
  return cardKeyboard(p);
}

function cardKeyboard(p: { id: string; version: number }): InlineButton[][] {
  return [[
    { text: "✅ Confirmar", callback_data: `c:${p.id}:${p.version}` },
    { text: "✏️ Editar", callback_data: `e:${p.id}` },
    { text: "✖️ Cancelar", callback_data: `x:${p.id}` },
  ]];
}

async function cardText(ctx: AppContext, user: AuthUser, payload: PendingPayload) {
  switch (payload.kind) {
    case "transaction":
      return draftCard(ctx, user, payload.draft);
    case "goal":
      return goalCard(payload.goal);
    case "contribution":
      return contributionCard(ctx, user, payload.contribution);
    case "transfer":
      return transferCard(ctx, user, payload.transfer);
    case "tx_update":
      return txUpdateCard(payload.update);
    case "tx_delete":
      return txDeleteCard(payload.del);
    case "invoice_payment":
      // o Telegram não cria este rascunho (só o WhatsApp); texto neutro por segurança
      return `💳 <b>Marcar a fatura ${esc(payload.invoice.invoiceMonth)} como paga</b> — ${brl(payload.invoice.amountCents)}.\nDeseja confirmar?`;
  }
}

async function sendCard(ctx: AppContext, user: User, payload: PendingPayload) {
  const p = await createPending(ctx.db, user.id, user.chatId, payload);
  const sent = await ctx.telegram!.sendMessage(user.chatId, await cardText(ctx, user, payload), {
    reply_markup: { inline_keyboard: await cardKeyboardFor(ctx, user, p, payload) },
  });
  if (sent) await setPendingMessage(ctx.db, p.id, payload, sent.message_id);
}

async function proposeEntry(ctx: AppContext, user: User, draft: Draft) {
  await sendCard(ctx, user, { kind: "transaction", draft });
}

async function proposeGoal(ctx: AppContext, user: User, goal: { name: string; targetCents: number; deadline: string | null; scope: "individual" | "family" }) {
  await sendCard(ctx, user, { kind: "goal", goal });
}

async function proposeContribution(ctx: AppContext, user: User, c: { goalId: number; goalName: string; amountCents: number }) {
  await sendCard(ctx, user, { kind: "contribution", contribution: c });
}

async function startGoal(ctx: AppContext, user: User, name: string, targetCents: number | null, deadline: string | null) {
  if (!name) {
    await setConversation(ctx.db, user.id, { step: "goal_name" });
    await ctx.telegram!.sendMessage(user.chatId, "Vamos criar uma meta! Qual o nome dela? (ex.: Viagem de férias)");
    return;
  }
  if (!targetCents) {
    await setConversation(ctx.db, user.id, { step: "goal_amount", name });
    await ctx.telegram!.sendMessage(user.chatId, `Quanto você quer juntar para <b>${esc(name)}</b>?`);
    return;
  }
  await proposeGoal(ctx, user, { name, targetCents, deadline, scope: "individual" });
}

async function startContribution(ctx: AppContext, user: User, goalId: number | null, amountCents: number | null, withdraw: boolean, nctx?: NluContext) {
  const goals = (nctx ?? (await nluContext(ctx, user))).goals;
  if (!goalId) {
    if (!goals.length) {
      await ctx.telegram!.sendMessage(user.chatId, "Você ainda não tem metas. Envie <i>criar meta de 5 mil para viagem</i> para começar.");
      return;
    }
    await ctx.telegram!.sendMessage(user.chatId, "Em qual meta?", {
      reply_markup: { inline_keyboard: goals.slice(0, 8).map((g) => [{ text: g.name.slice(0, 40), callback_data: `gc:${g.id}` }]) },
    });
    return;
  }
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) {
    await ctx.telegram!.sendMessage(user.chatId, "Não encontrei essa meta entre as suas.");
    return;
  }
  if (!amountCents) {
    await setConversation(ctx.db, user.id, { step: "contrib_amount", goalId, goalName: goal.name, withdraw });
    await ctx.telegram!.sendMessage(user.chatId, `Quanto você quer ${withdraw ? "retirar de" : "guardar em"} <b>${esc(goal.name)}</b>?`);
    return;
  }
  await proposeContribution(ctx, user, { goalId, goalName: goal.name, amountCents: withdraw ? -amountCents : amountCents });
}

/** Aplica edição digitada. Retorna mensagem de erro ou null. */
function applyTextEdit(payload: PendingPayload, field: string, text: string): string | null {
  if (payload.kind === "transaction") {
    const d = payload.draft;
    if (field === "amount") {
      const c = parseAmountReply(text);
      if (!c) return "Valor inválido.";
      d.amountCents = c;
      d.amountText = text;
    } else if (field === "description") {
      const v = text.trim();
      if (!v || v.length > 160) return "A descrição precisa ter entre 1 e 160 caracteres.";
      d.description = v;
    } else if (field === "date") {
      const v = parseDateText(text, today());
      if (!v) return "Data inválida. Use <b>hoje</b>, <b>ontem</b> ou <b>dd/mm/aaaa</b>.";
      d.date = v;
      if (v > today()) d.status = "pending";
    }
    return null;
  }
  if (payload.kind === "goal") {
    if (field === "name") {
      const v = text.trim();
      if (v.length < 2 || v.length > 60) return "O nome precisa ter entre 2 e 60 caracteres.";
      payload.goal.name = v;
    } else if (field === "target") {
      const c = parseAmountReply(text);
      if (!c) return "Valor inválido.";
      payload.goal.targetCents = c;
    }
    return null;
  }
  if (payload.kind === "transfer") {
    if (field === "amount") {
      const c = parseAmountReply(text);
      if (!c) return "Valor inválido.";
      payload.transfer.amountCents = c;
    } else if (field === "date") {
      const v = parseDateText(text, today());
      if (!v || v > today()) return "Data inválida. Use <b>hoje</b>, <b>ontem</b> ou <b>dd/mm/aaaa</b> (não pode ser futura).";
      payload.transfer.date = v;
    }
    return null;
  }
  if (payload.kind === "contribution" && field === "amount") {
    const c = parseAmountReply(text);
    if (!c) return "Valor inválido.";
    payload.contribution.amountCents = payload.contribution.amountCents < 0 ? -c : c;
  }
  return null;
}

/** Salva a edição (nova versão) e reenvia o cartão; o cartão antigo deixa de valer. */
async function refreshCard(ctx: AppContext, user: User, p: Pending, payload: PendingPayload, messageId?: number) {
  const version = await updatePending(ctx.db, p.id, payload);
  if (!version) {
    await ctx.telegram!.sendMessage(user.chatId, "Esta operação não está mais disponível.");
    return;
  }
  const text = await cardText(ctx, user, payload);
  const kb = { inline_keyboard: await cardKeyboardFor(ctx, user, { id: p.id, version }, payload) };
  if (messageId) {
    await ctx.telegram!.editMessageText(user.chatId, messageId, text, { reply_markup: kb });
    return;
  }
  // edição digitada: cartão novo embaixo; o antigo é marcado como substituído
  if (payload.messageId) await ctx.telegram!.editMessageText(user.chatId, payload.messageId, "✏️ Resumo atualizado — veja abaixo.").catch(() => {});
  const sent = await ctx.telegram!.sendMessage(user.chatId, text, { reply_markup: kb });
  if (sent) await setPendingMessage(ctx.db, p.id, payload, sent.message_id);
}

function editMenu(p: Pending): InlineButton[][] {
  const id = p.id;
  if (p.payload.kind === "transaction") {
    const d = p.payload.draft;
    return [
      [{ text: "💲 Valor", callback_data: `f:${id}:amount` }, { text: "📝 Descrição", callback_data: `f:${id}:description` }],
      [{ text: "📅 Data", callback_data: `f:${id}:date` }, { text: "📂 Categoria", callback_data: `f:${id}:category` }],
      [{ text: "💳 Pagamento", callback_data: `f:${id}:payment` }, { text: "🏦 Conta", callback_data: `f:${id}:account` }],
      [
        { text: d.kind === "income" ? "↔️ É despesa" : "↔️ É receita", callback_data: `s:${id}:kind:${d.kind === "income" ? "expense" : "income"}` },
        { text: d.status === "pending" ? "📌 Já foi pago" : "📌 Ainda a pagar", callback_data: `s:${id}:status:${d.status === "pending" ? "paid" : "pending"}` },
      ],
      [{ text: "⬅️ Voltar", callback_data: `b:${id}` }],
    ];
  }
  if (p.payload.kind === "goal") {
    return [
      [{ text: "📝 Nome", callback_data: `f:${id}:name` }, { text: "💲 Valor", callback_data: `f:${id}:target` }],
      [{ text: p.payload.goal.scope === "family" ? "👤 Tornar individual" : "👨‍👩‍👦‍👦 Tornar da família", callback_data: `s:${id}:scope:${p.payload.goal.scope === "family" ? "individual" : "family"}` }],
      [{ text: "⬅️ Voltar", callback_data: `b:${id}` }],
    ];
  }
  if (p.payload.kind === "transfer") {
    return [
      [{ text: "💲 Valor", callback_data: `f:${id}:amount` }, { text: "📅 Data", callback_data: `f:${id}:date` }],
      [{ text: "↗️ Conta de origem", callback_data: `f:${id}:from` }, { text: "↘️ Conta de destino", callback_data: `f:${id}:to` }],
      [{ text: "⬅️ Voltar", callback_data: `b:${id}` }],
    ];
  }
  return [[{ text: "💲 Valor", callback_data: `f:${id}:amount` }], [{ text: "⬅️ Voltar", callback_data: `b:${id}` }]];
}

// =========================== botões ===========================

/**
 * Todo clique recebe answerCallbackQuery — mesmo se algo falhar no meio —
 * para o Telegram não ficar com o indicador de carregamento girando.
 */
async function onCallback(ctx: AppContext, cb: TgCallbackQuery, op: string) {
  const real = ctx.telegram!;
  let answered = false;
  const tracked = {
    ...real,
    answerCallbackQuery: async (id: string, text?: string) => {
      answered = true;
      await real.answerCallbackQuery(id, text);
    },
  };
  try {
    await onCallbackInner({ ...ctx, telegram: tracked }, cb, op);
  } finally {
    if (!answered) await real.answerCallbackQuery(cb.id).catch(() => {});
  }
}

async function onCallbackInner(ctx: AppContext, cb: TgCallbackQuery, op: string) {
  const tg = ctx.telegram!;
  const user = await userByTelegramId(ctx.db, cb.from.id);
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  if (!user || !chatId || !messageId || chatId !== user.chatId) {
    await tg.answerCallbackQuery(cb.id, "Conecte sua conta para usar este botão.");
    return;
  }
  const parts = (cb.data ?? "").split(":");
  const [action, id] = parts;
  ctx.log.info("telegram.botao", { op, user_id: user.id, action });
  if (!messageLimiter.take(`u${user.id}`)) {
    await tg.answerCallbackQuery(cb.id, "Muitas ações em pouco tempo. Aguarde um minuto.");
    return;
  }

  // ---- ações sem rascunho ----
  if (action === "x" && id === "none") {
    await tg.editMessageText(chatId, messageId, "Ok, nada foi alterado.");
    return tg.answerCallbackQuery(cb.id);
  }
  if (action === "u" && id === "ask") {
    await tg.sendMessage(user.chatId, "Desconectar este Telegram da sua conta do Luna Finance?", {
      reply_markup: { inline_keyboard: [[{ text: "Sim, desconectar", callback_data: "u:yes" }, { text: "Não", callback_data: "x:none" }]] },
    });
    return tg.answerCallbackQuery(cb.id);
  }
  if (action === "u" && id === "yes") {
    await unlinkTelegram(ctx.db, user.id, "telegram");
    await tg.editMessageText(chatId, messageId, "Pronto, este Telegram foi desconectado. Para voltar, gere um novo código no site.");
    return tg.answerCallbackQuery(cb.id);
  }
  if (action === "n") return toggleNotification(ctx, user, cb, id, messageId);
  if (action === "p" || action === "pc") return payBill(ctx, user, cb, Number(id), action === "pc", messageId);
  if (action === "r") {
    const q = reportQuery(id);
    await tg.answerCallbackQuery(cb.id);
    if (q) await answer(ctx, user, q);
    return;
  }
  if (action === "menu") {
    await clearConversation(ctx.db, user.id);
    await tg.answerCallbackQuery(cb.id);
    return sendMenu(ctx, user, messageId);
  }
  if (action === "cfg") {
    await tg.answerCallbackQuery(cb.id);
    return sendSettings(ctx, user);
  }
  if (action === "w" && (id === "expense" || id === "income" || id === "save")) {
    await tg.answerCallbackQuery(cb.id);
    return startWizard(ctx, user, id);
  }
  if (action === "wc" || action === "wd" || action === "ws") {
    // botões de etapa: só valem se o fluxo estiver exatamente nessa etapa (cliques repetidos/antigos não fazem nada)
    const state = await getConversation(ctx.db, user.id);
    const expected = action === "wc" ? "category" : action === "wd" ? "description" : "destination";
    if (state?.step !== "wiz" || state.stage !== expected) {
      await tg.answerCallbackQuery(cb.id, "Essa etapa já passou. Use o menu para começar de novo.");
      return;
    }
    await tg.answerCallbackQuery(cb.id);
    if (action === "wc") {
      const cat = (await listCategories(ctx.db)).find((c) => c.id === Number(id) && c.kind === state.flow);
      if (!cat) return;
      return wizardCategory(ctx, user, state, cat.id);
    }
    if (action === "wd") {
      await clearConversation(ctx.db, user.id);
      const cat = (await listCategories(ctx.db)).find((c) => c.id === state.categoryId);
      return proposeWizardEntry(ctx, user, "expense", state.amountCents!, state.categoryId ?? null, cat?.name ?? "Despesa");
    }
    return wizardDestination(ctx, user, state, id);
  }
  if (action === "q") {
    await tg.answerCallbackQuery(cb.id);
    if (id === "help") return sendHelp(ctx, user);
    const q = quickQuery(id);
    if (q) await answer(ctx, user, q);
    return;
  }
  if (action === "m") {
    await tg.answerCallbackQuery(cb.id);
    return showManageMenu(ctx, user, Number(id));
  }
  if (action === "mf") {
    await tg.answerCallbackQuery(cb.id);
    return startTxEdit(ctx, user, Number(id), parts[2]);
  }
  if (action === "mc") {
    await tg.answerCallbackQuery(cb.id);
    return proposeTxUpdate(ctx, user, Number(id), "category", parts[2]);
  }
  if (action === "md") {
    await tg.answerCallbackQuery(cb.id);
    return proposeTxDelete(ctx, user, Number(id));
  }
  if (action === "g") {
    await tg.answerCallbackQuery(cb.id);
    return answer(ctx, user, { q: "goal", goalId: Number(id) });
  }
  if (action === "gc") {
    await tg.answerCallbackQuery(cb.id);
    return startContribution(ctx, user, Number(id), null, false);
  }
  if (action === "gn") {
    await tg.answerCallbackQuery(cb.id);
    return startGoal(ctx, user, "", null, null);
  }
  if (action === "gd") {
    const state = await getConversation(ctx.db, user.id);
    await tg.answerCallbackQuery(cb.id);
    if (state?.step !== "goal_deadline") return;
    await clearConversation(ctx.db, user.id);
    return proposeGoal(ctx, user, { name: state.name, targetCents: state.targetCents, deadline: null, scope: "individual" });
  }

  // ---- ações sobre um rascunho ----
  const p = await getPending(ctx.db, id);
  const version = action === "c" ? Number(parts[2]) : undefined;
  const problem = pendingProblem(p, user.id, version);
  if (problem) {
    await tg.answerCallbackQuery(cb.id, problem);
    return;
  }
  const pending = p!;
  const payload = pending.payload;

  switch (action) {
    case "x": {
      await cancelPending(ctx.db, pending.id, user.id);
      await clearConversation(ctx.db, user.id);
      await tg.editMessageText(chatId, messageId, "Cancelado. Nada foi registrado.");
      return tg.answerCallbackQuery(cb.id);
    }
    case "e":
      await tg.editMessageText(chatId, messageId, (await cardText(ctx, user, payload)).replace("\nDeseja confirmar?", "\nO que você quer alterar?").replace("\nDeseja criar?", "\nO que você quer alterar?"), {
        reply_markup: { inline_keyboard: editMenu(pending) },
      });
      return tg.answerCallbackQuery(cb.id);
    case "b":
      await tg.editMessageText(chatId, messageId, await cardText(ctx, user, payload), { reply_markup: { inline_keyboard: cardKeyboard(pending) } });
      return tg.answerCallbackQuery(cb.id);
    case "f":
      return editField(ctx, user, cb, pending, parts[2], messageId);
    case "k":
      if (parts[2] === "transfer" && payload.kind === "transaction") {
        await cancelPending(ctx.db, pending.id, user.id);
        await tg.editMessageText(chatId, messageId, "Ok, vamos registrar como transferência entre suas contas.");
        await tg.answerCallbackQuery(cb.id);
        return startTransfer(ctx, user, payload.draft.amountCents, null, null, payload.draft.date);
      }
      return setField(ctx, user, cb, pending, "kind", parts[2], messageId);
    case "s":
      return setField(ctx, user, cb, pending, parts[2], parts[3], messageId);
    case "c":
      return confirm(ctx, user, cb, pending, messageId, op);
  }
  await tg.answerCallbackQuery(cb.id);
}

async function editField(ctx: AppContext, user: User, cb: TgCallbackQuery, p: Pending, field: string, messageId: number) {
  const tg = ctx.telegram!;
  const id = p.id;
  const prompts: Record<string, string> = {
    amount: "Envie o novo valor (ex.: 45,90).",
    description: "Envie a nova descrição.",
    date: "Envie a nova data: <b>hoje</b>, <b>ontem</b> ou <b>dd/mm/aaaa</b>.",
    name: "Envie o novo nome da meta.",
    target: "Envie o novo valor da meta.",
  };
  if (prompts[field]) {
    await setConversation(ctx.db, user.id, { step: "edit_field", pendingId: id, field: field as "amount" });
    await tg.answerCallbackQuery(cb.id);
    await tg.sendMessage(user.chatId, prompts[field]);
    return;
  }
  if (p.payload.kind === "transfer" && (field === "from" || field === "to")) {
    const t = p.payload.transfer;
    const other = field === "from" ? t.toAccountId : t.fromAccountId;
    const accs = (await listAccounts(ctx.db, user, [user.id])).filter((a) => a.id !== other);
    const rows = accs.map((a) => [{ text: a.name, callback_data: `s:${id}:${field}:${a.id}` }]);
    rows.push([{ text: "⬅️ Voltar", callback_data: `e:${id}` }]);
    await tg.editMessageText(user.chatId, messageId, field === "from" ? "De qual conta sai o dinheiro?" : "Para qual conta vai o dinheiro?", { reply_markup: { inline_keyboard: rows } });
    return tg.answerCallbackQuery(cb.id);
  }
  if (p.payload.kind !== "transaction") return tg.answerCallbackQuery(cb.id);
  const d = p.payload.draft;
  let rows: InlineButton[][] = [];
  if (field === "category") {
    const cats = (await listCategories(ctx.db)).filter((c) => c.kind === d.kind);
    for (let i = 0; i < cats.length; i += 2) rows.push(cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `s:${id}:category:${c.id}` })));
  } else if (field === "payment") {
    const opts = PAYMENT_METHODS.map((m) => ({ text: PAYMENT_LABELS[m], callback_data: `s:${id}:payment:${m}` }));
    for (let i = 0; i < opts.length; i += 2) rows.push(opts.slice(i, i + 2));
    rows.push([{ text: "Não informar", callback_data: `s:${id}:payment:none` }]);
  } else if (field === "account") {
    const accs = await listAccounts(ctx.db, user, [user.id]);
    rows = accs.map((a) => [{ text: a.name, callback_data: `s:${id}:account:${a.id}` }]);
  }
  rows.push([{ text: "⬅️ Voltar", callback_data: `e:${id}` }]);
  await tg.editMessageText(user.chatId, messageId, field === "category" ? "Escolha a categoria:" : field === "payment" ? "Forma de pagamento:" : "Escolha a conta:", {
    reply_markup: { inline_keyboard: rows },
  });
  await tg.answerCallbackQuery(cb.id);
}

async function setField(ctx: AppContext, user: User, cb: TgCallbackQuery, p: Pending, field: string, value: string, messageId: number) {
  const payload = p.payload;
  if (payload.kind === "transfer" && (field === "from" || field === "to")) {
    const acc = (await listAccounts(ctx.db, user, [user.id])).find((a) => a.id === Number(value));
    if (!acc) return ctx.telegram!.answerCallbackQuery(cb.id, "Conta inválida.");
    const other = field === "from" ? payload.transfer.toAccountId : payload.transfer.fromAccountId;
    if (other === acc.id) return ctx.telegram!.answerCallbackQuery(cb.id, "Origem e destino precisam ser contas diferentes.");
    if (field === "from") payload.transfer.fromAccountId = acc.id;
    else payload.transfer.toAccountId = acc.id;
  } else if (payload.kind === "goal" && field === "scope") {
    if (value === "family" && user.family_access === "none") {
      await ctx.telegram!.answerCallbackQuery(cb.id, "Sua conta não participa das metas da família.");
      return;
    }
    payload.goal.scope = value === "family" ? "family" : "individual";
  } else if (payload.kind === "transaction") {
    const d = payload.draft;
    if (field === "kind" && (value === "income" || value === "expense")) {
      if (d.kind !== value) {
        d.kind = value;
        const cats = await listCategories(ctx.db);
        d.categoryId = cats.find((c) => c.kind === value && /^outr/i.test(c.name))?.id ?? null;
        if (value === "income") d.installments = null;
      }
    } else if (field === "status" && (value === "paid" || value === "pending")) {
      d.status = value;
      if (value === "paid" && d.date > today()) d.date = today();
    } else if (field === "category") {
      const c = (await listCategories(ctx.db)).find((x) => x.id === Number(value) && x.kind === d.kind);
      if (c) d.categoryId = c.id;
    } else if (field === "payment") {
      d.paymentMethod = PAYMENT_METHODS.includes(value as PaymentMethod) ? (value as PaymentMethod) : null;
    } else if (field === "account") {
      const a = (await listAccounts(ctx.db, user, [user.id])).find((x) => x.id === Number(value));
      if (a) d.accountId = a.id;
    }
  }
  await refreshCard(ctx, user, p, payload, messageId);
  await ctx.telegram!.answerCallbackQuery(cb.id);
}

/** Texto de confirmação do Telegram a partir do que foi efetivamente gravado. */
function confirmedText(r: ExecResult): string {
  switch (r.kind) {
    case "transaction": {
      const d = r.draft;
      return `✅ <b>Registrado no Luna Finance</b>\n${d.kind === "income" ? "Receita" : "Despesa"}: ${esc(d.description)} — <b>${brl(d.amountCents)}</b>` +
        `${r.transactions.length > 1 ? ` em ${r.transactions.length} parcelas` : ""} (${dateLabel(d.date)}).\nJá aparece no site; você pode editar por lá.`;
    }
    case "goal":
      return `✅ <b>Meta criada:</b> ${esc(r.goal.name)} — ${brl(r.goal.targetCents)}.\nEnvie <i>guardei 200 na meta ${esc(r.goal.name.toLowerCase())}</i> para registrar contribuições.`;
    case "contribution":
      return `✅ <b>${r.amountCents < 0 ? "Retirada registrada" : "Contribuição registrada"}</b> em ${esc(r.goal.name)}.\n` +
        `Agora: ${brl(r.goal.savedCents)} de ${brl(r.goal.targetCents)} (${Math.round(r.goal.percent)}%)${r.goal.achievedAt ? " — meta atingida! 🎉" : ""}.`;
    case "transfer":
      return `✅ <b>Transferência registrada</b>\n${esc(r.transfer.fromAccountName)} → ${esc(r.transfer.toAccountName)}: <b>${brl(r.transfer.amountCents)}</b> (${dateLabel(r.transfer.date)}).\nO saldo de cada conta já foi atualizado.`;
    case "tx_update":
      return `✅ <b>Lançamento alterado</b>\n${esc(r.transaction.description)} — ${brl(r.transaction.amountCents)} (${dtFull(r.transaction.date)}).`;
    case "tx_delete":
      return `🗑️ <b>Excluído:</b> ${esc(r.deleted.description)} — ${brl(r.deleted.amountCents)}.`;
    case "invoice_payment":
      return `✅ <b>Fatura ${esc(r.payment.invoiceMonth)} marcada como paga.</b>`;
  }
}

async function confirm(ctx: AppContext, user: User, cb: TgCallbackQuery, p: Pending, messageId: number, op: string) {
  const tg = ctx.telegram!;
  if (p.payload.kind === "transfer" && (!p.payload.transfer.fromAccountId || !p.payload.transfer.toAccountId)) {
    await tg.answerCallbackQuery(cb.id, "Escolha as contas de origem e destino antes de confirmar.");
    return;
  }
  let result;
  try {
    result = await confirmPending(ctx.db, p.id, user.id, p.version, async (q, locked) => {
      // a gravação é a mesma de todos os canais; aqui só formatamos a resposta
      const { resultId, result: r } = await executePending(q, user, locked.payload, "telegram");
      return { resultId, value: confirmedText(r) };
    });
  } catch (err) {
    // NADA foi gravado (a transação do banco foi desfeita) e a ação segue pendente.
    const userMsg = err instanceof HttpError ? err.message : "Não consegui registrar agora. Nada foi salvo — tente confirmar de novo.";
    ctx.log.warn("telegram.confirmacao_falhou", { op, user_id: user.id, err: (err as Error).message.slice(0, 160) });
    await tg.answerCallbackQuery(cb.id, userMsg.slice(0, 190)).catch(() => {});
    if (!(err instanceof HttpError)) await tg.sendMessage(user.chatId, `⚠️ ${esc(userMsg)}`).catch(() => {});
    return;
  }
  if (!result.ok) {
    await tg.answerCallbackQuery(cb.id, result.reason);
    return;
  }
  ctx.log.info("telegram.confirmado", { op, user_id: user.id, kind: p.kind });
  // a gravação já foi confirmada pelo banco; agora sim avisamos — com os próximos passos
  const flow = "flow" in p.payload ? p.payload.flow : undefined;
  let text = result.value;
  if (flow === "save") {
    const tot = await savingsTotal(ctx, user).catch(() => null);
    if (tot) text += `\n\n📈 Total separado: ${brl(tot.goalsCents)} em metas + ${brl(tot.reservesCents)} em contas de reserva.\n<i>Economia não é receita: o dinheiro só mudou de lugar.</i>`;
  }
  const next: InlineButton[][] = flow
    ? [[{ text: "➕ Registrar outra", callback_data: `w:${flow}` }, MENU_BUTTON]]
    : [[{ text: "💸 Gastei", callback_data: "w:expense" }, { text: "💰 Recebi", callback_data: "w:income" }], [MENU_BUTTON]];
  try {
    await tg.editMessageText(user.chatId, messageId, text, { reply_markup: { inline_keyboard: next } });
  } catch (err) {
    ctx.log.warn("telegram.aviso_pos_confirmacao_falhou", { op, err: (err as Error).message.slice(0, 120) });
    await tg.sendMessage(user.chatId, text, { reply_markup: { inline_keyboard: next } }).catch(() => {});
  }
  await tg.answerCallbackQuery(cb.id, "Registrado!").catch(() => {});
}

async function payBill(ctx: AppContext, user: User, cb: TgCallbackQuery, txId: number, confirmed: boolean, messageId: number) {
  const tg = ctx.telegram!;
  const [tx] = Number.isInteger(txId) ? await getTransactions(ctx.db, [txId]) : [];
  if (!tx || tx.userId !== user.id) {
    await tg.answerCallbackQuery(cb.id, "Só quem é responsável pela conta pode marcá-la como paga.");
    return;
  }
  if (tx.status === "paid") {
    await tg.answerCallbackQuery(cb.id, "Esta conta já está paga. ✅");
    return;
  }
  if (!confirmed) {
    await tg.sendMessage(user.chatId, `Confirmar o pagamento de <b>${esc(tx.description)}</b> (${brl(tx.amountCents)}) hoje, ${dtFull(today())}?`, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Confirmar pagamento", callback_data: `pc:${tx.id}` }, { text: "Agora não", callback_data: "x:none" }]] },
    });
    await tg.answerCallbackQuery(cb.id);
    return;
  }
  // markPaid é idempotente: um segundo clique encontra a conta já paga (checado acima)
  await markPaid(ctx.db, user, tx.id, today(), "telegram");
  await tg.editMessageText(user.chatId, messageId, `✅ <b>${esc(tx.description)}</b> marcada como paga (${brl(tx.amountCents)}).`);
  await tg.answerCallbackQuery(cb.id, "Pagamento registrado!");
}

// =========================== transferências ===========================

async function startTransfer(ctx: AppContext, user: User, amountCents: number | null, fromAccountId: number | null, toAccountId: number | null, date: string) {
  const accounts = await listAccounts(ctx.db, user, [user.id]);
  if (accounts.length < 2) {
    await ctx.telegram!.sendMessage(
      user.chatId,
      "Para transferir entre contas você precisa ter pelo menos duas contas cadastradas (ex.: corrente e poupança).\nCrie no site em <b>Configurações → Suas contas</b>.",
    );
    return;
  }
  if (!amountCents) {
    await setConversation(ctx.db, user.id, { step: "transfer_amount", fromAccountId, toAccountId, date });
    await ctx.telegram!.sendMessage(user.chatId, "Qual o valor da transferência?");
    return;
  }
  await sendCard(ctx, user, { kind: "transfer", transfer: { amountCents, fromAccountId, toAccountId: toAccountId === fromAccountId ? null : toAccountId, date: date > today() ? today() : date } });
}

// =========================== gerenciar lançamentos já registrados ===========================

async function ownTransaction(ctx: AppContext, user: User, txId: number) {
  if (!Number.isInteger(txId) || txId <= 0) return null;
  const [tx] = await getTransactions(ctx.db, [txId]);
  const { rows } = await ctx.db.query<{ deleted: boolean }>("SELECT deleted_at IS NOT NULL AS deleted FROM transactions WHERE id = $1", [txId]);
  // só o próprio usuário, e só lançamentos ativos
  return tx && tx.userId === user.id && !rows[0]?.deleted ? tx : null;
}

async function manageLast(ctx: AppContext, user: User, action: "edit" | "delete", kind: "income" | "expense" | null) {
  const { rows } = await ctx.db.query<{ id: number }>(
    `SELECT id FROM transactions WHERE user_id = $1 AND deleted_at IS NULL ${kind ? "AND kind = $2" : ""}
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    kind ? [user.id, kind] : [user.id],
  );
  if (!rows[0]) {
    await ctx.telegram!.sendMessage(user.chatId, "Não encontrei lançamentos seus para alterar.");
    return;
  }
  if (action === "delete") return proposeTxDelete(ctx, user, rows[0].id);
  return showManageMenu(ctx, user, rows[0].id);
}

async function showManageMenu(ctx: AppContext, user: User, txId: number) {
  const tx = await ownTransaction(ctx, user, txId);
  if (!tx) {
    await ctx.telegram!.sendMessage(user.chatId, "Esse lançamento não está disponível (ou não é seu).");
    return;
  }
  await ctx.telegram!.sendMessage(
    user.chatId,
    `🧾 <b>${esc(tx.description)}</b>\n${tx.kind === "income" ? "Receita" : "Despesa"} de <b>${brl(tx.amountCents)}</b> · ${dtFull(tx.date)}\n` +
      `Categoria: ${esc(tx.categoryName ?? "Sem categoria")}${tx.paymentMethod ? ` · ${PAYMENT_LABELS[tx.paymentMethod]}` : ""}\n` +
      (tx.installmentNumber ? `Parcela ${tx.installmentNumber}/${tx.installmentTotal} (só esta será alterada)\n` : "") +
      "\nO que deseja fazer?",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💲 Valor", callback_data: `mf:${tx.id}:amount` }, { text: "📝 Descrição", callback_data: `mf:${tx.id}:description` }],
          [{ text: "📅 Data", callback_data: `mf:${tx.id}:date` }, { text: "📂 Categoria", callback_data: `mf:${tx.id}:category` }],
          [{ text: "🗑️ Excluir", callback_data: `md:${tx.id}` }, { text: "Fechar", callback_data: "x:none" }],
        ],
      },
    },
  );
}

async function startTxEdit(ctx: AppContext, user: User, txId: number, field: string) {
  const tx = await ownTransaction(ctx, user, txId);
  if (!tx) {
    await ctx.telegram!.sendMessage(user.chatId, "Esse lançamento não está disponível (ou não é seu).");
    return;
  }
  if (field === "category") {
    const cats = (await listCategories(ctx.db)).filter((c) => c.kind === tx.kind);
    const rows: InlineButton[][] = [];
    for (let i = 0; i < cats.length; i += 2) rows.push(cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `mc:${tx.id}:${c.id}` })));
    await ctx.telegram!.sendMessage(user.chatId, `Nova categoria para <b>${esc(tx.description)}</b>:`, { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (field !== "amount" && field !== "description" && field !== "date") return;
  await setConversation(ctx.db, user.id, { step: "edit_tx", txId, field });
  const prompt = { amount: "Envie o novo valor (ex.: 45,90).", description: "Envie a nova descrição.", date: "Envie a nova data: <b>hoje</b>, <b>ontem</b> ou <b>dd/mm/aaaa</b>." }[field];
  await ctx.telegram!.sendMessage(user.chatId, prompt);
}

async function proposeTxUpdate(ctx: AppContext, user: User, txId: number, field: "amount" | "description" | "date" | "category", value: string) {
  const tg = ctx.telegram!;
  const tx = await ownTransaction(ctx, user, txId);
  if (!tx) {
    await tg.sendMessage(user.chatId, "Esse lançamento não está disponível (ou não é seu).");
    return;
  }
  let patch: Record<string, unknown>;
  let fromLabel: string;
  let toLabel: string;
  if (field === "amount") {
    const c = parseAmountReply(value);
    if (!c) return void (await tg.sendMessage(user.chatId, "Valor inválido. Nada foi alterado."));
    patch = { amountCents: c };
    fromLabel = brl(tx.amountCents);
    toLabel = brl(c);
  } else if (field === "description") {
    const v = value.trim();
    if (!v || v.length > 160) return void (await tg.sendMessage(user.chatId, "A descrição precisa ter entre 1 e 160 caracteres. Nada foi alterado."));
    patch = { description: v };
    fromLabel = tx.description;
    toLabel = v;
  } else if (field === "date") {
    const d = parseDateText(value, today());
    if (!d) return void (await tg.sendMessage(user.chatId, "Data inválida. Nada foi alterado."));
    patch = { date: d };
    fromLabel = dtFull(tx.date);
    toLabel = dtFull(d);
  } else {
    const cat = (await listCategories(ctx.db)).find((c) => c.id === Number(value) && c.kind === tx.kind);
    if (!cat) return void (await tg.sendMessage(user.chatId, "Categoria inválida. Nada foi alterado."));
    patch = { categoryId: cat.id };
    fromLabel = tx.categoryName ?? "Sem categoria";
    toLabel = cat.name;
  }
  await sendCard(ctx, user, { kind: "tx_update", update: { txId, description: tx.description, field, fromLabel, toLabel, patch } });
}

async function proposeTxDelete(ctx: AppContext, user: User, txId: number) {
  const tx = await ownTransaction(ctx, user, txId);
  if (!tx) {
    await ctx.telegram!.sendMessage(user.chatId, "Esse lançamento não está disponível (ou não é seu).");
    return;
  }
  await sendCard(ctx, user, { kind: "tx_delete", del: { txId, description: tx.description, amountCents: tx.amountCents, date: tx.date, kind: tx.kind } });
}

// =========================== consultas ===========================

export async function answer(ctx: AppContext, user: User, query: Query) {
  const r = await buildReply(ctx.db, user, query);
  if (["spend", "summary", "by_category", "top", "list"].includes(query.q)) await saveLastQuery(ctx.db, user.id, query);
  await ctx.telegram!.sendMessage(user.chatId, r.text, r.keyboard?.length ? { reply_markup: { inline_keyboard: r.keyboard } } : {});
}

// =========================== configurações ===========================

const NOTIFY_FIELDS: Array<[string, string, string]> = [
  ["overdue", "notify_overdue", "Contas atrasadas"],
  ["daily", "notify_daily", "Resumo diário (20h)"],
  ["weekly", "notify_weekly", "Resumo semanal (segunda)"],
  ["goals", "notify_goals", "Metas quase atingidas"],
  ["anomaly", "notify_anomaly", "Gastos fora do padrão"],
];

async function settingsKeyboard(ctx: AppContext, userId: number): Promise<InlineButton[][]> {
  const { rows } = await ctx.db.query<Record<string, unknown>>(
    "SELECT notify_due_days, notify_overdue, notify_daily, notify_weekly, notify_goals, notify_anomaly FROM users WHERE id = $1",
    [userId],
  );
  const u = rows[0];
  const kb: InlineButton[][] = NOTIFY_FIELDS.map(([key, col, label]) => [{ text: `${u[col] ? "✅" : "⬜️"} ${label}`, callback_data: `n:${key}` }]);
  kb.unshift([{ text: `📅 Lembrete de vencimento: ${u.notify_due_days ? `${u.notify_due_days} dia(s) antes` : "desligado"}`, callback_data: "n:due" }]);
  kb.push([{ text: "📊 Relatórios", callback_data: "r:month" }, { text: "🔌 Desconectar Telegram", callback_data: "u:ask" }]);
  return kb;
}

async function sendSettings(ctx: AppContext, user: User) {
  await ctx.telegram!.sendMessage(
    user.chatId,
    `⚙️ <b>Configurações</b>\nConectado como <b>${esc(user.name)}</b>.\nAvisos automáticos chegam entre 9h e 21h. Toque para ligar ou desligar:`,
    { reply_markup: { inline_keyboard: await settingsKeyboard(ctx, user.id) } },
  );
}

async function toggleNotification(ctx: AppContext, user: User, cb: TgCallbackQuery, key: string, messageId: number) {
  if (key === "due") {
    await ctx.db.query(
      `UPDATE users SET notify_due_days = CASE notify_due_days WHEN 0 THEN 1 WHEN 1 THEN 3 WHEN 3 THEN 5 WHEN 5 THEN 7 ELSE 0 END WHERE id = $1`,
      [user.id],
    );
  } else {
    const field = NOTIFY_FIELDS.find(([k]) => k === key);
    if (!field) return ctx.telegram!.answerCallbackQuery(cb.id);
    await ctx.db.query(`UPDATE users SET ${field[1]} = NOT ${field[1]} WHERE id = $1`, [user.id]);
  }
  await ctx.telegram!.editMessageText(user.chatId, messageId, `⚙️ <b>Configurações</b>\nConectado como <b>${esc(user.name)}</b>.\nToque para ligar ou desligar:`, {
    reply_markup: { inline_keyboard: await settingsKeyboard(ctx, user.id) },
  });
  await ctx.telegram!.answerCallbackQuery(cb.id, "Preferência salva");
}

export { TelegramError };
