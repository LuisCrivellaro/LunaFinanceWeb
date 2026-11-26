import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowRight, CalendarCheck, ChevronLeft, ChevronRight, CircleDollarSign, Clock3, PiggyBank, Plus, ReceiptText,
  Target, TrendingDown, TrendingUp, Wallet,
} from "lucide-react";
import { get, qs } from "../lib/api";
import { useApp, useMe, useMemberLookup, viewParam } from "../lib/app";
import {
  currentYm, dateShort, firstName, monthBounds, monthLong, monthName, money, moneyParts, relativeDue, shiftYm, signedMoney, todayIso,
} from "../lib/format";
import type { Dashboard, Transaction } from "../lib/types";
import { BalanceChart, CategoryBars, FlowChart, FlowLegend } from "../components/Charts";
import {
  Avatar, CardSkeleton, CategoryIcon, Delta, Empty, ErrorState, Money, MoonPhase, Skeleton, StatusChip, ViewSwitch, useCountUp, useSpotlight,
} from "../components/ui";
import { TransactionForm } from "../components/TransactionForm";
import { FamilyCards } from "../components/FamilyCards";

interface ListResponse {
  items: Transaction[];
  total: number;
}

/** O saldo conta de 0 até o valor só na primeira vez da sessão. */
let heroCounted = false;
function HeroBalance({ cents }: { cents: number }) {
  const [animate] = useState(() => !heroCounted);
  useEffect(() => {
    heroCounted = true;
  }, []);
  const v = useCountUp(cents, { enabled: animate });
  const p = moneyParts(v);
  return (
    <>
      <span aria-hidden>
        {p.main}
        <span className="cents">{p.cents}</span>
      </span>
      <span className="sr-only">{money(cents)}</span>
    </>
  );
}

/** Arte do hero: crescente abstrato, só decoração. */
function HeroArt() {
  return (
    <svg className="hero-art" viewBox="0 0 400 400" aria-hidden>
      <defs>
        <radialGradient id="heroGlow" cx="62%" cy="38%" r="60%">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="250" cy="150" r="190" fill="url(#heroGlow)" />
      <circle cx="250" cy="150" r="118" fill="none" stroke="var(--primary)" strokeOpacity="0.16" />
      <circle cx="250" cy="150" r="160" fill="none" stroke="var(--primary)" strokeOpacity="0.08" />
      <path d="M262 52a98 98 0 1 0 0 196a118 118 0 0 1 0-196z" fill="var(--primary)" fillOpacity="0.1" />
    </svg>
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
          {t.overdue ? <span className="chip bad">{relativeDue(t.date, todayIso())}</span> : <span>{dateShort(t.date)} · {relativeDue(t.date, todayIso())}</span>}
          {view !== "me" && member && <span>{firstName(member.name)}</span>}
        </div>
      </div>
      <Money cents={t.amountCents} className="amount" />
    </div>
  );
}

