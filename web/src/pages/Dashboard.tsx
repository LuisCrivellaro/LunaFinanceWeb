import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CalendarCheck, ChevronLeft, ChevronRight, Target } from "lucide-react";
import { get, qs } from "../lib/api";
import { useApp, useMe, useMemberLookup, viewParam } from "../lib/app";
import { currentYm, dateShort, firstName, monthLong, money, relativeDue, shiftYm, signedMoney, todayIso } from "../lib/format";
import type { Dashboard, Transaction } from "../lib/types";
import { BalanceChart, CategoryBars, FlowChart } from "../components/Charts";
import { Avatar, CardSkeleton, CategoryIcon, Empty, ErrorState, Money, MoonPhase, Skeleton, ViewSwitch } from "../components/ui";
import { TransactionForm } from "../components/TransactionForm";

function Delta({ now, before, invert }: { now: number; before: number; invert?: boolean }) {
  if (!before) return <span className="delta">sem comparação com o mês anterior</span>;
  const d = ((now - before) / before) * 100;
  const up = d >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const good = invert ? !up : up;
  return (
    <span className="delta">
      <Icon size={14} style={{ color: good ? "var(--ok)" : "var(--bad)" }} aria-hidden />
      {Math.abs(d).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}% {up ? "acima" : "abaixo"} do mês anterior
    </span>
  );
}

function BillRow({ t, onOpen }: { t: Transaction; onOpen(): void }) {
  const member = useMemberLookup()(t.userId);
  const { view } = useApp();
  return (
    <div className="list-item clickable" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <CategoryIcon icon={t.categoryIcon} color={t.categoryColor} size={34} />
      <div style={{ minWidth: 0 }}>
        <div className="title">{t.description}</div>
        <div className="sub">
          <span style={{ color: t.overdue ? "var(--bad)" : undefined, fontWeight: t.overdue ? 650 : undefined }}>
            {dateShort(t.date)} · {relativeDue(t.date, todayIso())}
          </span>
          {view !== "me" && member && <span>{firstName(member.name)}</span>}
        </div>
      </div>
      <Money cents={t.amountCents} className="amount" />
    </div>
  );
}

