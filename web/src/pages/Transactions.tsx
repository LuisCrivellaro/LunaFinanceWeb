import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Plus, ReceiptText, Repeat, Search, Send } from "lucide-react";
import { get, qs } from "../lib/api";
import { useApp, useCategories, useMe, useMemberLookup, viewParam } from "../lib/app";
import { currentYm, dateHeading, firstName, monthBounds, monthLong, money, shiftYm, todayIso } from "../lib/format";
import type { Transaction } from "../lib/types";
import { Avatar, CategoryIcon, Empty, ErrorState, Money, Skeleton, StatusChip, ViewSwitch } from "../components/ui";
import { TransactionForm } from "../components/TransactionForm";

interface ListResponse {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
  sums: { incomeCents: number; expenseCents: number };
}

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function TransactionsPage() {
  const { view, openNewTransaction } = useApp();
  const { data: me } = useMe();
  const { data: categories = [] } = useCategories();
  const lookup = useMemberLookup();
  const [month, setMonth] = useState<string | "all">(currentYm());
  const [kind, setKind] = useState<"" | "income" | "expense">("");
  const [status, setStatus] = useState<"" | "paid" | "pending" | "overdue">("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const q = useDebounced(search);

  useEffect(() => setPage(1), [month, kind, status, categoryId, q, view]);

  const bounds = month === "all" ? null : monthBounds(month);
  const params = {
    view: viewParam(view),
    from: bounds?.from,
    to: bounds?.to,
    kind,
    status,
    categoryId,
    q,
    page,
    pageSize: 60,
  };
  const list = useQuery({
    queryKey: ["transactions", params],
    queryFn: () => get<ListResponse>(`/transactions${qs(params)}`),
    placeholderData: keepPreviousData,
  });

  const groups = useMemo(() => {
    const out: Array<{ date: string; items: Transaction[]; net: number }> = [];
    for (const t of list.data?.items ?? []) {
      let g = out[out.length - 1];
      if (!g || g.date !== t.date) out.push((g = { date: t.date, items: [], net: 0 }));
      g.items.push(t);
      g.net += t.kind === "income" ? t.amountCents : -t.amountCents;
    }
    return out;
  }, [list.data]);

  const today = todayIso();
  const pages = list.data ? Math.ceil(list.data.total / list.data.pageSize) : 1;
  const cats = categories.filter((c) => !kind || c.kind === kind);

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Histórico</p>
          <h1>Movimentações</h1>
        </div>
        <div className="toolbar">
          <ViewSwitch allowPeople />
          <a
            className="btn hide-mobile"
            href={`/api/reports/export.csv${qs({ view: viewParam(view), from: bounds?.from ?? "2000-01-01", to: bounds?.to ?? "2100-12-31" })}`}
          >
            <Download size={16} /> CSV
          </a>
          <button className="btn btn-primary hide-mobile" onClick={() => openNewTransaction()}>
            <Plus size={16} /> Nova
          </button>
        </div>
      </div>

      <div className="card stack" style={{ gap: 12, marginBottom: 16 }}>
        <div className="row wrap" style={{ gap: 10 }}>
          <label className="field" style={{ flex: "1 1 240px" }}>
            <span className="sr-only">Pesquisar</span>
            <div style={{ position: "relative" }}>
              <Search size={16} style={{ position: "absolute", left: 12, top: 13, color: "var(--ink-3)" }} aria-hidden />
              <input className="input" style={{ paddingLeft: 36 }} placeholder="Pesquisar descrição, categoria ou observação" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </label>
          <div className="segmented" role="group" aria-label="Período">
            <button aria-label="Mês anterior" onClick={() => setMonth(shiftYm(month === "all" ? currentYm() : month, -1))}>
              <ChevronLeft size={16} />
            </button>
            <button aria-pressed={month !== "all"} onClick={() => setMonth(currentYm())}>
              {month === "all" ? "Mês" : monthLong(month)}
            </button>
            <button aria-label="Próximo mês" onClick={() => setMonth(shiftYm(month === "all" ? currentYm() : month, 1))}>
              <ChevronRight size={16} />
            </button>
            <button aria-pressed={month === "all"} onClick={() => setMonth("all")}>
              Tudo
            </button>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="segmented" role="group" aria-label="Tipo">
            {(["", "expense", "income"] as const).map((k) => (
              <button key={k} aria-pressed={kind === k} onClick={() => { setKind(k); setCategoryId(""); }}>
                {k === "" ? "Tudo" : k === "income" ? "Receitas" : "Despesas"}
              </button>
            ))}
          </div>
          <select className="select" style={{ width: "auto", height: 38 }} aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">Qualquer situação</option>
            <option value="paid">Pagas / recebidas</option>
            <option value="pending">Pendentes</option>
            <option value="overdue">Atrasadas</option>
          </select>
          <select className="select" style={{ width: "auto", height: 38, maxWidth: "100%" }} aria-label="Categoria" value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Todas as categorias</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {list.data && (
            <div className="row" style={{ marginLeft: "auto", gap: 14, fontSize: 13.5 }}>
              <span className="row" style={{ gap: 6 }}>
                <i className="marker" style={{ background: "var(--income)" }} />
                <span className="num">{money(list.data.sums.incomeCents)}</span>
              </span>
              <span className="row" style={{ gap: 6 }}>
                <i className="marker" style={{ background: "var(--expense)" }} />
                <span className="num">{money(list.data.sums.expenseCents)}</span>
              </span>
            </div>
          )}
        </div>
      </div>

      {list.error && <ErrorState error={list.error} retry={() => list.refetch()} />}

      <div className="card" style={{ paddingTop: 4 }}>
        {list.isLoading ? (
          <div className="stack" style={{ paddingTop: 16 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} h={44} />
            ))}
          </div>
        ) : !list.data?.items.length ? (
          <Empty
            icon={<ReceiptText size={30} />}
            title="Nenhuma movimentação encontrada"
            text={search || kind || status || categoryId ? "Tente ajustar os filtros." : "Registre a primeira receita ou despesa — pelo site ou pelo Telegram."}
            action={
              <button className="btn btn-primary btn-sm" onClick={() => openNewTransaction()}>
                <Plus size={15} /> Nova movimentação
              </button>
            }
          />
        ) : (
          <div style={{ opacity: list.isFetching ? 0.6 : 1, transition: "opacity .2s" }}>
            {groups.map((g) => (
              <section key={g.date} aria-label={dateHeading(g.date, today)}>
                <div className="tx-group-label">
                  <span>{dateHeading(g.date, today)}</span>
                  <span className="num">{(g.net >= 0 ? "+" : "−") + money(Math.abs(g.net))}</span>
                </div>
                {g.items.map((t) => {
                  const owner = lookup(t.userId);
                  const mine = t.userId === me?.id;
                  return (
                    <div
                      key={t.id}
                      className={`list-item ${mine ? "clickable" : ""}`}
                      onClick={() => mine && setEditing(t)}
                      role={mine ? "button" : undefined}
                      tabIndex={mine ? 0 : undefined}
                      onKeyDown={(e) => mine && e.key === "Enter" && setEditing(t)}
                      aria-label={mine ? `Editar ${t.description}` : undefined}
                    >
                      <CategoryIcon icon={t.categoryIcon} color={t.categoryColor} />
                      <div style={{ minWidth: 0 }}>
                        <div className="title">{t.description}</div>
                        <div className="sub">
                          <span>{t.categoryName ?? "Sem categoria"}</span>
                          {t.installmentNumber && <span className="tnum">· {t.installmentNumber}/{t.installmentTotal}</span>}
                          {t.recurrenceId && <Repeat size={12} aria-label="Recorrente" />}
                          {t.source === "telegram" && <Send size={12} aria-label="Registrado pelo Telegram" />}
                          {t.status === "pending" && <StatusChip status={t.status} overdue={t.overdue} kind={t.kind} />}
                          {view !== "me" && owner && (
                            <span className="row" style={{ gap: 5 }}>
                              <Avatar name={owner.name} color={owner.color} size="sm" />
                              {firstName(owner.name)}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="amount row" style={{ gap: 8 }}>
                        <i className="marker" style={{ background: t.kind === "income" ? "var(--income)" : "var(--expense)" }} aria-hidden />
                        <Money cents={t.amountCents} kind={t.kind} />
                      </span>
                    </div>
                  );
                })}
              </section>
            ))}
            {pages > 1 && (
              <div className="row between" style={{ paddingTop: 14 }}>
                <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Anterior
                </button>
                <span className="faint tnum" style={{ fontSize: 13 }}>
                  Página {page} de {pages} · {list.data.total} itens
                </span>
                <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Próxima
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {editing && <TransactionForm initial={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
