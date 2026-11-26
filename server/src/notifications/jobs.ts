/**
 * Notificações automáticas pelo Telegram.
 * Cada aviso é registrado em `notification_log` ANTES do envio (reserva),
 * então rodar o job várias vezes nunca duplica mensagens. Se o envio falhar,
 * a reserva é desfeita para tentar de novo na próxima rodada.
 */
import type { AppContext } from "../context.js";
import { addDays, currentMonth, localHour, localWeekday, monthNamePt, monthRange, now, today } from "../lib/clock.js";
import { generateAllRecurrences } from "../services/transactions.js";
import { monthTotals } from "../services/insights.js";
import { brl, dt, esc, signed } from "../telegram/format.js";
import { isPermanentTelegramError, type InlineButton } from "../telegram/api.js";
import { ensureWebhook } from "../telegram/setup.js";
import { enqueueChannelNotifications } from "./queue.js";

interface LinkedUser {
  id: number;
  name: string;
  chat_id: number;
  family_access: string;
  notify_due_days: number;
  notify_overdue: boolean;
  notify_daily: boolean;
  notify_weekly: boolean;
  notify_goals: boolean;
  notify_anomaly: boolean;
}

async function linkedUsers(ctx: AppContext): Promise<LinkedUser[]> {
  const { rows } = await ctx.db.query<LinkedUser>(
    `SELECT u.id, u.name, l.chat_id, u.family_access, u.notify_due_days, u.notify_overdue, u.notify_daily,
            u.notify_weekly, u.notify_goals, u.notify_anomaly
       FROM users u JOIN telegram_links l ON l.user_id = u.id WHERE u.active`,
  );
  return rows;
}

/** Reserva + envio idempotente. Retorna true se enviou. */
async function notifyOnce(ctx: AppContext, u: LinkedUser, kind: string, ref: string, text: string, buttons?: InlineButton[][]) {
  const r = await ctx.db.query<{ id: number }>(
    "INSERT INTO notification_log (user_id, kind, ref_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
    [u.id, kind, ref],
  );
  if (!r.rows[0]) return false;
  try {
    await ctx.telegram!.sendMessage(u.chat_id, text, buttons ? { reply_markup: { inline_keyboard: buttons } } : {});
    return true;
  } catch (err) {
    // falha transitória: libera para tentar no próximo ciclo; bot bloqueado/chat inexistente: não insiste
    if (!isPermanentTelegramError(err)) await ctx.db.query("DELETE FROM notification_log WHERE id = $1", [r.rows[0].id]);
    ctx.log.warn("notificacao.falhou", { user_id: u.id, kind, permanent: isPermanentTelegramError(err), err: (err as Error).message });
    return false;
  }
}

export async function notifyDueBills(ctx: AppContext, users: LinkedUser[]) {
  const t = today();
  let sent = 0;
  for (const u of users) {
    if (u.notify_due_days <= 0) continue;
    const { rows } = await ctx.db.query<{ id: number; description: string; amount_cents: number; date: string }>(
      `SELECT t.id, t.description, t.amount_cents, t.date FROM transactions t
        WHERE t.user_id = $1 AND t.kind='expense' AND t.status='pending' AND t.deleted_at IS NULL
          AND t.date BETWEEN $2 AND $3
          AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.user_id = $1 AND n.kind='due' AND n.ref_key = t.id || ':' || t.date)
        ORDER BY t.date`,
      [u.id, t, addDays(t, u.notify_due_days)],
    );
    if (!rows.length) continue;
    // reserva cada item; agrupa num único aviso
    const reserved: typeof rows = [];
    for (const r of rows) {
      const ins = await ctx.db.query("INSERT INTO notification_log (user_id, kind, ref_key) VALUES ($1,'due',$2) ON CONFLICT DO NOTHING RETURNING id", [u.id, `${r.id}:${r.date}`]);
      if (ins.rows.length) reserved.push(r);
    }
    if (!reserved.length) continue;
    const lines = reserved.map((r) => `• ${r.date === t ? "<b>hoje</b>" : dt(r.date)} — ${esc(r.description)}: <b>${brl(r.amount_cents)}</b>`).join("\n");
    const text = `📅 <b>Contas a vencer</b>\n\n${lines}`;
    const buttons = reserved.slice(0, 4).map((r) => [{ text: `Marcar como paga: ${r.description.slice(0, 28)}`, callback_data: `p:${r.id}` }]);
    try {
      await ctx.telegram!.sendMessage(u.chat_id, text, { reply_markup: { inline_keyboard: buttons } });
      sent++;
    } catch (err) {
      if (!isPermanentTelegramError(err)) {
        for (const r of reserved) await ctx.db.query("DELETE FROM notification_log WHERE user_id = $1 AND kind='due' AND ref_key = $2", [u.id, `${r.id}:${r.date}`]);
      }
      ctx.log.warn("notificacao.falhou", { user_id: u.id, kind: "due", permanent: isPermanentTelegramError(err), err: (err as Error).message });
    }
  }
  return sent;
}