function RecentTable({ items, onOpen }: { items: Transaction[]; onOpen(t: Transaction): void }) {
  const { view } = useApp();
  const { data: me } = useMe();
  const lookup = useMemberLookup();
  return (
    <div className="table-wrap">
      <table className="table recent-table">
        <thead>
          <tr>
            <th>Descrição</th>
            <th className="hide-mobile">Data</th>
            {view !== "me" && <th className="hide-mobile">Responsável</th>}
            <th className="hide-mobile">Situação</th>
            <th className="r">Valor</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => {
            const mine = t.userId === me?.id;
            const owner = lookup(t.userId);
            return (
              <tr
                key={t.id}
                className={mine ? "clickable" : ""}
                onClick={() => mine && onOpen(t)}
                tabIndex={mine ? 0 : undefined}
                onKeyDown={(e) => mine && e.key === "Enter" && onOpen(t)}
                aria-label={mine ? `Editar ${t.description}` : undefined}
              >
                <td>
                  <div className="cell-main">
                    <CategoryIcon icon={t.categoryIcon} color={t.categoryColor} size={34} />
                    <div style={{ minWidth: 0 }}>
                      <div className="title">{t.description}</div>
                      <div className="sub">
                        {t.categoryName ?? "Sem categoria"}
                        <span className="show-mobile"> · {dateShort(t.date)}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td className="hide-mobile tnum muted">{dateShort(t.date)}</td>
                {view !== "me" && (
                  <td className="hide-mobile">
                    {owner && (
                      <span className="row" style={{ gap: 6 }}>
                        <Avatar name={owner.name} color={owner.color} size="sm" />
                        {firstName(owner.name)}
                      </span>
                    )}
                  </td>
                )}
                <td className="hide-mobile">
                  <StatusChip status={t.status} overdue={t.overdue} kind={t.kind} />
                </td>
                <td className="r">
                  <Money cents={t.amountCents} kind={t.kind} className={t.kind === "income" ? "is-income" : ""} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const { view, openNewTransaction } = useApp();
  const { data: me } = useMe();
  const [month, setMonth] = useState(currentYm());
  const [editing, setEditing] = useState<Transaction | null>(null);
  const lookup = useMemberLookup();
  const spot = useSpotlight<HTMLElement>();
  const q = useQuery({
    queryKey: ["dashboard", viewParam(view), month],
    queryFn: () => get<Dashboard>(`/dashboard${qs({ view: viewParam(view), month })}`),
  });
  // movimentações recentes: mesma consulta da página de movimentações, até hoje
  const bounds = monthBounds(month);
  const today = todayIso();
  const recentParams = { view: viewParam(view), from: bounds.from, to: month === currentYm() ? today : bounds.to, page: 1, pageSize: 6 };
  const recent = useQuery({
    queryKey: ["transactions", recentParams],
    queryFn: () => get<ListResponse>(`/transactions${qs(recentParams)}`),
    enabled: bounds.from <= today,
  });

  const d = q.data;
  const isFamily = view === "family";
  const person = typeof view === "number" ? lookup(view) : undefined;
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  })();
  const isCurrent = month === currentYm();
  const balanceLabel = isFamily ? "Saldo total da família" : person ? `Saldo de ${firstName(person.name)}` : "Seu saldo atual";

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
            <button aria-pressed={isCurrent} onClick={() => setMonth(currentYm())} style={{ minWidth: 92 }}>
              {isCurrent ? "Este mês" : monthLong(month)}
            </button>
            <button aria-label="Próximo mês" onClick={() => setMonth(shiftYm(month, 1))}>
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {q.error && <ErrorState error={q.error} retry={() => q.refetch()} />}

      {!d && !q.error ? (
        <div className="dash">
          <div className="dash-main">
            <Skeleton h={300} style={{ borderRadius: 26 }} />
            <div className="grid grid-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} h={118} style={{ borderRadius: 20 }} />
              ))}
            </div>
            <CardSkeleton h={240} />
          </div>
          <div className="dash-side">
            <CardSkeleton h={460} />
            <CardSkeleton h={160} />
            <CardSkeleton h={160} />
          </div>
        </div>
      ) : d ? (
        <div className="dash">
          <div className="dash-main reveal">
            <section className="hero spotlight" aria-label="Resumo" onPointerMove={spot}>
              <HeroArt />
              <div className="hero-top">
                <span className="hero-label">
                  <Wallet size={16} aria-hidden /> {balanceLabel}
                </span>
                <span className="chip primary">{isCurrent ? "Este mês" : monthLong(month)}</span>
              </div>
              <div className="balance num">
                <HeroBalance cents={d.balanceCents} />
              </div>
              <div className="hero-meta">
                <span className={`result-pill ${d.resultCents >= 0 ? "pos" : "neg"}`}>
                  {d.resultCents >= 0 ? <TrendingUp size={14} aria-hidden /> : <TrendingDown size={14} aria-hidden />}
                  Resultado do mês <b className="num">{signedMoney(d.resultCents)}</b>
                </span>
                {d.overdue.count > 0 && (
                  <Link to="/contas" className="result-pill neg">
                    <AlertTriangle size={14} aria-hidden /> {d.overdue.count} conta(s) atrasada(s) · <b className="num">{money(d.overdue.totalCents)}</b>
                  </Link>
                )}
              </div>
              <div className="hero-actions">
                <button className="btn btn-primary" onClick={() => openNewTransaction()}>
                  <Plus size={16} aria-hidden /> Nova movimentação
                </button>
                <Link className="btn btn-ghost" to="/movimentacoes">
                  Ver histórico <ArrowRight size={15} aria-hidden />
                </Link>
              </div>
              <div className="hero-stats">
                <div>
                  <span className="l">
                    <i className="marker income" /> Receitas
                  </span>
                  <span className="v num">{money(d.totals.incomeTotalCents)}</span>
                </div>
                <div>
                  <span className="l">
                    <i className="marker expense" /> Despesas
                  </span>
                  <span className="v num">{money(d.totals.expenseTotalCents)}</span>
                </div>
                <div>
                  <span className="l">
                    <Clock3 size={13} aria-hidden /> A pagar em 15 dias
                  </span>
                  <span className="v num">{money(d.upcoming.totalCents)}</span>
                </div>
              </div>
            </section>

            <div className="grid grid-4">
              <div className="card kpi">
                <div className="kpi-top">
                  <span className="eyebrow">Recebido</span>
                  <span className="kpi-icon income">
                    <TrendingUp size={15} aria-hidden />
                  </span>
                </div>
                <span className="value num">{money(d.totals.incomePaidCents)}</span>
                <Delta now={d.totals.incomeTotalCents} before={d.previousTotals.incomeTotalCents} />
              </div>
              <div className="card kpi">
                <div className="kpi-top">
                  <span className="eyebrow">Pago</span>
                  <span className="kpi-icon expense">
                    <TrendingDown size={15} aria-hidden />
                  </span>
                </div>
                <span className="value num">{money(d.totals.expensePaidCents)}</span>
                <Delta now={d.totals.expenseTotalCents} before={d.previousTotals.expenseTotalCents} invert />
              </div>
              <div className="card kpi">
                <div className="kpi-top">
                  <span className="eyebrow">Ainda a pagar</span>
                  <span className="kpi-icon warn">
                    <CircleDollarSign size={15} aria-hidden />
                  </span>
                </div>
                <span className="value num">{money(d.totals.expenseTotalCents - d.totals.expensePaidCents)}</span>
                <span className="delta">no mês selecionado</span>
              </div>
              <div className="card kpi">
                <div className="kpi-top">
                  <span className="eyebrow">Taxa de poupança</span>
                  <span className="kpi-icon primary">
                    <PiggyBank size={15} aria-hidden />
                  </span>
                </div>
                <span className="value num">
                  {d.totals.incomeTotalCents > 0 ? `${Math.round((d.resultCents / d.totals.incomeTotalCents) * 100)}%` : "—"}
                </span>
                <span className="delta">do que entrou no mês</span>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>
                  Receitas e despesas <small>(R$)</small>
                </h2>
                <div className="row" style={{ gap: 16 }}>
                  <span className="hide-mobile">
                    <FlowLegend />
                  </span>
                  <Link to="/relatorios">
                    Relatórios <ArrowRight size={14} aria-hidden />
                  </Link>
                </div>
              </div>
              <div className="show-mobile" style={{ marginBottom: 12 }}>
                <FlowLegend />
              </div>
              <FlowChart data={d.series} legend={false} />
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Movimentações recentes</h2>
                <Link to="/movimentacoes">
                  Ver todas <ArrowRight size={14} aria-hidden />
                </Link>
              </div>
              {recent.isLoading ? (
                <div className="stack" style={{ gap: 10 }}>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} h={44} />
                  ))}
                </div>
              ) : recent.error ? (
                <ErrorState error={recent.error} retry={() => recent.refetch()} />
              ) : recent.data?.items.length ? (
                <RecentTable items={recent.data.items} onOpen={setEditing} />
              ) : (
                <Empty
                  icon={<ReceiptText size={22} />}
                  title={bounds.from > today ? "Mês ainda não começou" : "Nada registrado neste mês"}
                  text="Registre receitas e despesas pelo site ou pelo Telegram."
                  action={
                    <button className="btn btn-sm" onClick={() => openNewTransaction()}>
                      <Plus size={14} /> Nova movimentação
                    </button>
                  }
                />
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>
                  Evolução do patrimônio <small>(R$)</small>
                </h2>
                <span className="meta">últimos 12 meses</span>
              </div>
              <BalanceChart data={d.balanceHistory} height={220} />
            </div>
          </div>

          <aside className="dash-side reveal" aria-label="Resumo lateral">
            <FamilyCards month={month} onOpen={setEditing} editableUserId={me?.id} />

            <div className="card">
              <div className="card-head">
                <h2>Próximos pagamentos</h2>
                <Link to="/contas">
                  Ver contas <ArrowRight size={14} aria-hidden />
                </Link>
              </div>
              {d.overdue.items.length + d.upcoming.items.length === 0 ? (
                <Empty icon={<CalendarCheck size={22} />} title="Nada pendente" text="Nenhuma conta atrasada ou vencendo nos próximos 15 dias." />
              ) : (
                <div className="list">
                  {[...d.overdue.items, ...d.upcoming.items].slice(0, 5).map((t) => (
                    <BillRow key={t.id} t={t} onOpen={() => t.userId === me?.id && setEditing(t)} />
                  ))}
                </div>
              )}
              {!d.detail && isFamily && <p className="card-foot-note">Mostrando apenas as suas contas.</p>}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Para onde foi</h2>
                <span className="meta" style={{ textTransform: "capitalize" }}>{monthName(month)}</span>
              </div>
              {d.expensesByCategory.length ? (
                <CategoryBars data={d.expensesByCategory} limit={5} />
              ) : (
                <Empty title="Sem despesas no mês" text="Quando houver gastos, as categorias aparecem aqui." />
              )}
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Metas</h2>
                <Link to="/metas">
                  Todas <ArrowRight size={14} aria-hidden />
                </Link>
              </div>
              {d.goals.length === 0 ? (
                <Empty
                  icon={<Target size={22} />}
                  title="Nenhuma meta ainda"
                  text="Crie uma meta para acompanhar quanto falta."
                  action={
                    <Link className="btn btn-sm" to="/metas">
                      Criar meta
                    </Link>
                  }
                />
              ) : (
                <div className="goal-mini-list">
                  {d.goals.slice(0, 4).map((g) => (
                    <div className="goal-mini" key={g.id}>
                      <MoonPhase percent={g.percent} size={36} color={g.color} />
                      <div style={{ minWidth: 0 }}>
                        <div className="row between" style={{ gap: 8 }}>
                          <span className="title">{g.name}</span>
                          <b className="num">{Math.round(g.percent)}%</b>
                        </div>
                        <div className="progress" style={{ ["--c" as string]: g.color }} aria-hidden>
                          <i style={{ width: `${Math.min(100, g.percent)}%` }} />
                        </div>
                        <div className="sub tnum">
                          {money(g.savedCents)} de {money(g.targetCents)}
                          {g.scope === "family" && <span className="chip">Família</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {d.members ? (
              <div className="card">
                <div className="card-head">
                  <h2>Por pessoa</h2>
                  <span className="meta" style={{ textTransform: "capitalize" }}>{monthName(month)}</span>
                </div>
                <div className="list">
                  {d.members.map((m) => (
                    <div className="list-item" key={m.userId}>
                      <Avatar name={m.name} color={lookup(m.userId)?.color ?? m.color} />
                      <div style={{ minWidth: 0 }}>
                        <div className="title">{m.name}</div>
                        <div className="sub tnum">
                          <span>
                            <i className="marker income" /> {money(m.incomeTotalCents)}
                          </span>
                          <span>
                            <i className="marker expense" /> {money(m.expenseTotalCents)}
                          </span>
                        </div>
                      </div>
                      <Money cents={m.balanceCents} className="amount" />
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="card-head">
                  <h2>Contas</h2>
                  <Link to="/configuracoes#contas">
                    Gerenciar <ArrowRight size={14} aria-hidden />
                  </Link>
                </div>
                {d.accounts.length ? (
                  <div className="list">
                    {d.accounts.map((a) => (
                      <div className="list-item no-icon" key={a.id}>
                        <div className="title">{a.name}</div>
                        <Money cents={a.balanceCents} className="amount" />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="faint" style={{ fontSize: 13 }}>Os detalhes das contas ficam visíveis apenas para quem tem acesso completo.</p>
                )}
              </div>
            )}
          </aside>
        </div>
      ) : null}

      {editing && <TransactionForm initial={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
