import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarCheck, Check, Pause, Play, Plus, Repeat } from "lucide-react";
import { get, patch, post, qs } from "../lib/api";
import { useApp, useInvalidateFinance, useMe, useMemberLookup, viewParam } from "../lib/app";
import { centsToInput, dateShort, firstName, money, parseCents, relativeDue, todayIso } from "../lib/format";
import type { Recurrence, Transaction } from "../lib/types";
import { Avatar, CategoryIcon, Empty, ErrorState, Modal, Money, Skeleton, ViewSwitch } from "../components/ui";
import { TransactionForm } from "../components/TransactionForm";

interface BillsResponse {
  overdue: Transaction[];
  upcoming: Transaction[];
  paid: Transaction[];
  totals: { overdueCents: number; upcomingCents: number };
  limitedToSelf: boolean;
}

function BillItem({ t, onEdit }: { t: Transaction; onEdit(t: Transaction): void }) {
  const { data: me } = useMe();
  const { toast, view } = useApp();
  const invalidate = useInvalidateFinance();
  const owner = useMemberLookup()(t.userId);
  const mine = t.userId === me?.id;
  const pay = useMutation({
    mutationFn: () => post(`/transactions/${t.id}/pay`, {}),
    onSuccess: () => {
      invalidate();
      toast(`“${t.description}” marcada como paga`);
    },
    onError: (e) => toast(e.message, "error"),
  });
  const today = todayIso();
  return (
    <div className="list-item">
      <CategoryIcon icon={t.categoryIcon} color={t.categoryColor} />
      <div style={{ minWidth: 0 }} className={mine ? "clickable" : ""} onClick={() => mine && onEdit(t)}>
        <div className="title">{t.description}</div>
        <div className="sub">
          {t.status === "paid" ? (
            <span>Paga em {dateShort(t.paidAt ?? t.date)}</span>
          ) : (
            <span style={{ color: t.overdue ? "var(--bad)" : undefined, fontWeight: t.overdue ? 650 : 500 }}>
              {dateShort(t.date)} · {relativeDue(t.date, today)}
            </span>
          )}
          {t.recurrenceId && (
            <span className="row" style={{ gap: 4 }}>
              <Repeat size={12} /> mensal
            </span>
          )}
          {t.installmentNumber && <span className="tnum">parcela {t.installmentNumber}/{t.installmentTotal}</span>}
          {view !== "me" && owner && (
            <span className="row" style={{ gap: 5 }}>
              <Avatar name={owner.name} color={owner.color} size="sm" /> {firstName(owner.name)}
            </span>
          )}
        </div>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <Money cents={t.amountCents} className="amount" />
        {t.status === "pending" && mine && (
          <button className="btn btn-sm" onClick={() => pay.mutate()} disabled={pay.isPending} aria-label={`Marcar ${t.description} como paga`}>
            <Check size={15} /> <span className="hide-mobile">Pagar</span>
          </button>
        )}
      </div>
    </div>
  );
}

function RecurrenceEditor({ r, onClose }: { r: Recurrence; onClose(): void }) {
  const { toast } = useApp();
  const invalidate = useInvalidateFinance();
  const [amount, setAmount] = useState(centsToInput(r.amountCents));
  const [description, setDescription] = useState(r.description);
  const [day, setDay] = useState(r.dayOfMonth);
  const [endDate, setEndDate] = useState(r.endDate ?? "");
  const [autoPaid, setAutoPaid] = useState(r.autoPaid);
  const save = useMutation({
    mutationFn: () =>
      patch(`/recurrences/${r.id}`, { amountCents: parseCents(amount) ?? undefined, description, dayOfMonth: day, endDate: endDate || null, autoPaid }),
    onSuccess: () => {
      invalidate();
      toast("Recorrência atualizada — vale para os próximos meses");
      onClose();
    },
    onError: (e) => toast(e.message, "error"),
  });
  return (
    <Modal
      title="Conta recorrente"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>Salvar</button>
        </>
      }
    >
      <div className="alert info">As alterações valem para as ocorrências futuras ainda pendentes. O que já foi pago não muda.</div>
      <label className="field">
        <span>Descrição</span>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="grid grid-2">
        <label className="field">
          <span>Valor mensal</span>
          <div className="money-input">
            <span className="prefix">R$</span>
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </label>
        <label className="field">
          <span>Dia do vencimento</span>
          <input className="input" type="number" min={1} max={31} value={day} onChange={(e) => setDay(Math.max(1, Math.min(31, Number(e.target.value) || 1)))} />
        </label>
      </div>
      <label className="field">
        <span>Termina em (opcional)</span>
        <input className="input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={autoPaid} onChange={(e) => setAutoPaid(e.target.checked)} /> Marcar como paga automaticamente no vencimento
      </label>
    </Modal>
  );
}

