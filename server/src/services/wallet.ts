/**
 * Cartões da família (painel). Os 4 cartões de crédito da família estão
 * vinculados à conta de Luís Carlos, com fatura única consolidada.
 *
 * O sistema não tem cadastro de cartões (limite, fechamento, vencimento): por
 * isso aqui NÃO existe limite nem saldo de cartão. O único dado do cartão é o
 * final de 4 dígitos que cada pessoa (ou quem gerencia a família) cadastra.
 * Tudo sai dos lançamentos já registrados:
 *   - gastos do mês do titular   = despesas dele no mês (competência), qualquer forma de pagamento
 *   - compras no cartão do mês   = despesas dele com forma de pagamento "cartão de crédito"
 *   - compras no cartão (família) = soma das compras no cartão dos titulares, contadas uma única vez
 * Ciclo de fatura (fechamento/vencimento) não é modelado: os valores são do
 * mês de calendário e a interface diz isso.
 */
import type { Queryable } from "../db/index.js";
import { currentMonth, isYearMonth, monthRange, today } from "../lib/clock.js";
import { canSeeDetailsOf, type AuthUser } from "./access.js";
import { listMembers } from "./members.js";
import { TX_SELECT, type TransactionRow } from "./transactions.js";

/** Ordem e parentesco dos titulares, pelo primeiro nome (sem acento). */
const FAMILY_CARDS: Array<{ firstName: string; relation: string; invoiceHolder?: boolean }> = [
  { firstName: "luis", relation: "Pai", invoiceHolder: true },
  { firstName: "luciana", relation: "Mãe" },
  { firstName: "lipe", relation: "Filho 1" },
  { firstName: "joao", relation: "Filho 2" },
];

const normalize = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().split(/\s+/)[0] ?? "";

export interface WalletCard {
  userId: number;
  name: string;
  relation: string | null;
  color: string;
  invoiceHolder: boolean;
  /** Final do cartão cadastrado; null = não cadastrado ou sem acesso. */
  last4: string | null;
  /** null = quem está vendo não tem acesso aos totais desta pessoa. */
  expenseCents: number | null;
  cardCents: number | null;
  expenseCount: number | null;
  /** null = sem acesso aos lançamentos desta pessoa (só totais ou nada). */
  recent: TransactionRow[] | null;
}

export async function wallet(q: Queryable, viewer: AuthUser, month?: string) {
  const ym = month && isYearMonth(month) ? month : currentMonth();
  const { start, end } = monthRange(ym);
  const t = today();
  const listEnd = end < t ? end : t; // "recentes" = até hoje

  const members = await listMembers(q);
  const ordered = members
    .map((m) => {
      const idx = FAMILY_CARDS.findIndex((c) => c.firstName === normalize(m.name));
      return { m, idx: idx < 0 ? FAMILY_CARDS.length : idx, cfg: idx < 0 ? undefined : FAMILY_CARDS[idx] };
    })
    .sort((a, b) => a.idx - b.idx || a.m.name.localeCompare(b.m.name, "pt-BR"));

  const canSeeTotalsOf = (id: number) => id === viewer.id || viewer.family_access !== "none";
  const ids = members.map((m) => m.id);

  const { rows: totals } = await q.query<{ userId: number; expense: number; card: number; n: number }>(
    `SELECT t.user_id AS "userId",
            COALESCE(sum(t.amount_cents), 0)::bigint AS expense,
            COALESCE(sum(t.amount_cents) FILTER (WHERE t.payment_method = 'credit_card'), 0)::bigint AS card,
            count(*)::int AS n
       FROM transactions t
      WHERE t.deleted_at IS NULL AND t.kind = 'expense' AND t.user_id = ANY($1::int[]) AND t.date BETWEEN $2 AND $3
      GROUP BY t.user_id`,
    [ids, start, end],
  );
  const byUser = new Map(totals.map((r) => [r.userId, r]));
  const { rows: finals } = await q.query<{ id: number; last4: string | null }>(
    "SELECT id, card_last4 AS last4 FROM users WHERE id = ANY($1::int[])",
    [ids],
  );
  const last4Of = new Map(finals.map((r) => [r.id, r.last4]));

  const cards: WalletCard[] = await Promise.all(
    ordered.map(async ({ m, cfg }) => {
      const seeTotals = canSeeTotalsOf(m.id);
      const seeDetail = canSeeDetailsOf(viewer, m.id);
      let recent: TransactionRow[] | null = null;
      if (seeDetail) {
        const { rows } =
          start > listEnd
            ? { rows: [] as TransactionRow[] }
            : await q.query<TransactionRow>(
                `${TX_SELECT.replace("$TODAY", "$4::date")}
                  WHERE t.deleted_at IS NULL AND t.kind = 'expense' AND t.user_id = $1 AND t.date BETWEEN $2 AND $3
                  ORDER BY t.date DESC, t.id DESC LIMIT 5`,
                [m.id, start, listEnd, t],
              );
        recent = rows;
      }
      const tot = byUser.get(m.id);
      return {
        userId: m.id,
        name: m.name,
        relation: cfg?.relation ?? null,
        color: m.color,
        invoiceHolder: Boolean(cfg?.invoiceHolder),
        last4: seeTotals ? (last4Of.get(m.id) ?? null) : null,
        expenseCents: seeTotals ? (tot?.expense ?? 0) : null,
        cardCents: seeTotals ? (tot?.card ?? 0) : null,
        expenseCount: seeTotals ? (tot?.n ?? 0) : null,
        recent,
      };
    }),
  );

  const holder = cards.find((c) => c.invoiceHolder) ?? null;
  const familyVisible = viewer.family_access !== "none";
  return {
    month: ym,
    invoice: {
      holderId: holder?.userId ?? null,
      holderName: holder?.name ?? null,
      // soma única das compras no cartão de todos os titulares (sem dupla contagem)
      familyCardCents: familyVisible ? totals.reduce((s, r) => s + r.card, 0) : null,
    },
    cards,
  };
}
