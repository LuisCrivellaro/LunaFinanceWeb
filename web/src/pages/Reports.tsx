import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { get, qs } from "../lib/api";
import { useApp, useMemberLookup, viewParam } from "../lib/app";
import { currentYm, dateShort, monthLong, monthName, money, pct, signedMoney } from "../lib/format";
import type { Report } from "../lib/types";
import { CategoryBars, FlowChart } from "../components/Charts";
import { Avatar, CardSkeleton, Empty, ErrorState, Money, ViewSwitch } from "../components/ui";

export function ReportsPage() {
  const { view } = useApp();
  const lookup = useMemberLookup();
  const [mode, setMode] = useState<"year" | "month">("year");
  const [year, setYear] = useState(currentYm().slice(0, 4));
  const [month, setMonth] = useState(currentYm());
  const v = viewParam(view);
  const params = mode === "year" ? { view: v, year } : { view: v, month };
  const r = useQuery({ queryKey: ["reports", params], queryFn: () => get<Report>(`/reports${qs(params)}`) });
  const d = r.data;
  const years = Array.from({ length: 6 }, (_, i) => String(Number(currentYm().slice(0, 4)) - i));
  const title = mode === "year" ? `Relatório de ${year}` : `Relatório de ${monthLong(month)}`;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">{view === "family" ? "Família" : typeof view === "number" ? lookup(view)?.name : "Individual"}</p>
          <h1>{title}</h1>
        </div>
        <div className="toolbar">
          <ViewSwitch allowPeople />
          <div className="segmented" role="group" aria-label="Período">
            <button aria-pressed={mode === "year"} onClick={() => setMode("year")}>Anual</button>
            <button aria-pressed={mode === "month"} onClick={() => setMode("month")}>Mensal</button>
          </div>
          {mode === "year" ? (
            <select className="select" style={{ width: "auto", height: 38 }} value={year} onChange={(e) => setYear(e.target.value)} aria-label="Ano">
              {years.map((y) => <option key={y}>{y}</option>)}
            </select>
          ) : (
            <input className="input" type="month" style={{ width: "auto", height: 38 }} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Mês" />
          )}
          {d && (
            <>
              <a className="btn" href={`/api/reports/export.csv${qs({ view: v, from: d.from, to: d.to })}`}><Download size={16} /> CSV</a>
              <button className="btn" onClick={() => window.print()}><Printer size={16} /> PDF</button>
            </>
          )}
        </div>
      </div>
      <div className="print-only" style={{ marginBottom: 16 }}>
        <strong>Luna Finance</strong> · {title} · gerado em {new Date().toLocaleDateString("pt-BR")}
      </div>

      {r.error && <ErrorState error={r.error} retry={() => r.refetch()} />}
      {!d && !r.error && <div className="grid grid-2"><CardSkeleton h={240} /><CardSkeleton h={240} /></div>}

      {d && (
        <div className="stack reveal">
          <div className="grid grid-4">
            <div className="card kpi">
              <span className="eyebrow">Receitas</span>
              <span className="value num">{money(d.totals.incomeCents)}</span>
            </div>
            <div className="card kpi">
              <span className="eyebrow">Despesas</span>
              <span className="value num">{money(d.totals.expenseCents)}</span>
              <span className="delta">média de {money(d.totals.avgMonthlyExpenseCents)}/mês</span>
            </div>
            <div className="card kpi">
              <span className="eyebrow">Resultado</span>
              <span className="value num">{signedMoney(d.totals.resultCents)}</span>
              <span className="delta">{d.totals.savingsRate !== null ? `${pct(d.totals.savingsRate)} da renda` : "sem receitas"}</span>
            </div>
            <div className="card kpi">
              <span className="eyebrow">Fixas × variáveis</span>
              <span className="value num" style={{ fontSize: 22 }}>{d.totals.expenseCents ? pct(Math.round((d.totals.fixedExpenseCents / d.totals.expenseCents) * 1000) / 10) : "—"}</span>
              <span className="delta">das despesas são fixas</span>
            </div>
          </div>

          {mode === "year" && (
            <div className="card">
              <div className="card-head"><h2>Receitas × despesas por mês <span className="faint" style={{ fontSize: 13, fontFamily: "var(--font-body)" }}>(R$)</span></h2></div>
              <FlowChart data={d.series} height={280} />
            </div>
          )}

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head"><h2>Despesas por categoria</h2></div>
              {d.expensesByCategory.length ? <CategoryBars data={d.expensesByCategory} limit={10} /> : <Empty title="Sem despesas no período" />}
            </div>
            <div className="card">
              <div className="card-head"><h2>Receitas por categoria</h2></div>
              {d.incomeByCategory.length ? <CategoryBars data={d.incomeByCategory} limit={10} /> : <Empty title="Sem receitas no período" />}
            </div>
          </div>

          {d.byMember && d.byMember.length > 0 && view !== "me" && (
            <div className="card">
              <div className="card-head"><h2>Por responsável</h2></div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Integrante</th><th className="r">Receitas</th><th className="r">Despesas</th><th className="r">Resultado</th></tr></thead>
                  <tbody>
                    {[...d.byMember].sort((a, b) => (lookup(a.userId)?.name ?? "").localeCompare(lookup(b.userId)?.name ?? "")).map((m) => {
                      const who = lookup(m.userId);
                      return (
                        <tr key={m.userId}>
                          <td><span className="row">{who && <Avatar name={who.name} color={who.color} size="sm" />}{who?.name}</span></td>
                          <td className="r num">{money(m.incomeCents)}</td>
                          <td className="r num">{money(m.expenseCents)}</td>
                          <td className="r num">{signedMoney(m.incomeCents - m.expenseCents)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head"><h2>Tabela mensal</h2></div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Mês</th><th className="r">Receitas</th><th className="r">Despesas</th><th className="r">Resultado</th></tr></thead>
                  <tbody>
                    {d.series.map((s) => (
                      <tr key={s.month}>
                        <td style={{ textTransform: "capitalize" }}>{monthName(s.month)}</td>
                        <td className="r num">{money(s.incomeCents)}</td>
                        <td className="r num">{money(s.expenseCents)}</td>
                        <td className="r num">{signedMoney(s.resultCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>Maiores despesas</h2></div>
              {d.topExpenses.length ? (
                <div className="list">
                  {d.topExpenses.map((t) => (
                    <div className="list-item" key={t.id} style={{ gridTemplateColumns: "1fr auto" }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="title">{t.description}</div>
                        <div className="sub">{dateShort(t.date)} · {t.categoryName ?? "Sem categoria"}{view !== "me" && lookup(t.userId) ? ` · ${lookup(t.userId)!.name}` : ""}</div>
                      </div>
                      <Money cents={t.amountCents} className="amount" />
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title={d.detail ? "Sem despesas no período" : "Disponível só com acesso completo"} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
