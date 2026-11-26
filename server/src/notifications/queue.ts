/**
 * Fila persistente de avisos para o WhatsApp (via OpenBot).
 *
 * O agendador existente chama `enqueueChannelNotifications` a cada rodada. Cada
 * aviso tem uma chave de deduplicação (pessoa + tipo + referência): rodar o job
 * várias vezes nunca duplica. NADA é enviado daqui — o OpenBot busca os avisos
 * (`claim`), entrega pelo WhatsApp e confirma (`ack`). Aviso pego e não
 * confirmado volta para a fila depois do prazo de reserva.
 */
import type { AppContext } from "../context.js";
import type { Db } from "../db/index.js";
import { addDays, currentMonth, localHour, localWeekday, monthNamePt, monthRange, now, shiftMonth, today } from "../lib/clock.js";
import { randomToken } from "../lib/crypto.js";
import { formatBRL } from "../lib/money.js";
import { getAuthUser } from "../services/auth.js";
import { budgetStatus } from "../services/budgets.js";
import { getCardSettings, invoiceCycle, invoiceMonthFor, invoiceSummary, limitStatus } from "../services/cards.js";
import { monthTotals } from "../services/insights.js";
import { getSettings } from "../integrations/openbot/identity.js";

export const CLAIM_LEASE_MIN = 5;
export const MAX_ATTEMPTS = 5;

interface Recipient {
  id: number;
  name: string;
  family_access: string;
  notify_due_days: number;
  notify_overdue: boolean;
  notify_weekly: boolean;
}

export interface QueuedPayload {
  title: string;
  text: string;
  data: Record<string, unknown>;
}

export async function enqueue(db: Db, userId: number, kind: string, dedupKey: string, payload: QueuedPayload, ttlHours = 72) {
  const r = await db.query<{ id: number }>(
    `INSERT INTO notification_queue (user_id, kind, dedup_key, payload, expires_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (channel, user_id, kind, dedup_key) DO NOTHING RETURNING id`,
    [userId, kind, dedupKey, JSON.stringify(payload), new Date(now().getTime() + ttlHours * 3600000)],
  );
  return Boolean(r.rows[0]);
}

async function recipients(db: Db): Promise<Recipient[]> {
  const { rows } = await db.query<Recipient>(
    `SELECT u.id, u.name, u.family_access, u.notify_due_days, u.notify_overdue, u.notify_weekly
       FROM users u JOIN whatsapp_links l ON l.user_id = u.id WHERE u.active`,
  );
  return rows;
}

