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
import { createTransactionWith, getTransactions, markPaid, PAYMENT_LABELS, PAYMENT_METHODS, type PaymentMethod } from "../services/transactions.js";
import type { InlineButton } from "./api.js";
import { TelegramError } from "./api.js";
import { findPossibleDuplicate } from "./data.js";
import { brl, dtFull, esc } from "./format.js";
import { consumeLinkCode, unlinkTelegram, userByTelegramId } from "./linking.js";
import { interpret, monthPeriod, parseAmountReply, type Intent, type NluContext, type Query } from "./nlu.js";
import type { Draft } from "./parser.js";
import { parseDateText } from "./parser.js";
import { buildReply, dateLabel, REPORT_MENU, reportQuery } from "./replies.js";
import {
  cancelAllPending, cancelPending, clearConversation, confirmPending, createPending, getConversation, getPending, pendingProblem,
  setConversation, setPendingMessage, updatePending, type ConvState, type Pending, type PendingPayload,
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
    ctx.log.error("telegram.update_erro", { op, attempt, err: msg.slice(0, 200) });
    await ctx.db.query("UPDATE telegram_updates SET status = 'failed' WHERE update_id = $1", [update.update_id]).catch(() => {});
    if (attempt < MAX_ATTEMPTS) throw new RetryableError(msg);
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

async function sendHelp(ctx: AppContext, user: User) {
  await ctx.telegram!.sendMessage(
    user.chatId,
    `Oi, ${esc(user.name.split(" ")[0])}! Eu registro e consulto suas finanças no Luna Finance.\n\n` +
      "<b>Registrar</b> (sempre peço confirmação)\n" +
      "• <i>Gastei 45 reais no almoço</i>\n• <i>Paguei 250 de mercado no Pix</i>\n• <i>Recebi 2.500 de salário</i>\n" +
      "• <i>Conta de internet de 120 para dia 20</i>\n• <i>Comprei um celular de 2.400 em 12x</i>\n\n" +
      "<b>Perguntar</b>\n• <i>Quanto gastei este mês?</i>\n• <i>Quanto gastei com alimentação?</i>\n• <i>Compare meus gastos com o mês anterior</i>\n\n" +
      "<b>Metas</b>\n• <i>Criar meta de 10 mil para viagem até 12/2027</i>\n• <i>Guardei 300 na meta viagem</i>\n\n" +
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
  let intent: Intent = interpret(text, nctx);

  // IA só entra quando as regras não resolveram (ou para explicações)
  const wantsExplanation = /\b(por que|porque|explique|explica|analise|analisa|dica|padr[aã]o|tend[eê]ncia)\b/i.test(text);
  if (ctx.ai && (intent.type === "unknown" || wantsExplanation || (intent.type === "incomplete" && intent.missing.includes("kind")))) {
    const r = await ctx.ai.respond(text, { db: ctx.db, user, today: nctx.today, categories: nctx.categories, accounts: nctx.accounts, goals: nctx.goals });
    if (r.type === "text") {
      await ctx.telegram!.sendMessage(user.chatId, esc(r.text) + "\n\n<i>Resposta gerada com IA a partir dos seus dados.</i>");
      return;
    }
    if (r.type === "proposal") intent = r.intent;
  }

  switch (intent.type) {
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

function cardKeyboard(p: { id: string; version: number }): InlineButton[][] {
  return [[
    { text: "✅ Confirmar", callback_data: `c:${p.id}:${p.version}` },
    { text: "✏️ Editar", callback_data: `e:${p.id}` },
    { text: "✖️ Cancelar", callback_data: `x:${p.id}` },
  ]];
}

async function cardText(ctx: AppContext, user: AuthUser, payload: PendingPayload) {
  if (payload.kind === "transaction") return draftCard(ctx, user, payload.draft);
  if (payload.kind === "goal") return goalCard(payload.goal);
  return contributionCard(ctx, user, payload.contribution);
}

async function sendCard(ctx: AppContext, user: User, payload: PendingPayload) {
  const p = await createPending(ctx.db, user.id, user.chatId, payload);
  const sent = await ctx.telegram!.sendMessage(user.chatId, await cardText(ctx, user, payload), { reply_markup: { inline_keyboard: cardKeyboard(p) } });
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
  if (field === "amount") {
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
  const kb = { inline_keyboard: cardKeyboard({ id: p.id, version }) };
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
  return [[{ text: "💲 Valor", callback_data: `f:${id}:amount` }], [{ text: "⬅️ Voltar", callback_data: `b:${id}` }]];
}

// =========================== botões ===========================

async function onCallback(ctx: AppContext, cb: TgCallbackQuery, op: string) {
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
    case "s":
    case "k":
      return setField(ctx, user, cb, pending, action === "k" ? "kind" : parts[2], action === "k" ? parts[2] : parts[3], messageId);
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
  if (payload.kind === "goal" && field === "scope") {
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

async function confirm(ctx: AppContext, user: User, cb: TgCallbackQuery, p: Pending, messageId: number, op: string) {
  const tg = ctx.telegram!;
  let result;
  try {
    result = await confirmPending(ctx.db, p.id, user.id, p.version, async (q, locked) => {
      const pl = locked.payload;
      if (pl.kind === "transaction") {
        const d = pl.draft;
        const created = await createTransactionWith(
          q,
          user,
          {
            kind: d.kind, amountCents: d.amountCents, description: d.description, date: d.date, status: d.status,
            categoryId: d.categoryId, installments: d.installments, paymentMethod: d.paymentMethod, accountId: d.accountId,
          },
          "telegram",
        );
        return {
          resultId: created[0].id,
          value: `✅ <b>Registrado no Luna Finance</b>\n${d.kind === "income" ? "Receita" : "Despesa"}: ${esc(d.description)} — <b>${brl(d.amountCents)}</b>` +
            `${created.length > 1 ? ` em ${created.length} parcelas` : ""} (${dateLabel(d.date)}).\nJá aparece no site; você pode editar por lá.`,
        };
      }
      if (pl.kind === "goal") {
        const g = await createGoalWith(q, user, { name: pl.goal.name, targetCents: pl.goal.targetCents, deadline: pl.goal.deadline, scope: pl.goal.scope }, "telegram");
        return { resultId: g.id, value: `✅ <b>Meta criada:</b> ${esc(g.name)} — ${brl(g.targetCents)}.\nEnvie <i>guardei 200 na meta ${esc(g.name.toLowerCase())}</i> para registrar contribuições.` };
      }
      const r = await contributeWith(q, user, pl.contribution.goalId, { amountCents: pl.contribution.amountCents }, "telegram");
      return {
        resultId: r.id,
        value: `✅ <b>${pl.contribution.amountCents < 0 ? "Retirada registrada" : "Contribuição registrada"}</b> em ${esc(r.goal.name)}.\n` +
          `Agora: ${brl(r.goal.savedCents)} de ${brl(r.goal.targetCents)} (${Math.round(r.goal.percent)}%)${r.goal.achievedAt ? " — meta atingida! 🎉" : ""}.`,
      };
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
  // a gravação já foi confirmada pelo banco; agora sim avisamos
  try {
    await tg.editMessageText(user.chatId, messageId, result.value);
  } catch (err) {
    ctx.log.warn("telegram.aviso_pos_confirmacao_falhou", { op, err: (err as Error).message.slice(0, 120) });
    await tg.sendMessage(user.chatId, result.value).catch(() => {});
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

// =========================== consultas ===========================

export async function answer(ctx: AppContext, user: User, query: Query) {
  const r = await buildReply(ctx.db, user, query);
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
