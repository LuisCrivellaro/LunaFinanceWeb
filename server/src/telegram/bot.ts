/**
 * Lógica do bot: recebe um "update" da Telegram Bot API e responde.
 * Fluxo de segurança de cada mensagem:
 *   1. dedup por update_id (o Telegram reenvia quando não recebe 200)
 *   2. só chats privados
 *   3. identidade = from.id vinculado (nunca o nome digitado)
 *   4. permissões = as mesmas do site (services/access.ts)
 *   5. qualquer gravação financeira passa por confirmação explícita
 */
import { randomBytes } from "node:crypto";
import type { AppContext } from "../context.js";
import { addDays, currentMonth, monthNamePt, monthRange, now, today } from "../lib/clock.js";
import { HttpError } from "../lib/errors.js";
import { resolveScope, type AuthUser } from "../services/access.js";
import { listAccounts, totalBalance } from "../services/accounts.js";
import { listCategories } from "../services/categories.js";
import { listGoals } from "../services/goals.js";
import { byCategory, monthTotals } from "../services/insights.js";
import { listMembers } from "../services/members.js";
import { createTransaction, getTransactions, markPaid, type TransactionRow } from "../services/transactions.js";
import type { InlineButton } from "./api.js";
import { bar, brl, dt, dtFull, esc, signed } from "./format.js";
import { consumeLinkCode, unlinkTelegram, userByTelegramId } from "./linking.js";
import { parseMessage, type CategoryLite, type Draft, type Intent, type QueryIntent } from "./parser.js";

// ----- Tipos mínimos da Bot API que usamos -----
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

const PENDING_TTL_MIN = 15;

type User = AuthUser & { chatId: number };

export async function handleUpdate(ctx: AppContext, update: TgUpdate): Promise<void> {
  if (!ctx.telegram || typeof update?.update_id !== "number") return;
  const fresh = await ctx.db.query("INSERT INTO telegram_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id", [update.update_id]);
  if (!fresh.rows.length) {
    ctx.log.info("telegram.update_duplicado", { update_id: update.update_id });
    return;
  }
  try {
    if (update.message) await onMessage(ctx, update.message);
    else if (update.callback_query) await onCallback(ctx, update.callback_query);
  } catch (err) {
    ctx.log.error("telegram.erro_update", { update_id: update.update_id, err: (err as Error).message });
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) await ctx.telegram.sendMessage(chatId, "Tive um problema para processar isso agora. Tente de novo em instantes.").catch(() => {});
  }
}

// ======================= Mensagens =======================

async function onMessage(ctx: AppContext, msg: TgMessage) {
  const tg = ctx.telegram!;
  if (!msg.from || msg.from.is_bot) return;
  if (msg.chat.type !== "private") {
    await tg.sendMessage(msg.chat.id, "Por segurança, o Luna Finance só funciona em conversa privada comigo.");
    return;
  }
  const text = (msg.text ?? "").trim();
  if (!text) {
    await tg.sendMessage(msg.chat.id, "Por enquanto eu entendo só mensagens de texto. 🙂");
    return;
  }
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.startsWith("/") ? rawCmd.slice(1).split("@")[0].toLowerCase() : null;
  const arg = rest.join(" ");

  // vinculação funciona antes de estar vinculado
  if (cmd === "start" && arg.toLowerCase().startsWith("link_")) return doLink(ctx, msg, arg);
  if (cmd === "vincular") return doLink(ctx, msg, arg);

  const user = await userByTelegramId(ctx.db, msg.from.id);
  if (!user) {
    await tg.sendMessage(
      msg.chat.id,
      "Olá! Eu sou o assistente do <b>Luna Finance</b>.\n\n" +
        "Para começar, conecte sua conta:\n" +
        "1. Entre no site do Luna Finance\n" +
        "2. Vá em <b>Configurações → Telegram</b> e toque em <b>Conectar</b>\n" +
        "3. Abra o link gerado ou me envie <code>/vincular CÓDIGO</code>\n\n" +
        "Sem esse código eu não mostro nenhuma informação.",
    );
    return;
  }

  switch (cmd) {
    case "start":
    case "ajuda":
    case "help":
      return sendHelp(ctx, user);
    case "saldo":
      return answerQuery(ctx, user, "balance");
    case "familia":
      return answerQuery(ctx, user, "family");
    case "receitas":
      return answerQuery(ctx, user, "income");
    case "despesas":
      return answerQuery(ctx, user, "expenses");
    case "contas":
    case "pendentes":
      return answerQuery(ctx, user, "bills");
    case "vencimentos":
      return answerQuery(ctx, user, "upcoming");
    case "metas":
      return answerQuery(ctx, user, "goals");
    case "resumo":
      return answerQuery(ctx, user, "summary");
    case "notificacoes":
      return sendNotificationSettings(ctx, user);
    case "desvincular":
      await unlinkTelegram(ctx.db, user.id, "telegram");
      await tg.sendMessage(msg.chat.id, "Pronto, este Telegram foi desconectado da sua conta. Para voltar, gere um novo código no site.");
      return;
    case null:
      return handleFreeText(ctx, user, text);
    default:
      await tg.sendMessage(msg.chat.id, "Não conheço esse comando. Envie /ajuda para ver o que eu sei fazer.");
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
    `Tudo certo, ${esc(r.name.split(" ")[0])}! Sua conta está conectada. ✅\n\nExperimente:\n• <i>Gastei R$ 45 no mercado</i>\n• <i>Recebi 3.000 de salário</i>\n• /resumo`,
  );
}