function isoWeek(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Gera os avisos devidos agora (só com a integração ligada e para quem vinculou o WhatsApp). */
export async function enqueueChannelNotifications(ctx: AppContext, opts: { force?: boolean } = {}) {
  const db = ctx.db;
  const settings = await getSettings(db);
  const out = { due: 0, overdue: 0, invoice: 0, budget: 0, limit: 0, weekly: 0, monthly: 0 };
  if (!settings.enabled) return out;
  const people = await recipients(db);
  if (!people.length) return out;
  const t = today();
  const hour = localHour();
  const weekday = localWeekday();
  const daytime = opts.force || (hour >= 9 && hour <= 21);
  if (!daytime) return out;
  const cards = await getCardSettings(db);

  for (const u of people) {
    const user = await getAuthUser(db, u.id);
    if (!user) continue;

    // contas a vencer (antecedência escolhida pela pessoa) e atrasadas
    if (u.notify_due_days > 0) {
      const { rows } = await db.query<{ id: number; description: string; amount_cents: number; date: string }>(
        `SELECT id, description, amount_cents, date FROM transactions WHERE deleted_at IS NULL AND user_id = $1
           AND kind = 'expense' AND status = 'pending' AND date BETWEEN $2 AND $3 ORDER BY date`,
        [u.id, t, addDays(t, u.notify_due_days)],
      );
      for (const r of rows) {
        const ok = await enqueue(db, u.id, "bill_due", `${r.id}:${r.date}`, {
          title: "Conta a vencer",
          text: `${r.description} — ${formatBRL(r.amount_cents)} vence em ${r.date}.`,
          data: { transactionId: r.id, description: r.description, amountCents: r.amount_cents, dueDate: r.date },
        });
        if (ok) out.due++;
      }
    }
    if (u.notify_overdue) {
      const { rows } = await db.query<{ id: number; description: string; amount_cents: number; date: string }>(
        `SELECT id, description, amount_cents, date FROM transactions WHERE deleted_at IS NULL AND user_id = $1
           AND kind = 'expense' AND status = 'pending' AND date < $2 ORDER BY date LIMIT 10`,
        [u.id, t],
      );
      for (const r of rows) {
        const ok = await enqueue(db, u.id, "bill_overdue", `${r.id}:${r.date}`, {
          title: "Conta atrasada",
          text: `${r.description} — ${formatBRL(r.amount_cents)} venceu em ${r.date} e ainda está pendente.`,
          data: { transactionId: r.id, description: r.description, amountCents: r.amount_cents, dueDate: r.date },
        });
        if (ok) out.overdue++;
      }
    }

    // orçamentos: 70%, 90% e 100% (cada nível uma vez por mês)
    for (const b of await budgetStatus(db, user)) {
      if (b.level === "ok") continue;
      if (b.scope === "individual" && b.ownerId !== u.id) continue;
      const ok = await enqueue(db, u.id, `budget_${b.level}`, `${b.id}:${b.month}`, {
        title: b.level === "100" ? "Orçamento estourado" : "Orçamento perto do limite",
        text: `${b.scope === "family" ? "Orçamento da família" : "Seu orçamento"}${b.categoryName ? ` de ${b.categoryName}` : ""}: ` +
          `${formatBRL(b.spentCents)} de ${formatBRL(b.amountCents)} (${b.percent}%).`,
        data: { budgetId: b.id, scope: b.scope, categoryName: b.categoryName, amountCents: b.amountCents, spentCents: b.spentCents, percent: b.percent, level: b.level, month: b.month },
      });
      if (ok) out.budget++;
    }

    // fatura e limite: para o titular (e quem enxerga a família)
    const seesFamily = u.family_access !== "none" || cards.holderUserId === u.id;
    if (cards.cycleConfigured && seesFamily) {
      const month = invoiceMonthFor(addDays(t, -1), cards.closingDay!);
      const cyc = invoiceCycle(month, cards.closingDay!, cards.dueDay!);
      if (cyc.closingDate <= t && cyc.dueDate >= t && cyc.dueDate <= addDays(t, 5) && cards.holderUserId === u.id) {
        const inv = await invoiceSummary(db, user, month);
        if (inv.cycleConfigured && inv.status !== "paid" && inv.totalCents) {
          const ok = await enqueue(db, u.id, "invoice_due", month, {
            title: "Fatura do cartão a vencer",
            text: `A fatura da família (${month}) de ${formatBRL(inv.totalCents)} vence em ${cyc.dueDate}.`,
            data: { invoiceMonth: month, totalCents: inv.totalCents, dueDate: cyc.dueDate, perMember: inv.perMember },
          });
          if (ok) out.invoice++;
        }
      }
      const lim = await limitStatus(db, user);
      if (lim.configured && "visible" in lim && lim.visible && lim.percentUsed >= 90 && cards.holderUserId === u.id) {
        const level = lim.percentUsed >= 100 ? "100" : "90";
        const ok = await enqueue(db, u.id, `card_limit_${level}`, invoiceMonthFor(t, cards.closingDay!), {
          title: level === "100" ? "Limite do cartão ultrapassado" : "Limite do cartão quase no fim",
          text: `Comprometido ${formatBRL(lim.committedCents)} de ${formatBRL(lim.limitCents)} (${lim.percentUsed}%), pelos lançamentos registrados.`,
          data: { ...lim, level },
        });
        if (ok) out.limit++;
      }
    }

    // resumo semanal (segunda, a partir das 9h)
    if (u.notify_weekly && weekday === 1 && (opts.force || hour >= 9)) {
      const from = addDays(t, -7);
      const { rows } = await db.query<{ income: number; expense: number }>(
        `SELECT COALESCE(sum(amount_cents) FILTER (WHERE kind='income'),0)::bigint AS income,
                COALESCE(sum(amount_cents) FILTER (WHERE kind='expense'),0)::bigint AS expense
           FROM transactions WHERE deleted_at IS NULL AND user_id = $1 AND date BETWEEN $2 AND $3`,
        [u.id, from, addDays(t, -1)],
      );
      const ok = await enqueue(db, u.id, "weekly_summary", isoWeek(t), {
        title: "Resumo da semana",
        text: `Últimos 7 dias: entrou ${formatBRL(rows[0].income)}, saiu ${formatBRL(rows[0].expense)}.`,
        data: { from, to: addDays(t, -1), incomeCents: rows[0].income, expenseCents: rows[0].expense },
      }, 7 * 24);
      if (ok) out.weekly++;
    }

    // relatório mensal (dia 1): pessoa + evolução; consolidado para quem enxerga a família
    if (Number(t.slice(8, 10)) === 1 || opts.force) {
      const prev = shiftMonth(currentMonth(), -1);
      const before = shiftMonth(prev, -1);
      const mine = await monthTotals(db, [u.id], prev);
      const mineBefore = await monthTotals(db, [u.id], before);
      const data: Record<string, unknown> = {
        month: prev,
        incomeCents: mine.incomeTotalCents,
        expenseCents: mine.expenseTotalCents,
        previousExpenseCents: mineBefore.expenseTotalCents,
        expenseChangePercent: mineBefore.expenseTotalCents ? Math.round(((mine.expenseTotalCents - mineBefore.expenseTotalCents) / mineBefore.expenseTotalCents) * 1000) / 10 : null,
      };
      if (u.family_access !== "none") {
        const { rows } = await db.query<{ id: number; name: string }>("SELECT id, name FROM users WHERE active ORDER BY id");
        const members = [];
        for (const m of rows) {
          const tot = await monthTotals(db, [m.id], prev);
          const tb = await monthTotals(db, [m.id], before);
          members.push({ userId: m.id, name: m.name, expenseCents: tot.expenseTotalCents, previousExpenseCents: tb.expenseTotalCents });
        }
        data.family = { expenseCents: members.reduce((s, m) => s + m.expenseCents, 0), members };
      }
      const ok = await enqueue(db, u.id, "monthly_report", prev, {
        title: `Relatório de ${monthNamePt(prev)}`,
        text: `Em ${monthNamePt(prev)}: entrou ${formatBRL(mine.incomeTotalCents)}, saiu ${formatBRL(mine.expenseTotalCents)}.`,
        data,
      }, 7 * 24);
      if (ok) out.monthly++;
    }
  }
  // avisos vencidos saem da fila; reservas abandonadas voltam
  await db.query("UPDATE notification_queue SET status = 'cancelled' WHERE status IN ('pending','claimed') AND expires_at < $1", [now()]);
  await db.query(
    "UPDATE notification_queue SET status = 'pending', claim_token = NULL WHERE status = 'claimed' AND claimed_at < $1",
    [new Date(now().getTime() - CLAIM_LEASE_MIN * 60000)],
  );
  return out;
}

/**
 * O OpenBot reserva até `limit` avisos. Cada um traz o destinatário (número
 * vinculado) — necessário para a entrega — e um `claimToken` para o ack.
 */
export async function claimNotifications(db: Db, limit: number) {
  const token = randomToken(12);
  const lease = new Date(now().getTime() - CLAIM_LEASE_MIN * 60000);
  return db.tx(async (q) => {
    // devolve à fila reservas vencidas
    await q.query("UPDATE notification_queue SET status = 'pending', claim_token = NULL WHERE status = 'claimed' AND claimed_at < $1", [lease]);
    const { rows } = await q.query<{ id: number }>(
      `SELECT n.id FROM notification_queue n JOIN whatsapp_links l ON l.user_id = n.user_id
        WHERE n.status = 'pending' AND n.expires_at > $1 AND n.attempts < $2 ORDER BY n.created_at LIMIT $3`,
      [now(), MAX_ATTEMPTS, limit],
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    await q.query("UPDATE notification_queue SET status = 'claimed', claim_token = $2, claimed_at = $3, attempts = attempts + 1 WHERE id = ANY($1::bigint[])", [ids, token, now()]);
    const { rows: items } = await q.query<{ id: number; kind: string; payload: unknown; user_id: number; name: string; phone_e164: string; created_at: Date; expires_at: Date; attempts: number }>(
      `SELECT n.id, n.kind, n.payload, n.user_id, u.name, l.phone_e164, n.created_at, n.expires_at, n.attempts
         FROM notification_queue n JOIN users u ON u.id = n.user_id JOIN whatsapp_links l ON l.user_id = n.user_id
        WHERE n.id = ANY($1::bigint[]) ORDER BY n.created_at`,
      [ids],
    );
    return items.map((i) => ({
      id: Number(i.id),
      kind: i.kind,
      claimToken: token,
      recipient: { userId: i.user_id, name: i.name, phoneE164: i.phone_e164 },
      payload: typeof i.payload === "string" ? JSON.parse(i.payload) : i.payload,
      createdAt: i.created_at,
      expiresAt: i.expires_at,
      attempt: i.attempts,
    }));
  });
}

export async function ackNotification(db: Db, id: number, claimToken: string, status: "delivered" | "failed", error?: string) {
  const r = await db.query(
    `UPDATE notification_queue
        SET status = CASE WHEN $3 = 'delivered' THEN 'delivered' WHEN attempts >= $5 THEN 'failed' ELSE 'pending' END,
            delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE NULL END,
            last_error = $4, claim_token = NULL
      WHERE id = $1 AND claim_token = $2 AND status = 'claimed'`,
    [id, claimToken, status, error ? error.slice(0, 200) : null, MAX_ATTEMPTS],
  );
  return r.rowCount > 0;
}

export async function queueCounts(db: Db) {
  const { rows } = await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM notification_queue GROUP BY status");
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export { monthRange };