export async function notifyOverdue(ctx: AppContext, users: LinkedUser[]) {
  const t = today();
  let sent = 0;
  for (const u of users) {
    if (!u.notify_overdue) continue;
    const { rows } = await ctx.db.query<{ id: number; description: string; amount_cents: number; date: string }>(
      `SELECT t.id, t.description, t.amount_cents, t.date FROM transactions t
        WHERE t.user_id = $1 AND t.kind='expense' AND t.status='pending' AND t.deleted_at IS NULL AND t.date < $2
          AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.user_id = $1 AND n.kind='overdue' AND n.ref_key = t.id || ':' || t.date)
        ORDER BY t.date LIMIT 10`,
      [u.id, t],
    );
    for (const r of rows) {
      const ok = await notifyOnce(
        ctx, u, "overdue", `${r.id}:${r.date}`,
        `⚠️ <b>Conta atrasada</b>\n\n${esc(r.description)} — <b>${brl(r.amount_cents)}</b>\nVenceu em ${dt(r.date)}.`,
        [[{ text: "Já paguei", callback_data: `p:${r.id}` }]],
      );
      if (ok) sent++;
    }
  }
  return sent;
}

export async function notifyGoals(ctx: AppContext, users: LinkedUser[]) {
  let sent = 0;
  const { rows: goals } = await ctx.db.query<{ id: number; name: string; scope: string; owner_id: number; target_cents: number; saved: number; achieved_at: Date | null }>(
    `SELECT g.id, g.name, g.scope, g.owner_id, g.target_cents, g.achieved_at,
            COALESCE((SELECT sum(amount_cents) FROM goal_contributions c WHERE c.goal_id = g.id),0)::bigint AS saved
       FROM goals g WHERE NOT g.archived`,
  );
  for (const u of users) {
    if (!u.notify_goals) continue;
    for (const g of goals) {
      const visible = g.owner_id === u.id || (g.scope === "family" && u.family_access !== "none");
      if (!visible) continue;
      const pct = (g.saved / g.target_cents) * 100;
      if (g.achieved_at || pct >= 100) {
        if (await notifyOnce(ctx, u, "goal_done", String(g.id), `🎉 <b>Meta atingida!</b>\n\n${esc(g.name)}: ${brl(g.saved)} de ${brl(g.target_cents)}.`)) sent++;
      } else if (pct >= 90) {
        if (await notifyOnce(ctx, u, "goal_near", String(g.id), `🎯 <b>Quase lá!</b>\n\n${esc(g.name)} está em ${Math.floor(pct)}%. Faltam ${brl(g.target_cents - g.saved)}.`)) sent++;
      }
    }
  }
  return sent;
}

/**
 * Gasto fora do padrão — regra conservadora para evitar alarme falso:
 * despesa das últimas 24h com valor ≥ R$ 50 e ≥ 3× a mediana da mesma
 * categoria para a mesma pessoa nos 180 dias anteriores, com pelo menos
 * 6 lançamentos de histórico. Sem histórico suficiente, não avisa.
 */
