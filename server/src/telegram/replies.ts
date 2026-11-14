/**
 * Textos das consultas do bot. Todo número vem de data.ts (banco de dados).
 */
import type { Queryable } from "../db/index.js";
import { addDays, currentMonth, monthNamePt, shiftMonth, today } from "../lib/clock.js";
import type { AuthUser } from "../services/access.js";
import { PAYMENT_LABELS } from "../services/transactions.js";
import type { InlineButton } from "./api.js";
import {
  compareMonths, familyOverview, getBalance, getCategoryBreakdown, getCategoryTotal, getEvolution, getFlow, getGoals,
  getPendingBills, getPeriodTotals, getTransactionsList, type GoalDetail,
} from "./data.js";
import { bar, brl, dt, dtFull, esc, signed } from "./format.js";
import { monthPeriod, type Period, type Query } from "./nlu.js";

export interface Reply {
  text: string;
  keyboard?: InlineButton[][];
}

export function dateLabel(iso: string, t = today()) {
  if (iso === t) return "Hoje";
  if (iso === addDays(t, -1)) return "Ontem";
  if (iso === addDays(t, 1)) return "Amanhã";
  return dtFull(iso);
}

const pct = (n: number) => `${n.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const REPORT_MENU: InlineButton[][] = [
  [{ text: "Hoje", callback_data: "r:today" }, { text: "Semana", callback_data: "r:week" }, { text: "Mês", callback_data: "r:month" }],
  [{ text: "Por categoria", callback_data: "r:cat" }, { text: "Comparar meses", callback_data: "r:cmp" }],
  [{ text: "Maiores despesas", callback_data: "r:top" }, { text: "Receitas × despesas", callback_data: "r:flow" }],
  [{ text: "Evolução do saldo", callback_data: "r:evo" }],
];

export function reportQuery(key: string): Query | null {
  const t = today();
  switch (key) {
    case "today":
      return { q: "summary", period: { from: t, to: t, label: "hoje" } };
    case "week":
      return { q: "summary", period: { from: addDays(t, -6), to: t, label: "últimos 7 dias" } };
    case "month":
      return { q: "summary", period: monthPeriod(currentMonth()) };
    case "cat":
      return { q: "by_category", period: monthPeriod(currentMonth()) };
    case "cmp":
      return { q: "compare", ym: currentMonth() };
    case "top":
      return { q: "top", period: monthPeriod(currentMonth()) };
    case "flow":
      return { q: "flow" };
    case "evo":
      return { q: "evolution" };
    default:
      return null;
  }
}

function periodTitle(p: Period) {
  return p.label.startsWith("em ") || p.label === "hoje" || p.label === "ontem" || p.label.startsWith("últimos") || p.label.startsWith("semana") ? p.label : `em ${p.label}`;
}

export function goalText(g: GoalDetail) {
  let s =
    `🎯 <b>${esc(g.name)}</b>${g.scope === "family" ? " · família" : ""}\n` +
    `${bar(g.percent)} ${pct(g.percent)}\n` +
    `Guardado: <b>${brl(g.savedCents)}</b> de ${brl(g.targetCents)}\n`;
  if (g.achieved) return s + "Meta atingida! 🎉";
  s += `Falta: <b>${brl(g.remainingCents)}</b>`;
  if (g.deadline) s += `\nPrazo: ${dtFull(g.deadline)}${g.monthlyNeededCents ? ` · guardar ~${brl(g.monthlyNeededCents)}/mês` : ""}`;
  if (g.estimatedMonths !== null && g.avgMonthlyCents) {
    s += `\nNo seu ritmo atual (~${brl(g.avgMonthlyCents)}/mês): cerca de ${plural(g.estimatedMonths, "mês", "meses")}.`;
  } else {
    s += "\nAinda não há contribuições recentes suficientes para estimar o prazo.";
  }
  return s;
}

export async function buildReply(q: Queryable, user: AuthUser, query: Query): Promise<Reply> {
  const ids = [user.id];
  const t = today();

  switch (query.q) {
    case "balance": {
      const b = await getBalance(q, user);
      const lines = b.accounts.map((a) => `• ${esc(a.name)}: ${brl(a.balanceCents)}`).join("\n");
      const bills = await getPendingBills(q, user.id, 7);
      const due = [...bills.overdue, ...bills.upcoming].reduce((s, r) => s + r.amountCents, 0);
      return {
        text:
          `💼 <b>Seu saldo: ${brl(b.totalCents)}</b>\n\n${lines || "Nenhuma conta cadastrada."}` +
          (due ? `\n\nContas pendentes (atrasadas + próximos 7 dias): ${brl(due)}` : ""),
      };
    }

    case "family": {
      try {
        const p = monthPeriod(currentMonth());
        const f = await familyOverview(q, user, p.from, p.to);
        let text =
          `👨‍👩‍👦‍👦 <b>Família — ${p.label}</b>\n\n` +
          `Saldo total: <b>${brl(f.balanceCents)}</b>\nReceitas: ${brl(f.totals.incomeCents)}\nDespesas: ${brl(f.totals.expenseCents)}\n` +
          `Resultado: <b>${signed(f.totals.resultCents)}</b>`;
        if (f.perMember) text += "\n\n<b>Por pessoa</b>\n" + f.perMember.map((m) => `• ${esc(m.name)}: ${brl(m.expenseCents)} em despesas`).join("\n");
        return { text };
      } catch {
        return { text: "Sua conta não tem acesso aos dados da família. As permissões são ajustadas no site." };
      }
    }

    case "spend": {
      const label = periodTitle(query.period);
      if (query.categoryId) {
        const c = await getCategoryTotal(q, ids, query.categoryId, query.period.from, query.period.to);
        return {
          text:
            `📂 <b>${esc(c.categoryName)}</b> ${label}\n\n` +
            (c.count ? `${query.kind === "income" ? "Recebido" : "Gasto"}: <b>${brl(c.cents)}</b> em ${plural(c.count, "lançamento", "lançamentos")}.` : "Nenhum lançamento nessa categoria no período."),
        };
      }
      const tot = await getPeriodTotals(q, ids, query.period.from, query.period.to);
      const cats = (await getCategoryBreakdown(q, ids, query.period.from, query.period.to, query.kind)).slice(0, 5);
      const total = query.kind === "income" ? tot.incomeCents : tot.expenseCents;
      const done = query.kind === "income" ? tot.incomePaidCents : tot.expensePaidCents;
      return {
        text:
          `${query.kind === "income" ? "💰 <b>Receitas" : "💸 <b>Despesas"} ${label}: ${brl(total)}</b>\n` +
          (total !== done ? `${query.kind === "income" ? "Já recebido" : "Já pago"}: ${brl(done)}\n` : "") +
          (cats.length ? "\n" + cats.map((c) => `• ${esc(c.name)}: ${brl(c.cents)} (${pct(c.percent)})`).join("\n") : "\nNada registrado no período."),
      };
    }

    case "last": {
      const items = await getTransactionsList(q, ids, { kind: query.kind, limit: query.limit, to: t });
      if (!items.length) return { text: query.kind === "income" ? "Você ainda não tem receitas registradas." : "Você ainda não tem despesas registradas." };
      return {
        text:
          `${query.kind === "income" ? "💰 <b>Últimas receitas</b>" : "💸 <b>Últimas despesas</b>"}\n\n` +
          items
            .map((i) => `• ${dt(i.date)} — ${esc(i.description)}: <b>${brl(i.amountCents)}</b>${i.category ? ` · ${esc(i.category)}` : ""}${i.paymentMethod ? ` · ${PAYMENT_LABELS[i.paymentMethod]}` : ""}`)
            .join("\n"),
      };
    }

    case "compare": {
      const c = await compareMonths(q, ids, query.ym);
      const cur = monthNamePt(c.current.month).split(" ")[0];
      const prev = monthNamePt(c.previous.month).split(" ")[0];
      const range = c.sameDayRange ? ` (até o dia ${Number(c.current.to.slice(8, 10))} de cada mês)` : "";
      let text =
        `📊 <b>${cur} × ${prev}</b>${range}\n\n` +
        `Despesas: ${brl(c.current.expenseCents)} × ${brl(c.previous.expenseCents)}\n` +
        `Diferença: <b>${signed(c.expenseDeltaCents)}</b>${c.expenseDeltaPercent !== null ? ` (${c.expenseDeltaPercent > 0 ? "+" : ""}${pct(c.expenseDeltaPercent)})` : ""}\n` +
        `Receitas: ${brl(c.current.incomeCents)} × ${brl(c.previous.incomeCents)}`;
      const moved = c.categories.filter((x) => x.deltaCents !== 0).slice(0, 4);
      if (moved.length) text += "\n\n<b>Maiores variações</b>\n" + moved.map((x) => `• ${esc(x.name)}: ${signed(x.deltaCents)}`).join("\n");
      return { text };
    }

    case "bills":
    case "upcoming": {
      const b = await getPendingBills(q, user.id, query.q === "upcoming" ? 15 : 30);
      if (!b.overdue.length && !b.upcoming.length) return { text: query.q === "upcoming" ? "Nenhum vencimento nos próximos 15 dias. 🎉" : "Nenhuma conta pendente nos próximos 30 dias. 🎉" };
      let text = query.q === "upcoming" ? "📅 <b>Próximos vencimentos</b>\n" : "🧾 <b>Suas contas a pagar</b>\n";
      const line = (r: { description: string; amountCents: number; date: string }) => `• ${dt(r.date)} — ${esc(r.description)}: <b>${brl(r.amountCents)}</b>`;
      if (b.overdue.length && query.q === "bills") text += `\n⚠️ <b>Atrasadas</b> (${brl(b.overdue.reduce((s, r) => s + r.amountCents, 0))})\n${b.overdue.map(line).join("\n")}\n`;
      if (b.upcoming.length) text += `\n<b>A vencer</b> (${brl(b.upcoming.reduce((s, r) => s + r.amountCents, 0))})\n${b.upcoming.map(line).join("\n")}`;
      const pay = [...(query.q === "bills" ? b.overdue : []), ...b.upcoming].slice(0, 5);
      return { text, keyboard: pay.map((r) => [{ text: `Pagar: ${r.description.slice(0, 36)}`, callback_data: `p:${r.id}` }]) };
    }

    case "goals": {
      const goals = await getGoals(q, user);
      if (!goals.length) return { text: "Você ainda não tem metas.\nEnvie, por exemplo: <i>criar meta de 10 mil para viagem até 12/2027</i>", keyboard: [[{ text: "➕ Nova meta", callback_data: "gn" }]] };
      return {
        text: "🎯 <b>Metas</b>\n\n" + goals.map((g) => `<b>${esc(g.name)}</b>${g.scope === "family" ? " · família" : ""}\n${bar(g.percent)} ${pct(g.percent)} · falta ${brl(g.remainingCents)}`).join("\n\n"),
        keyboard: [
          ...goals.slice(0, 6).map((g) => [{ text: `Ver ${g.name.slice(0, 30)}`, callback_data: `g:${g.id}` }, { text: "Guardar", callback_data: `gc:${g.id}` }]),
          [{ text: "➕ Nova meta", callback_data: "gn" }],
        ],
      };
    }

    case "goal": {
      const g = (await getGoals(q, user)).find((x) => x.id === query.goalId);
      if (!g) return { text: "Não encontrei essa meta entre as suas." };
      return { text: goalText(g), keyboard: g.achieved ? undefined : [[{ text: "Guardar dinheiro nela", callback_data: `gc:${g.id}` }]] };
    }

    case "summary": {
      const p = query.period;
      const [tot, cats, bal, bills] = await Promise.all([
        getPeriodTotals(q, ids, p.from, p.to),
        getCategoryBreakdown(q, ids, p.from, p.to, "expense"),
        getBalance(q, user),
        getPendingBills(q, user.id, 7),
      ]);
      let text =
        `📋 <b>Resumo ${periodTitle(p)}</b>\n\n` +
        `Saldo atual: <b>${brl(bal.totalCents)}</b>\n` +
        `Receitas: ${brl(tot.incomeCents)}\nDespesas: ${brl(tot.expenseCents)}\n` +
        `Resultado: <b>${signed(tot.resultCents)}</b>`;
      if (cats.length) text += `\n\n<b>Maiores gastos</b>\n${cats.slice(0, 3).map((c) => `• ${esc(c.name)}: ${brl(c.cents)}`).join("\n")}`;
      if (bills.overdue.length) text += `\n\n⚠️ ${plural(bills.overdue.length, "conta atrasada", "contas atrasadas")} — /contas`;
      if (bills.upcoming.length) text += `\n📅 ${plural(bills.upcoming.length, "vencimento", "vencimentos")} nos próximos 7 dias`;
      if (!tot.count) text += "\n\nNenhuma movimentação no período.";
      return { text, keyboard: REPORT_MENU };
    }

    case "by_category": {
      const cats = await getCategoryBreakdown(q, ids, query.period.from, query.period.to, "expense");
      if (!cats.length) return { text: `Sem despesas ${periodTitle(query.period)}.` };
      return { text: `📂 <b>Gastos por categoria ${periodTitle(query.period)}</b>\n\n` + cats.slice(0, 10).map((c) => `• ${esc(c.name)}: ${brl(c.cents)} (${pct(c.percent)})`).join("\n") };
    }

    case "top": {
      const items = await getTransactionsList(q, ids, { kind: "expense", from: query.period.from, to: query.period.to, order: "largest", limit: 5 });
      if (!items.length) return { text: `Sem despesas ${periodTitle(query.period)}.` };
      return { text: `🔝 <b>Maiores despesas ${periodTitle(query.period)}</b>\n\n` + items.map((i, n) => `${n + 1}. ${esc(i.description)} — <b>${brl(i.amountCents)}</b> (${dt(i.date)})`).join("\n") };
    }

    case "flow": {
      const s = await getFlow(q, ids, 6);
      return {
        text:
          "📈 <b>Receitas × despesas (6 meses)</b>\n\n" +
          s.map((m) => `• ${monthNamePt(m.month).split(" ")[0].slice(0, 3)}: ${brl(m.incomeCents)} × ${brl(m.expenseCents)} → ${signed(m.resultCents)}`).join("\n"),
      };
    }

    case "evolution": {
      const s = await getEvolution(q, ids, 6);
      const first = s[0]?.balanceCents ?? 0;
      const last = s[s.length - 1]?.balanceCents ?? 0;
      return {
        text:
          "📉 <b>Evolução do saldo (fim de cada mês)</b>\n\n" +
          s.map((m) => `• ${monthNamePt(m.month).split(" ")[0].slice(0, 3)}: ${brl(m.balanceCents)}`).join("\n") +
          `\n\nVariação no período: <b>${signed(last - first)}</b>`,
      };
    }
  }
}

export function previousMonthLabel() {
  return monthNamePt(shiftMonth(currentMonth(), -1));
}