async function sendHelp(ctx: AppContext, user: User) {
  await ctx.telegram!.sendMessage(
    user.chatId,
    `Oi, ${esc(user.name.split(" ")[0])}! Veja o que posso fazer:\n\n` +
      "<b>Registrar</b> (sempre peço confirmação)\n" +
      "• <i>Registra uma despesa de R$ 150 com supermercado</i>\n" +
      "• <i>Recebi R$ 3.000 de salário</i>\n" +
      "• <i>Conta de internet de R$ 120 para dia 20</i>\n" +
      "• <i>Comprei um celular de 2.400 em 12x</i>\n\n" +
      "<b>Consultar</b>\n" +
      "/resumo · /saldo · /familia\n/receitas · /despesas · /contas\n/vencimentos · /metas\n\n" +
      "<b>Preferências</b>\n/notificacoes · /desvincular",
  );
}

async function categoriesLite(ctx: AppContext): Promise<CategoryLite[]> {
  return (await listCategories(ctx.db)).map((c) => ({ id: c.id, name: c.name, kind: c.kind, keywords: c.keywords }));
}

async function handleFreeText(ctx: AppContext, user: User, text: string) {
  const cats = await categoriesLite(ctx);
  let intent: Intent = parseMessage(text, cats, today());
  if ((intent.type === "unknown" || (intent.type === "incomplete" && intent.missing.includes("kind"))) && ctx.ai) {
    const ai = await ctx.ai.interpret(text, cats, today());
    if (ai && ai.type !== "unknown") intent = ai;
  }
  if (intent.type === "query") return answerQuery(ctx, user, intent.query);
  if (intent.type === "entry") return proposeEntry(ctx, user, intent.draft);
  if (intent.type === "incomplete") {
    if (intent.missing.includes("amount")) {
      await ctx.telegram!.sendMessage(user.chatId, "Não encontrei o valor. Pode mandar de novo com o valor? Ex.: <i>Gastei R$ 32,50 na farmácia</i>");
      return;
    }
    // valor ok, falta saber se é receita ou despesa
    const draft: Draft = {
      kind: "expense",
      amountCents: intent.partial.amountCents!,
      description: text.replace(/[\d.,]+/g, "").replace(/r\$/gi, "").trim().slice(0, 60) || "Lançamento",
      categoryId: null,
      date: today(),
      status: "paid",
      installments: null,
      amountText: intent.partial.amountText ?? "",
    };
    const id = await savePending(ctx, user, { draft, needsKind: true });
    await ctx.telegram!.sendMessage(user.chatId, `Entendi o valor de <b>${brl(draft.amountCents)}</b>. Isso é uma receita ou uma despesa?`, {
      reply_markup: { inline_keyboard: [[{ text: "Despesa", callback_data: `t:${id}:expense` }, { text: "Receita", callback_data: `t:${id}:income` }], [{ text: "Cancelar", callback_data: `x:${id}` }]] },
    });
    return;
  }
  await ctx.telegram!.sendMessage(
    user.chatId,
    "Não entendi. Você pode registrar algo como <i>Gastei R$ 50 no mercado</i> ou consultar com /resumo. Envie /ajuda para mais exemplos.",
  );
}