export async function findAnomalies(ctx: AppContext, userId: number) {
  const { rows } = await ctx.db.query<{ id: number; description: string; amount_cents: number; category: string; median: number }>(
    `WITH recent AS (
       SELECT t.id, t.description, t.amount_cents, t.category_id, t.date FROM transactions t
        WHERE t.user_id = $1 AND t.kind='expense' AND t.deleted_at IS NULL AND t.category_id IS NOT NULL
          AND t.recurrence_id IS NULL AND t.installment_group IS NULL
          AND t.created_at > $2 AND t.amount_cents >= 5000
     )
     SELECT r.id, r.description, r.amount_cents, c.name AS category, h.median::bigint AS median
       FROM recent r JOIN categories c ON c.id = r.category_id
       JOIN LATERAL (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY t2.amount_cents) AS median, count(*) AS n
           FROM transactions t2
          WHERE t2.user_id = $1 AND t2.kind='expense' AND t2.deleted_at IS NULL AND t2.category_id = r.category_id
            AND t2.id <> r.id AND t2.date BETWEEN r.date - 180 AND r.date
       ) h ON h.n >= 6 AND r.amount_cents >= 3 * h.median`,
    [userId, new Date(now().getTime() - 24 * 3600000)],
  );
  return rows;
}

export async function notifyAnomalies(ctx: AppContext, users: LinkedUser[]) {
  let sent = 0;
  for (const u of users) {
    if (!u.notify_anomaly) continue;
    for (const a of await findAnomalies(ctx, u.id)) {
      const ok = await notifyOnce(
        ctx, u, "anomaly", String(a.id),
        `🔎 <b>Gasto acima do seu padrão</b>\n\n${esc(a.description)} — <b>${brl(a.amount_cents)}</b> em ${esc(a.category)}.\n` +
          `Seu gasto típico nessa categoria é de ${brl(a.median)}. Se estiver tudo certo, pode ignorar.`,
      );
      if (ok) sent++;
    }
  }
  return sent;
}

async function summaryText(ctx: AppContext, u: LinkedUser, period: "daily" | "weekly") {
  const t = today();
  const ym = currentMonth();
  const totals = await monthTotals(ctx.db, [u.id], ym);
  if (period === "daily") {
    const { rows } = await ctx.db.query<{ kind: string; cents: number; n: number }>(
      `SELECT kind, sum(amount_cents)::bigint AS cents, count(*)::int AS n FROM transactions
        WHERE user_id = $1 AND deleted_at IS NULL AND date = $2 GROUP BY kind`,
      [u.id, t],
    );
    const inc = rows.find((r) => r.kind === "income");
    const exp = rows.find((r) => r.kind === "expense");
    return (
      `🌙 <b>Seu dia</b>\n\n` +
      `Hoje: ${exp ? `${exp.n} despesa(s), ${brl(exp.cents)}` : "nenhuma despesa"}${inc ? ` · ${inc.n} receita(s), ${brl(inc.cents)}` : ""}\n` +
      `No mês (${monthNamePt(ym)}): ${signed(totals.incomeTotalCents - totals.expenseTotalCents)}`
    );
  }
  const from = addDays(t, -7);
  const { rows } = await ctx.db.query<{ cents: number }>(
    `SELECT COALESCE(sum(amount_cents),0)::bigint AS cents FROM transactions
      WHERE user_id = $1 AND deleted_at IS NULL AND kind='expense' AND date >= $2 AND date < $3`,
    [u.id, from, t],
  );
  const { rows: upcoming } = await ctx.db.query<{ n: number; cents: number }>(
    `SELECT count(*)::int AS n, COALESCE(sum(amount_cents),0)::bigint AS cents FROM transactions
      WHERE user_id = $1 AND deleted_at IS NULL AND kind='expense' AND status='pending' AND date BETWEEN $2 AND $3`,
    [u.id, t, addDays(t, 7)],
  );
  const { start, end } = monthRange(ym);
  return (
    `📊 <b>Resumo da semana</b>\n\n` +
    `Gastos dos últimos 7 dias: <b>${brl(rows[0].cents)}</b>\n` +
    `Mês até agora: receitas ${brl(totals.incomeTotalCents)} · despesas ${brl(totals.expenseTotalCents)}\n` +
    `Próximos 7 dias: ${upcoming[0].n ? `${upcoming[0].n} conta(s), ${brl(upcoming[0].cents)}` : "nenhuma conta"}\n\n` +
    `<i>Período do mês: ${dt(start)} a ${dt(end)}. Use /resumo para detalhes.</i>`
  );
}