export function DashboardPage() {
  const { view } = useApp();
  const { data: me } = useMe();
  const [month, setMonth] = useState(currentYm());
  const [editing, setEditing] = useState<Transaction | null>(null);
  const lookup = useMemberLookup();
  const q = useQuery({
    queryKey: ["dashboard", viewParam(view), month],
    queryFn: () => get<Dashboard>(`/dashboard${qs({ view: viewParam(view), month })}`),
  });
  const d = q.data;
  const isFamily = view === "family";
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  })();

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">{monthLong(month)}</p>
          <h1>{isFamily ? "Finanças da família" : `${greeting}, ${me ? firstName(me.name) : ""}`}</h1>
        </div>
        <div className="toolbar">
          <ViewSwitch />
          <div className="segmented" role="group" aria-label="Mês">
            <button aria-label="Mês anterior" onClick={() => setMonth(shiftYm(month, -1))}>
              <ChevronLeft size={16} />
            </button>
            <button aria-pressed={month === currentYm()} onClick={() => setMonth(currentYm())}>
              {month === currentYm() ? "Este mês" : monthLong(month)}
            </button>
            <button aria-label="Próximo mês" onClick={() => setMonth(shiftYm(month, 1))}>
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}

      {!d && !q.error ? (
        <div className="stack">
          <Skeleton h={230} style={{ borderRadius: 22 }} />
          <div className="grid grid-2">
            <CardSkeleton h={200} />
            <CardSkeleton h={200} />
          </div>
        </div>
      ) : d ? (
        <div className="stack reveal">
          <section className="hero" aria-label="Resumo">
            <p className="eyebrow">{isFamily ? "Saldo total da família" : "Seu saldo atual"}</p>
            <div className="balance num">
              <Money cents={d.balanceCents} big />
            </div>
            <div className="hero-meta">
              <span>Resultado do mês: <b className="num">{signedMoney(d.resultCents)}</b></span>
              {d.overdue.count > 0 && (
                <span className="row" style={{ gap: 6 }}>
                  <AlertTriangle size={14} /> {d.overdue.count} conta(s) atrasada(s) · {money(d.overdue.totalCents)}
                </span>
              )}
            </div>
            <div className="hero-stats">
              <div>
                <span className="l">
                  <i className="marker" style={{ background: "var(--income)" }} /> Receitas
                </span>
                <span className="v num">{money(d.totals.incomeTotalCents)}</span>
              </div>
              <div>
                <span className="l">
                  <i className="marker" style={{ background: "var(--expense)" }} /> Despesas
                </span>
                <span className="v num">{money(d.totals.expenseTotalCents)}</span>
              </div>
              <div>
                <span className="l">A pagar nos próximos 15 dias</span>
                <span className="v num">{money(d.upcoming.totalCents)}</span>
              </div>
            </div>
          </section>

          <div className="grid grid-4">
            <div className="card kpi">
              <span className="eyebrow">Recebido</span>
              <span className="value num">{money(d.totals.incomePaidCents)}</span>
              <Delta now={d.totals.incomeTotalCents} before={d.previousTotals.incomeTotalCents} />
            </div>
            <div className="card kpi">
              <span className="eyebrow">Pago</span>
              <span className="value num">{money(d.totals.expensePaidCents)}</span>
              <Delta now={d.totals.expenseTotalCents} before={d.previousTotals.expenseTotalCents} invert />
            </div>
            <div className="card kpi">
              <span className="eyebrow">Ainda a pagar</span>
              <span className="value num">{money(d.totals.expenseTotalCents - d.totals.expensePaidCents)}</span>
              <span className="delta">no mês selecionado</span>
            </div>
            <div className="card kpi">
              <span className="eyebrow">Taxa de poupança</span>
              <span className="value num">
                {d.totals.incomeTotalCents > 0 ? `${Math.round((d.resultCents / d.totals.incomeTotalCents) * 100)}%` : "—"}
              </span>
              <span className="delta">do que entrou no mês</span>
            </div>
          </div>

          <div className="grid grid-3">
            <div className="card span-2">
              <div className="card-head">
                <h2>Receitas e despesas <span className="faint" style={{ fontSize: 13, fontFamily: "var(--font-body)" }}>(R$)</span></h2>
                <Link to="/relatorios">Relatórios</Link>
              </div>
              <FlowChart data={d.series} />
            </div>
            <div className="card">
              <div className="card-head">
                <h2>Para onde foi</h2>
                <span className="faint" style={{ fontSize: 13 }}>{monthLong(month).split(" ")[0]}</span>
              </div>
              {d.expensesByCategory.length ? (
                <CategoryBars data={d.expensesByCategory} />
              ) : (
                <Empty title="Sem despesas no mês" text="Quando houver gastos, as categorias aparecem aqui." />
              )}
            </div>
          </div>

          <div className="grid grid-3">
            <div className="card">
              <div className="card-head">
                <h2>Próximos pagamentos</h2>
                <Link to="/contas">Ver contas</Link>
              </div>
              {d.overdue.items.length + d.upcoming.items.length === 0 ? (
                <Empty icon={<CalendarCheck size={28} />} title="Nada pendente" text="Nenhuma conta atrasada ou vencendo nos próximos 15 dias." />
              ) : (
                <div className="list">
                  {[...d.overdue.items, ...d.upcoming.items].slice(0, 6).map((t) => (
                    <BillRow key={t.id} t={t} onOpen={() => t.userId === me?.id && setEditing(t)} />
                  ))}
                </div>
              )}
              {!d.detail && isFamily && <p className="faint" style={{ fontSize: 12.5, marginBottom: 0 }}>Mostrando apenas as suas contas.</p>}
            </div>
            <div className="card span-2">
              <div className="card-head">
                <h2>Evolução do patrimônio <span className="faint" style={{ fontSize: 13, fontFamily: "var(--font-body)" }}>(R$)</span></h2>
                <span className="faint" style={{ fontSize: 13 }}>12 meses</span>
              </div>
              <BalanceChart data={d.balanceHistory} />
            </div>
          </div>

          <div className="grid grid-3">
            <div className={`card ${d.members ? "" : "span-2"}`}>
              <div className="card-head">
                <h2>Metas</h2>
                <Link to="/metas">Todas</Link>
              </div>
              {d.goals.length === 0 ? (
                <Empty icon={<Target size={28} />} title="Nenhuma meta ainda" text="Crie uma meta para acompanhar quanto falta." action={<Link className="btn btn-sm" to="/metas">Criar meta</Link>} />
              ) : (
                <div className="list">
                  {d.goals.slice(0, 4).map((g) => (
                    <div className="list-item" key={g.id}>
                      <MoonPhase percent={g.percent} size={38} />
                      <div style={{ minWidth: 0 }}>
                        <div className="title">{g.name}</div>
                        <div className="sub">
                          <span className="tnum">{money(g.savedCents)} de {money(g.targetCents)}</span>
                          {g.scope === "family" && <span className="chip">Família</span>}
                        </div>
                      </div>
                      <b className="num">{Math.round(g.percent)}%</b>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {d.members ? (
              <div className="card span-2">
                <div className="card-head">
                  <h2>Por pessoa</h2>
                  <span className="faint" style={{ fontSize: 13 }}>{monthLong(month)}</span>
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Integrante</th>
                        <th className="r">Receitas</th>
                        <th className="r">Despesas</th>
                        <th className="r hide-mobile">Saldo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.members.map((m) => (
                        <tr key={m.userId}>
                          <td>
                            <span className="row">
                              <Avatar name={m.name} color={lookup(m.userId)?.color ?? m.color} size="sm" />
                              {m.name}
                            </span>
                          </td>
                          <td className="r num">{money(m.incomeTotalCents)}</td>
                          <td className="r num">{money(m.expenseTotalCents)}</td>
                          <td className="r num hide-mobile">{money(m.balanceCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="card-head">
                  <h2>Contas</h2>
                  <Link to="/configuracoes#contas">Gerenciar</Link>
                </div>
                {d.accounts.length ? (
                  <div className="list">
                    {d.accounts.map((a) => (
                      <div className="list-item" key={a.id} style={{ gridTemplateColumns: "1fr auto" }}>
                        <div className="title">{a.name}</div>
                        <Money cents={a.balanceCents} className="amount" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="faint">Os detalhes das contas ficam visíveis apenas para quem tem acesso completo.</p>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {editing && <TransactionForm initial={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
