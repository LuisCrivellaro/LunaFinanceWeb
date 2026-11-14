import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { ApiError, del, patch, post } from "../lib/api";
import { useAccounts, useApp, useCategories, useInvalidateFinance } from "../lib/app";
import { centsToInput, money, parseCents, todayIso } from "../lib/format";
import { PAYMENT_LABELS, type Kind, type PaymentMethod, type Transaction } from "../lib/types";
import { Modal } from "./ui";

interface Props {
  initial?: Transaction | null;
  preset?: Partial<{ kind: Kind; status: "paid" | "pending" }>;
  onClose(): void;
}

type Mode = "single" | "installments" | "recurring";

export function TransactionForm({ initial, preset, onClose }: Props) {
  const editing = Boolean(initial);
  const { toast } = useApp();
  const invalidate = useInvalidateFinance();
  const { data: categories = [] } = useCategories();
  const { data: accounts = [] } = useAccounts();

  const [kind, setKind] = useState<Kind>(initial?.kind ?? preset?.kind ?? "expense");
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amountCents) : "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [date, setDate] = useState(initial?.date ?? todayIso());
  const [status, setStatus] = useState<"paid" | "pending">(initial?.status ?? preset?.status ?? "paid");
  const [categoryId, setCategoryId] = useState<number | "">(initial?.categoryId ?? "");
  const [accountId, setAccountId] = useState<number | "">(initial?.accountId ?? "");
  const [nature, setNature] = useState<"fixed" | "variable">(initial?.nature ?? "variable");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">(initial?.paymentMethod ?? "");
  const [mode, setMode] = useState<Mode>("single");
  const [installments, setInstallments] = useState(2);
  const [endDate, setEndDate] = useState("");
  const [autoPaid, setAutoPaid] = useState(false);
  const [error, setError] = useState<{ msg: string; field?: string } | null>(null);

  const cats = useMemo(() => categories.filter((c) => c.kind === kind), [categories, kind]);
  const cents = parseCents(amount);

  const save = useMutation({
    mutationFn: async () => {
      if (!cents || cents <= 0) throw new ApiError(400, "Informe um valor maior que zero.", "amountCents");
      if (!description.trim()) throw new ApiError(400, "Informe uma descrição.", "description");
      const body = {
        kind,
        amountCents: cents,
        description: description.trim(),
        date,
        status,
        categoryId: categoryId || null,
        nature: mode === "recurring" && nature === "variable" && !editing ? "fixed" : nature,
        notes: notes.trim() || null,
        paymentMethod: paymentMethod || null,
        ...(accountId ? { accountId } : {}),
      };
      if (editing) return patch(`/transactions/${initial!.id}`, body);
      return post("/transactions", {
        ...body,
        ...(mode === "installments" ? { installments } : {}),
        ...(mode === "recurring" ? { recurrence: { endDate: endDate || null, autoPaid } } : {}),
      });
    },
    onSuccess: () => {
      invalidate();
      toast(editing ? "Movimentação atualizada" : mode === "installments" ? `${installments} parcelas registradas` : "Movimentação registrada");
      onClose();
    },
    onError: (e) => setError({ msg: e instanceof Error ? e.message : "Erro ao salvar", field: e instanceof ApiError ? e.field : undefined }),
  });

  const remove = useMutation({
    mutationFn: (scope: "one" | "group") => del(`/transactions/${initial!.id}${scope === "group" ? "?scope=group" : ""}`),
    onSuccess: () => {
      invalidate();
      toast("Movimentação excluída");
      onClose();
    },
    onError: (e) => setError({ msg: e instanceof Error ? e.message : "Erro ao excluir" }),
  });

  const confirmDelete = () => {
    if (initial?.installmentGroup) {
      const all = window.confirm("Excluir também as próximas parcelas pendentes desta compra?\n\nOK = esta e as próximas · Cancelar = só esta");
      remove.mutate(all ? "group" : "one");
    } else if (window.confirm("Excluir esta movimentação? Ela deixará de contar nos saldos e relatórios.")) {
      remove.mutate("one");
    }
  };

  const perInstallment = cents && mode === "installments" ? Math.floor(cents / installments) : null;

  return (
    <Modal
      title={editing ? "Editar movimentação" : "Nova movimentação"}
      onClose={onClose}
      footer={
        <>
          {editing && (
            <button className="btn btn-ghost btn-danger" onClick={confirmDelete} disabled={remove.isPending} style={{ marginRight: "auto" }}>
              <Trash2 size={16} /> Excluir
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Salvando…" : editing ? "Salvar" : "Registrar"}
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="segmented kind" role="group" aria-label="Tipo" style={{ width: "100%" }}>
          {(["expense", "income"] as const).map((k) => (
            <button
              type="button"
              key={k}
              data-kind={k}
              aria-pressed={kind === k}
              style={{ flex: 1, justifyContent: "center" }}
              onClick={() => {
                setKind(k);
                setCategoryId("");
              }}
            >
              <i className="marker" style={{ background: k === "income" ? "var(--income)" : "var(--expense)" }} />
              {k === "income" ? "Receita" : "Despesa"}
            </button>
          ))}
        </div>

        <label className="field">
          <span>Valor {mode === "installments" ? "total" : ""}</span>
          <div className="money-input">
            <span className="prefix">R$</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={error?.field === "amountCents"}
              autoComplete="off"
            />
          </div>
          {perInstallment ? <small>{installments}x de {money(perInstallment)}</small> : null}
        </label>

        <label className="field">
          <span>Descrição</span>
          <input
            className="input"
            value={description}
            maxLength={160}
            placeholder={kind === "income" ? "Ex.: Salário" : "Ex.: Supermercado"}
            onChange={(e) => setDescription(e.target.value)}
            aria-invalid={error?.field === "description"}
          />
        </label>

        <div className="grid grid-2">
          <label className="field">
            <span>Categoria</span>
            <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Sem categoria</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{status === "pending" ? "Vencimento" : "Data"}</span>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
        </div>

        <div className="grid grid-2">
          <div className="field">
            <span>Situação</span>
            <div className="segmented" role="group" aria-label="Situação">
              <button type="button" aria-pressed={status === "paid"} onClick={() => setStatus("paid")}>
                {kind === "income" ? "Recebido" : "Pago"}
              </button>
              <button type="button" aria-pressed={status === "pending"} onClick={() => setStatus("pending")}>
                {kind === "income" ? "A receber" : "A pagar"}
              </button>
            </div>
          </div>
          <div className="field">
            <span>Natureza</span>
            <div className="segmented" role="group" aria-label="Natureza">
              <button type="button" aria-pressed={nature === "variable"} onClick={() => setNature("variable")}>
                Variável
              </button>
              <button type="button" aria-pressed={nature === "fixed"} onClick={() => setNature("fixed")}>
                Fixa
              </button>
            </div>
          </div>
        </div>

        {!editing && (
          <div className="field">
            <span>Repetição</span>
            <div className="segmented" role="group" aria-label="Repetição">
              <button type="button" aria-pressed={mode === "single"} onClick={() => setMode("single")}>
                Única
              </button>
              {kind === "expense" && (
                <button type="button" aria-pressed={mode === "installments"} onClick={() => setMode("installments")}>
                  Parcelada
                </button>
              )}
              <button
                type="button"
                aria-pressed={mode === "recurring"}
                onClick={() => {
                  setMode("recurring");
                  setNature("fixed");
                }}
              >
                Todo mês
              </button>
            </div>
          </div>
        )}

        {mode === "installments" && !editing && (
          <label className="field">
            <span>Número de parcelas</span>
            <input className="input" type="number" min={2} max={72} value={installments} onChange={(e) => setInstallments(Math.max(2, Math.min(72, Number(e.target.value) || 2)))} />
            <small>A primeira parcela usa a data acima; as demais ficam como pendentes nos meses seguintes.</small>
          </label>
        )}

        {mode === "recurring" && !editing && (
          <div className="grid grid-2">
            <label className="field">
              <span>Termina em (opcional)</span>
              <input className="input" type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            <label className="check" style={{ alignSelf: "end", minHeight: 42 }}>
              <input type="checkbox" checked={autoPaid} onChange={(e) => setAutoPaid(e.target.checked)} />
              Marcar como {kind === "income" ? "recebido" : "pago"} automaticamente
            </label>
          </div>
        )}

        {initial?.recurrenceId && <div className="alert info">Esta é uma ocorrência de uma conta recorrente. Para mudar todos os meses, edite a recorrência em Contas.</div>}
        {initial?.installmentNumber && (
          <div className="alert info">
            Parcela {initial.installmentNumber} de {initial.installmentTotal}.
          </div>
        )}

        <label className="field">
          <span>Forma de pagamento</span>
          <select className="select" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod | "")}>
            <option value="">Não informar</option>
            {(Object.keys(PAYMENT_LABELS) as PaymentMethod[]).map((m) => (
              <option key={m} value={m}>
                {PAYMENT_LABELS[m]}
              </option>
            ))}
          </select>
        </label>

        {accounts.length > 1 && (
          <label className="field">
            <span>Conta</span>
            <select className="select" value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
              <option value="">Conta principal</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span>Observações</span>
          <textarea className="input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        {error && (
          <div className="alert bad" role="alert">
            {error.msg}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