/** Semana ISO no formato 2026-W46 (chave de idempotência do resumo semanal). */
function isoWeek(date: string) {
  const d = new Date(date + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export async function notifySummaries(ctx: AppContext, users: LinkedUser[], hour: number, weekday: number) {
  let sent = 0;
  const t = today();
  for (const u of users) {
    if (u.notify_daily && hour >= 20) {
      if (await notifyOnce(ctx, u, "daily", t, await summaryText(ctx, u, "daily"))) sent++;
    }
    if (u.notify_weekly && weekday === 1 && hour >= 9) {
      if (await notifyOnce(ctx, u, "weekly", isoWeek(t), await summaryText(ctx, u, "weekly"))) sent++;
    }
  }
  return sent;
}

/** Ponto de entrada chamado pelo agendador interno ou por /api/cron/run. */
export async function runScheduledJobs(ctx: AppContext, opts: { force?: boolean } = {}) {
  const result: Record<string, number> = {};
  result.recurrences = await generateAllRecurrences(ctx.db);
  // fila do WhatsApp (OpenBot): só enfileira; a entrega é feita pelo OpenBot
  try {
    const queued = await enqueueChannelNotifications(ctx, opts);
    result.whatsappQueued = Object.values(queued).reduce((s, n) => s + n, 0);
  } catch (err) {
    ctx.log.warn("fila_whatsapp.falhou", { err: (err as Error).message.slice(0, 160) });
  }
  await ctx.db.query("UPDATE telegram_pending_actions SET status = 'expired' WHERE channel = 'whatsapp' AND status = 'pending' AND expires_at < $1", [now()]);
  await ctx.db.query("DELETE FROM integration_requests WHERE created_at < $1", [new Date(now().getTime() - 7 * 86400000)]);
  if (!ctx.telegram) return { ...result, telegram: 0 };
  try {
    result.webhookRestored = (await ensureWebhook(ctx)) ? 1 : 0;
  } catch (err) {
    ctx.log.warn("telegram.webhook_verificacao_falhou", { err: (err as Error).message.slice(0, 160) });
  }
  const hour = localHour();
  const weekday = localWeekday();
  const users = await linkedUsers(ctx);
  // evita mandar mensagens de madrugada
  const daytime = opts.force || (hour >= 9 && hour <= 21);
  if (daytime) {
    result.due = await notifyDueBills(ctx, users);
    result.overdue = await notifyOverdue(ctx, users);
    result.goals = await notifyGoals(ctx, users);
    result.anomalies = await notifyAnomalies(ctx, users);
    result.summaries = await notifySummaries(ctx, users, opts.force ? Math.max(hour, 20) : hour, weekday);
  }
  // limpeza de dados temporários
  await ctx.db.query("DELETE FROM telegram_updates WHERE received_at < $1", [new Date(now().getTime() - 7 * 86400000)]);
  await ctx.db.query("UPDATE telegram_pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < $1", [now()]);
  await ctx.db.query("DELETE FROM sessions WHERE expires_at < $1", [now()]);
  return result;
}

export function startScheduler(ctx: AppContext, intervalMs = 10 * 60000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runScheduledJobs(ctx);
      if (Object.values(r).some((v) => v > 0)) ctx.log.info("agendador.rodada", r);
    } catch (err) {
      ctx.log.error("agendador.erro", { err: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  setTimeout(tick, 5000).unref();
  return () => clearInterval(timer);
}