// ======================= Confirmação de lançamentos =======================

interface PendingPayload {
  draft: Draft;
  needsKind?: boolean;
  /** pagamento de conta já existente */
  payTransactionId?: number;
}

async function savePending(ctx: AppContext, user: User, payload: PendingPayload): Promise<string> {
  const id = randomBytes(9).toString("base64url");
  await ctx.db.query(
    `INSERT INTO telegram_pending_actions (id, user_id, chat_id, payload, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [id, user.id, user.chatId, JSON.stringify(payload), new Date(now().getTime() + PENDING_TTL_MIN * 60000)],
  );
  return id;
}

async function draftText(ctx: AppContext, d: Draft) {
  const cats = await listCategories(ctx.db, true);
  const cat = cats.find((c) => c.id === d.categoryId);
  const inst = d.installments ? `\n<b>Parcelas:</b> ${d.installments}x de ~${brl(Math.round(d.amountCents / d.installments))}` : "";
  return (
    `<b>${d.kind === "income" ? "Nova receita" : d.status === "pending" ? "Nova conta a pagar" : "Nova despesa"}</b>\n\n` +
    `<b>Valor:</b> ${brl(d.amountCents)}${inst}\n` +
    `<b>Descrição:</b> ${esc(d.description)}\n` +
    `<b>Categoria:</b> ${esc(cat?.name ?? "Sem categoria")}\n` +
    `<b>${d.status === "pending" ? "Vencimento" : "Data"}:</b> ${dtFull(d.date)}\n` +
    `<b>Situação:</b> ${d.status === "pending" ? "Pendente" : d.kind === "income" ? "Recebido" : "Pago"}\n\n` +
    "Está correto?"
  );
}

function confirmKeyboard(id: string, d: Draft): InlineButton[][] {
  return [
    [{ text: "✅ Confirmar", callback_data: `c:${id}` }, { text: "Cancelar", callback_data: `x:${id}` }],
    [
      { text: "Trocar categoria", callback_data: `k:${id}` },
      { text: d.status === "pending" ? "Marcar como pago" : "Marcar pendente", callback_data: `s:${id}` },
    ],
  ];
}

async function proposeEntry(ctx: AppContext, user: User, draft: Draft) {
  const id = await savePending(ctx, user, { draft });
  await ctx.telegram!.sendMessage(user.chatId, await draftText(ctx, draft), { reply_markup: { inline_keyboard: confirmKeyboard(id, draft) } });
}

async function loadPending(ctx: AppContext, id: string, userId: number) {
  const { rows } = await ctx.db.query<{ id: string; user_id: number; payload: PendingPayload; status: string; expires_at: Date }>(
    "SELECT id, user_id, payload, status, expires_at FROM telegram_pending_actions WHERE id = $1",
    [id],
  );
  const p = rows[0];
  if (!p || p.user_id !== userId) return { error: "Esta ação não está mais disponível." } as const;
  if (p.status !== "pending") return { error: p.status === "confirmed" ? "Isso já foi registrado. ✅" : "Esta ação foi cancelada." } as const;
  if (p.expires_at < now()) return { error: "Esta confirmação expirou. Envie a mensagem de novo." } as const;
  const payload = typeof p.payload === "string" ? (JSON.parse(p.payload) as PendingPayload) : p.payload;
  return { pending: { ...p, payload } } as const;
}

async function onCallback(ctx: AppContext, cb: TgCallbackQuery) {
  const tg = ctx.telegram!;
  const user = await userByTelegramId(ctx.db, cb.from.id);
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  if (!user || !chatId || !messageId || chatId !== user.chatId) {
    await tg.answerCallbackQuery(cb.id, "Conecte sua conta para usar este botão.");
    return;
  }
  const [action, id, extra] = (cb.data ?? "").split(":");

  // preferências de notificação
  if (action === "n") return toggleNotification(ctx, user, cb, id, messageId);
  // pagar conta existente: p = pedir confirmação, pc = confirmar
  if (action === "p" || action === "pc") return payBill(ctx, user, cb, Number(id), action === "pc", messageId);

  if (action === "x" && id === "none") {
    await tg.editMessageText(chatId, messageId, "Ok, nada foi alterado.");
    await tg.answerCallbackQuery(cb.id);
    return;
  }

  const loaded = await loadPending(ctx, id, user.id);
  if ("error" in loaded) {
    await tg.answerCallbackQuery(cb.id, loaded.error);
    return;
  }
  const { payload } = loaded.pending;
  const draft = payload.draft;

  if (action === "x") {
    await ctx.db.query("UPDATE telegram_pending_actions SET status = 'cancelled' WHERE id = $1 AND status = 'pending'", [id]);
    await tg.editMessageText(chatId, messageId, "Cancelado. Nada foi registrado.");
    await tg.answerCallbackQuery(cb.id);
    return;
  }

  if (action === "t" && (extra === "income" || extra === "expense")) {
    draft.kind = extra;
    const cats = await categoriesLite(ctx);
    draft.categoryId = cats.find((c) => c.kind === extra && /^outr/i.test(c.name))?.id ?? null;
    await updatePayload(ctx, id, { draft });
    await tg.editMessageText(chatId, messageId, await draftText(ctx, draft), { reply_markup: { inline_keyboard: confirmKeyboard(id, draft) } });
    await tg.answerCallbackQuery(cb.id);
    return;
  }

  if (action === "s") {
    draft.status = draft.status === "pending" ? "paid" : "pending";
    if (draft.status === "paid" && draft.date > today()) draft.date = today();
    await updatePayload(ctx, id, payload);
    await tg.editMessageText(chatId, messageId, await draftText(ctx, draft), { reply_markup: { inline_keyboard: confirmKeyboard(id, draft) } });
    await tg.answerCallbackQuery(cb.id);
    return;
  }

  if (action === "k") {
    // lista categorias do tipo, 2 por linha
    const cats = (await categoriesLite(ctx)).filter((c) => c.kind === draft.kind);
    const rows: InlineButton[][] = [];
    for (let i = 0; i < cats.length; i += 2) {
      rows.push(cats.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `g:${id}:${c.id}` })));
    }
    rows.push([{ text: "Voltar", callback_data: `b:${id}` }]);
    await tg.editMessageText(chatId, messageId, "Escolha a categoria:", { reply_markup: { inline_keyboard: rows } });
    await tg.answerCallbackQuery(cb.id);
    return;
  }

  if (action === "g" || action === "b") {
    if (action === "g") {
      const cats = await categoriesLite(ctx);
      const chosen = cats.find((c) => c.id === Number(extra) && c.kind === draft.kind);
      if (chosen) draft.categoryId = chosen.id;
      await updatePayload(ctx, id, payload);
    }
    await tg.editMessageText(chatId, messageId, await draftText(ctx, draft), { reply_markup: { inline_keyboard: confirmKeyboard(id, draft) } });
    await tg.answerCallbackQuery(cb.id);
    return;
  }

  if (action === "c") {
    // trava atômica: só um clique consegue confirmar (evita duplicidade)
    const lock = await ctx.db.query("UPDATE telegram_pending_actions SET status = 'confirmed' WHERE id = $1 AND status = 'pending' AND expires_at > $2 RETURNING id", [id, now()]);
    if (!lock.rows.length) {
      await tg.answerCallbackQuery(cb.id, "Isso já foi processado.");
      return;
    }
    try {
      const created = await createTransaction(
        ctx.db,
        user,
        {
          kind: draft.kind,
          amountCents: draft.amountCents,
          description: draft.description,
          date: draft.date,
          status: draft.status,
          categoryId: draft.categoryId,
          installments: draft.installments,
        },
        "telegram",
      );
      await ctx.db.query("UPDATE telegram_pending_actions SET result_id = $2 WHERE id = $1", [id, created[0].id]);
      const extraInfo = created.length > 1 ? ` em ${created.length} parcelas` : "";
      await tg.editMessageText(
        chatId,
        messageId,
        `✅ Registrado${extraInfo}: <b>${esc(draft.description)}</b> — ${brl(draft.amountCents)} (${dtFull(draft.date)}).\nVocê pode editar pelo site a qualquer momento.`,
      );
      await tg.answerCallbackQuery(cb.id, "Registrado!");
    } catch (err) {
      // devolve para pendente para permitir nova tentativa
      await ctx.db.query("UPDATE telegram_pending_actions SET status = 'pending' WHERE id = $1", [id]);
      const msg = err instanceof HttpError ? err.message : "Não consegui registrar agora.";
      await tg.answerCallbackQuery(cb.id, msg.slice(0, 190));
      if (!(err instanceof HttpError)) throw err;
    }
    return;
  }
  await tg.answerCallbackQuery(cb.id);
}

async function updatePayload(ctx: AppContext, id: string, payload: PendingPayload) {
  await ctx.db.query("UPDATE telegram_pending_actions SET payload = $2 WHERE id = $1 AND status = 'pending'", [id, JSON.stringify(payload)]);
}

async function payBill(ctx: AppContext, user: User, cb: TgCallbackQuery, txId: number, confirmed: boolean, messageId: number) {
  const tg = ctx.telegram!;
  const [tx] = await getTransactions(ctx.db, [txId]);
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
      reply_markup: { inline_keyboard: [[{ text: "✅ Confirmar pagamento", callback_data: `pc:${tx.id}` }, { text: "Agora não", callback_data: `x:none` }]] },
    });
    await tg.answerCallbackQuery(cb.id);
    return;
  }
  await markPaid(ctx.db, user, tx.id, today(), "telegram");
  await tg.editMessageText(user.chatId, messageId, `✅ <b>${esc(tx.description)}</b> marcada como paga (${brl(tx.amountCents)}).`);
  await tg.answerCallbackQuery(cb.id, "Pagamento registrado!");
}

// ======================= Consultas =======================

export async function answerQuery(ctx: AppContext, user: User, q: QueryIntent) {
  const text = await buildQueryText(ctx, user, q);
  const extras = q === "bills" || q === "upcoming" ? await payButtons(ctx, user, q) : undefined;
  await ctx.telegram!.sendMessage(user.chatId, text, extras ? { reply_markup: { inline_keyboard: extras } } : {});
}

async function payButtons(ctx: AppContext, user: User, q: QueryIntent): Promise<InlineButton[][] | undefined> {
  const t = today();
  const { rows } = await ctx.db.query<{ id: number; description: string }>(
    `SELECT id, description FROM transactions WHERE user_id = $1 AND kind='expense' AND status='pending' AND deleted_at IS NULL
       AND date <= $2 ORDER BY date LIMIT 5`,
    [user.id, q === "upcoming" ? addDays(t, 15) : addDays(t, 30)],
  );
  if (!rows.length) return undefined;
  return rows.map((r) => [{ text: `Pagar: ${r.description.slice(0, 40)}`, callback_data: `p:${r.id}` }]);
}

function txLine(t: TransactionRow, today_: string) {
  const late = t.date < today_ ? " ⚠️" : "";
  return `• ${dt(t.date)} — ${esc(t.description)}: <b>${brl(t.amountCents)}</b>${late}`;
}

export async function buildQueryText(ctx: AppContext, user: AuthUser, q: QueryIntent): Promise<string> {
  const db = ctx.db;
  const ym = currentMonth();
  const { start, end } = monthRange(ym);
  const t = today();
  const monthLabel = monthNamePt(ym);

  if (q === "balance") {
    const accounts = await listAccounts(db, user, [user.id]);
    const total = accounts.reduce((s, a) => s + a.balanceCents, 0);
    const lines = accounts.map((a) => `• ${esc(a.name)}: ${brl(a.balanceCents)}`).join("\n");
    return `<b>Seu saldo:</b> ${brl(total)}\n\n${lines || "Nenhuma conta cadastrada."}`;
  }

  if (q === "family") {
    let scope;
    try {
      scope = await resolveScope(db, user, "family");
    } catch {
      return "Sua conta não tem acesso aos dados da família. Fale com a família para ajustar as permissões no site.";
    }
    const [balance, totals] = await Promise.all([totalBalance(db, scope.userIds), monthTotals(db, scope.userIds, ym)]);
    let text =
      `<b>Família — ${monthLabel}</b>\n\n` +
      `Saldo total: <b>${brl(balance)}</b>\n` +
      `Receitas: ${brl(totals.incomeTotalCents)}\n` +
      `Despesas: ${brl(totals.expenseTotalCents)}\n` +
      `Resultado: <b>${signed(totals.incomeTotalCents - totals.expenseTotalCents)}</b>`;
    if (scope.detail) {
      const members = await listMembers(db);
      const rows = await Promise.all(members.map(async (m) => ({ m, tot: await monthTotals(db, [m.id], ym) })));
      text += "\n\n<b>Por pessoa (despesas do mês)</b>\n" + rows.map((r) => `• ${esc(r.m.name)}: ${brl(r.tot.expenseTotalCents)}`).join("\n");
    }
    return text;
  }

  if (q === "income" || q === "expenses") {
    const kind = q === "income" ? "income" : "expense";
    const [totals, cats] = await Promise.all([monthTotals(db, [user.id], ym), byCategory(db, [user.id], start, end, kind)]);
    const total = kind === "income" ? totals.incomeTotalCents : totals.expenseTotalCents;
    const done = kind === "income" ? totals.incomePaidCents : totals.expensePaidCents;
    const lines = cats.slice(0, 6).map((c) => `• ${esc(c.name)}: ${brl(c.cents)} (${c.percent.toLocaleString("pt-BR")}%)`).join("\n");
    return (
      `<b>${kind === "income" ? "Suas receitas" : "Suas despesas"} — ${monthLabel}</b>\n\n` +
      `Total: <b>${brl(total)}</b>\n${kind === "income" ? "Já recebido" : "Já pago"}: ${brl(done)}\n\n` +
      (lines || "Nada registrado neste mês ainda.")
    );
  }

  if (q === "bills" || q === "upcoming") {
    const horizon = q === "upcoming" ? addDays(t, 15) : addDays(t, 30);
    const { rows } = await db.query<TransactionRow>(
      `SELECT t.id, t.description, t.amount_cents AS "amountCents", t.date FROM transactions t
        WHERE t.user_id = $1 AND t.kind='expense' AND t.status='pending' AND t.deleted_at IS NULL
          AND t.date <= $2 ${q === "upcoming" ? "AND t.date >= $3" : ""}
        ORDER BY t.date LIMIT 25`,
      q === "upcoming" ? [user.id, horizon, t] : [user.id, horizon],
    );
    if (!rows.length) return q === "upcoming" ? "Nenhum vencimento nos próximos 15 dias. 🎉" : "Você não tem contas pendentes nos próximos 30 dias. 🎉";
    const overdue = rows.filter((r) => r.date < t);
    const next = rows.filter((r) => r.date >= t);
    let text = q === "upcoming" ? "<b>Próximos vencimentos (15 dias)</b>\n" : "<b>Suas contas a pagar</b>\n";
    if (overdue.length) text += `\n<b>Atrasadas</b> (${brl(overdue.reduce((s, r) => s + r.amountCents, 0))})\n` + overdue.map((r) => txLine(r, t)).join("\n") + "\n";
    if (next.length) text += `\n<b>A vencer</b> (${brl(next.reduce((s, r) => s + r.amountCents, 0))})\n` + next.map((r) => txLine(r, t)).join("\n");
    return text;
  }

  if (q === "goals") {
    const goals = (await listGoals(db, user, {})).filter((g) => g.scope === "family" || g.ownerId === user.id);
    if (!goals.length) return "Nenhuma meta ativa. Crie uma pelo site em <b>Metas</b>.";
    return (
      "<b>Metas</b>\n\n" +
      goals
        .map(
          (g) =>
            `<b>${esc(g.name)}</b>${g.scope === "family" ? " · família" : ""}\n${bar(g.percent)} ${g.percent.toLocaleString("pt-BR")}%\n` +
            `${brl(g.savedCents)} de ${brl(g.targetCents)}` +
            (g.deadline ? ` · até ${dtFull(g.deadline)}` : "") +
            (g.monthlyNeededCents ? `\nGuardar ~${brl(g.monthlyNeededCents)}/mês para chegar lá` : ""),
        )
        .join("\n\n")
    );
  }

  // summary
  const [totals, cats, balance] = await Promise.all([monthTotals(db, [user.id], ym), byCategory(db, [user.id], start, end, "expense"), totalBalance(db, [user.id])]);
  const { rows: pend } = await db.query<{ overdue: number; week: number }>(
    `SELECT count(*) FILTER (WHERE date < $2)::int AS overdue, count(*) FILTER (WHERE date >= $2 AND date <= $3)::int AS week
       FROM transactions WHERE user_id = $1 AND kind='expense' AND status='pending' AND deleted_at IS NULL`,
    [user.id, t, addDays(t, 7)],
  );
  const result = totals.incomeTotalCents - totals.expenseTotalCents;
  return (
    `<b>Resumo — ${monthLabel}</b>\n\n` +
    `Saldo atual: <b>${brl(balance)}</b>\n` +
    `Receitas: ${brl(totals.incomeTotalCents)}\n` +
    `Despesas: ${brl(totals.expenseTotalCents)}\n` +
    `Resultado do mês: <b>${signed(result)}</b>\n` +
    (cats.length ? `\n<b>Maiores gastos</b>\n${cats.slice(0, 3).map((c) => `• ${esc(c.name)}: ${brl(c.cents)}`).join("\n")}\n` : "") +
    (pend[0].overdue ? `\n⚠️ ${pend[0].overdue} conta(s) atrasada(s) — /contas` : "") +
    (pend[0].week ? `\n📅 ${pend[0].week} vencimento(s) nos próximos 7 dias — /vencimentos` : "")
  );
}

// ======================= Notificações (preferências) =======================

const NOTIFY_FIELDS: Array<[string, string, string]> = [
  ["overdue", "notify_overdue", "Contas atrasadas"],
  ["daily", "notify_daily", "Resumo diário (20h)"],
  ["weekly", "notify_weekly", "Resumo semanal (segunda)"],
  ["goals", "notify_goals", "Metas quase atingidas"],
  ["anomaly", "notify_anomaly", "Gastos fora do padrão"],
];

async function notificationKeyboard(ctx: AppContext, userId: number) {
  const { rows } = await ctx.db.query<Record<string, unknown>>(
    "SELECT notify_due_days, notify_overdue, notify_daily, notify_weekly, notify_goals, notify_anomaly FROM users WHERE id = $1",
    [userId],
  );
  const u = rows[0];
  const kb: InlineButton[][] = NOTIFY_FIELDS.map(([key, col, label]) => [{ text: `${u[col] ? "✅" : "⬜️"} ${label}`, callback_data: `n:${key}` }]);
  kb.unshift([{ text: `📅 Vencimentos: ${u.notify_due_days ? `${u.notify_due_days} dia(s) antes` : "desligado"}`, callback_data: "n:due" }]);
  return kb;
}

async function sendNotificationSettings(ctx: AppContext, user: User) {
  await ctx.telegram!.sendMessage(user.chatId, "<b>Avisos automáticos</b>\nToque para ligar ou desligar:", {
    reply_markup: { inline_keyboard: await notificationKeyboard(ctx, user.id) },
  });
}

async function toggleNotification(ctx: AppContext, user: User, cb: TgCallbackQuery, key: string, messageId: number) {
  if (key === "due") {
    // ciclo 0 → 1 → 3 → 5 → 7 → 0
    await ctx.db.query(
      `UPDATE users SET notify_due_days = CASE notify_due_days WHEN 0 THEN 1 WHEN 1 THEN 3 WHEN 3 THEN 5 WHEN 5 THEN 7 ELSE 0 END WHERE id = $1`,
      [user.id],
    );
  } else {
    const field = NOTIFY_FIELDS.find(([k]) => k === key);
    if (!field) return ctx.telegram!.answerCallbackQuery(cb.id);
    await ctx.db.query(`UPDATE users SET ${field[1]} = NOT ${field[1]} WHERE id = $1`, [user.id]);
  }
  await ctx.telegram!.editMessageText(user.chatId, messageId, "<b>Avisos automáticos</b>\nToque para ligar ou desligar:", {
    reply_markup: { inline_keyboard: await notificationKeyboard(ctx, user.id) },
  });
  await ctx.telegram!.answerCallbackQuery(cb.id, "Preferência salva");
}