export function BillsPage() {
  const { view, openNewTransaction, toast } = useApp();
  const { data: me } = useMe();
  const invalidate = useInvalidateFinance();
  const lookup = useMemberLookup();
  const [tab, setTab] = useState<"open" | "paid" | "recurring">("open");
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [editRec, setEditRec] = useState<Recurrence | null>(null);
  const v = viewParam(view);
  const bills = useQuery({ queryKey: ["bills", v], queryFn: () => get<BillsResponse>(`/bills${qs({ view: v })}`) });
  const recs = useQuery({
    queryKey: ["recurrences", v],
    queryFn: () => get<Recurrence[]>(`/recurrences${qs({ view: v })}`),
    enabled: tab === "recurring",
    retry: false,
  });
  const toggle = useMutation({
    mutationFn: (r: Recurrence) => patch(`/recurrences/${r.id}`, { active: !r.active }),
    onSuccess: (_d, r) => {
      invalidate();
      toast(r.active ? "Recorrência pausada — lançamentos futuros removidos" : "Recorrência retomada");
    },
    onError: (e) => toast(e.message, "error"),
  });
  const b = bills.data;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Compromissos</p>
          <h1>Contas a pagar</h1>
        </div>
        <div className="toolbar">
          <ViewSwitch />
          <button className="btn btn-primary" onClick={() => openNewTransaction({ kind: "expense", status: "pending" })}>
            <Plus size={16} /> Nova conta
          </button>
        </div>
      </div>

      {b && (
        <div className="grid grid-3" style={{ marginBottom: 16 }}>
          <div className="card kpi">
            <span className="eyebrow">Atrasadas</span>
            <span className="value num">{money(b.totals.overdueCents)}</span>
            <span className="delta">
              {b.overdue.length ? <span className="chip bad">{b.overdue.length} conta(s)</span> : <span className="chip ok">Tudo em dia</span>}
            </span>
          </div>
          <div className="card kpi">
            <span className="eyebrow">Próximos 60 dias</span>
            <span className="value num">{money(b.totals.upcomingCents)}</span>
            <span className="delta">{b.upcoming.length} vencimento(s)</span>
          </div>
          <div className="card kpi">
            <span className="eyebrow">Próximo vencimento</span>
            <span className="value num" style={{ fontSize: 22 }}>{b.upcoming[0] ? dateShort(b.upcoming[0].date) : "—"}</span>
            <span className="delta">{b.upcoming[0] ? `${b.upcoming[0].description} · ${money(b.upcoming[0].amountCents)}` : "nada agendado"}</span>
          </div>
        </div>
      )}

      <div className="segmented" role="tablist" aria-label="Seções" style={{ marginBottom: 14 }}>
        <button role="tab" aria-pressed={tab === "open"} aria-selected={tab === "open"} onClick={() => setTab("open")}>Em aberto</button>
        <button role="tab" aria-pressed={tab === "paid"} aria-selected={tab === "paid"} onClick={() => setTab("paid")}>Pagas</button>
        <button role="tab" aria-pressed={tab === "recurring"} aria-selected={tab === "recurring"} onClick={() => setTab("recurring")}>Recorrentes</button>
      </div>

      {bills.error && <ErrorState error={bills.error} retry={() => bills.refetch()} />}
      {b?.limitedToSelf && <div className="alert info" style={{ marginBottom: 12 }}>Sua conta vê só os totais da família, então aqui aparecem apenas as suas contas.</div>}

      {tab === "open" && (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head">
              <h2>Atrasadas</h2>
            </div>
            {!b ? <Skeleton h={80} /> : b.overdue.length ? b.overdue.map((t) => <BillItem key={t.id} t={t} onEdit={setEditing} />) : <Empty icon={<CalendarCheck size={26} />} title="Nenhuma conta atrasada" />}
          </div>
          <div className="card">
            <div className="card-head">
              <h2>A vencer</h2>
            </div>
            {!b ? <Skeleton h={80} /> : b.upcoming.length ? b.upcoming.map((t) => <BillItem key={t.id} t={t} onEdit={setEditing} />) : <Empty title="Nada nos próximos 60 dias" text="Cadastre contas com vencimento para receber lembretes." />}
          </div>
        </div>
      )}

      {tab === "paid" && (
        <div className="card">
          <div className="card-head">
            <h2>Histórico de pagamentos</h2>
            <span className="faint" style={{ fontSize: 13 }}>últimos 90 dias · fixas, recorrentes e parceladas</span>
          </div>
          {!b ? <Skeleton h={80} /> : b.paid.length ? b.paid.map((t) => <BillItem key={t.id} t={t} onEdit={setEditing} />) : <Empty title="Nenhum pagamento recente" />}
        </div>
      )}

      {tab === "recurring" && (
        <div className="card">
          <div className="card-head">
            <h2>Recorrências</h2>
            <span className="faint" style={{ fontSize: 13 }}>geradas automaticamente todo mês</span>
          </div>
          {recs.error ? (
            <ErrorState error={recs.error} />
          ) : !recs.data ? (
            <Skeleton h={80} />
          ) : !recs.data.length ? (
            <Empty icon={<Repeat size={26} />} title="Nenhuma recorrência" text="Ao criar uma movimentação, escolha “Todo mês” para ela se repetir." />
          ) : (
            recs.data.map((r) => {
              const mine = r.userId === me?.id;
              const owner = lookup(r.userId);
              return (
                <div className="list-item" key={r.id} style={{ opacity: r.active ? 1 : 0.55 }}>
                  <span className="cat-icon" style={{ ["--c" as string]: r.categoryColor ?? undefined }}>
                    <Repeat size={18} />
                  </span>
                  <div style={{ minWidth: 0 }} className={mine ? "clickable" : ""} onClick={() => mine && setEditRec(r)}>
                    <div className="title">{r.description}</div>
                    <div className="sub">
                      <span>todo dia {r.dayOfMonth}</span>
                      <span>{r.kind === "income" ? "receita" : "despesa"}</span>
                      {r.categoryName && <span>{r.categoryName}</span>}
                      {!r.active && <span className="chip">Pausada</span>}
                      {view !== "me" && owner && <span>{firstName(owner.name)}</span>}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <Money cents={r.amountCents} className="amount" />
                    {mine && (
                      <button className="btn btn-sm btn-ghost" onClick={() => toggle.mutate(r)} aria-label={r.active ? "Pausar" : "Retomar"}>
                        {r.active ? <Pause size={15} /> : <Play size={15} />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {editing && <TransactionForm initial={editing} onClose={() => setEditing(null)} />}
      {editRec && <RecurrenceEditor r={editRec} onClose={() => setEditRec(null)} />}
    </>
  );
}
