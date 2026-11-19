import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Pencil, Plus, Target, Trash2 } from "lucide-react";
import { del, get, patch, post } from "../lib/api";
import { useApp, useCanSeeFamily, useInvalidateFinance, useMe, useMemberLookup } from "../lib/app";
import { centsToInput, dateFull, firstName, money, parseCents, todayIso } from "../lib/format";
import type { Goal } from "../lib/types";
import { Avatar, CardSkeleton, Empty, ErrorState, Modal, MoonPhase } from "../components/ui";

/** Tons que funcionam nos dois temas (metas antigas mantêm a cor salva). */
const GOAL_COLORS = ["#b47cf0", "#4fb894", "#5b8fe8", "#e0a23e", "#e4707e"];

function GoalForm({ goal, onClose }: { goal?: Goal; onClose(): void }) {
  const { toast } = useApp();
  const canFamily = useCanSeeFamily();
  const invalidate = useInvalidateFinance();
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(goal ? centsToInput(goal.targetCents) : "");
  const [initial, setInitial] = useState("");
  const [deadline, setDeadline] = useState(goal?.deadline ?? "");
  const [scope, setScope] = useState<"individual" | "family">(goal?.scope ?? "individual");
  const [color, setColor] = useState(goal?.color ?? GOAL_COLORS[0]);
  const save = useMutation({
    mutationFn: () => {
      const targetCents = parseCents(target);
      if (!targetCents || targetCents <= 0) throw new Error("Informe o valor da meta.");
      const body = { name, targetCents, deadline: deadline || null, color };
      return goal ? patch(`/goals/${goal.id}`, body) : post("/goals", { ...body, scope, initialCents: parseCents(initial) ?? undefined });
    },
    onSuccess: () => {
      invalidate();
      toast(goal ? "Meta atualizada" : "Meta criada");
      onClose();
    },
  });
  return (
    <Modal
      title={goal ? "Editar meta" : "Nova meta"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{goal ? "Salvar" : "Criar meta"}</button>
        </>
      }
    >
      <label className="field">
        <span>Nome</span>
        <input className="input" value={name} maxLength={60} placeholder="Ex.: Viagem de férias" onChange={(e) => setName(e.target.value)} />
      </label>
      {!goal && canFamily && (
        <div className="field">
          <span>De quem é a meta</span>
          <div className="segmented fill" role="group" aria-label="De quem é a meta">
            <button type="button" aria-pressed={scope === "individual"} onClick={() => setScope("individual")}>Minha</button>
            <button type="button" aria-pressed={scope === "family"} onClick={() => setScope("family")}>Da família</button>
          </div>
          <small>{scope === "family" ? "Todos podem contribuir e acompanhar." : "Só você contribui."}</small>
        </div>
      )}
      <div className="grid grid-2">
        <label className="field">
          <span>Valor da meta</span>
          <div className="money-input">
            <span className="prefix">R$</span>
            <input className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
        </label>
        <label className="field">
          <span>Prazo (opcional)</span>
          <input className="input" type="date" min={todayIso()} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
      </div>
      {!goal && (
        <label className="field">
          <span>Já tenho guardado (opcional)</span>
          <div className="money-input">
            <span className="prefix">R$</span>
            <input className="input" inputMode="decimal" value={initial} onChange={(e) => setInitial(e.target.value)} />
          </div>
        </label>
      )}
      <div className="field">
        <span>Cor</span>
        <div className="swatches">
          {GOAL_COLORS.map((c, i) => (
            <button key={c} type="button" className="swatch" aria-label={`Cor ${i + 1}`} aria-pressed={color === c} onClick={() => setColor(c)} style={{ ["--c" as string]: c }} />
          ))}
        </div>
      </div>
      {save.error && <div className="alert bad" role="alert">{save.error.message}</div>}
    </Modal>
  );
}

function ContributeForm({ goal, onClose }: { goal: Goal; onClose(): void }) {
  const { toast } = useApp();
  const invalidate = useInvalidateFinance();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const history = useQuery({ queryKey: ["goals", goal.id, "contrib"], queryFn: () => get<Array<{ id: number; userId: number; amountCents: number; date: string; note: string | null }>>(`/goals/${goal.id}/contributions`) });
  const lookup = useMemberLookup();
  const { data: me } = useMe();
  const save = useMutation({
    mutationFn: () => {
      const c = parseCents(amount);
      if (!c || c <= 0) throw new Error("Informe um valor.");
      return post<{ goal: Goal }>(`/goals/${goal.id}/contributions`, { amountCents: mode === "in" ? c : -c, note: note || null });
    },
    onSuccess: (r) => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["goals", goal.id, "contrib"] });
      toast(r.goal.achievedAt ? "Meta atingida! 🎉" : mode === "in" ? "Contribuição registrada" : "Retirada registrada");
      setAmount("");
      setNote("");
    },
  });
  const remove = useMutation({
    mutationFn: (cid: number) => del(`/goals/${goal.id}/contributions/${cid}`),
    onSuccess: () => {
      invalidate();
      qc.invalidateQueries({ queryKey: ["goals", goal.id, "contrib"] });
    },
  });
  return (
    <Modal title={goal.name} onClose={onClose}>
      <div className="goal-summary">
        <MoonPhase percent={goal.percent} size={64} color={goal.color} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="num goal-amount">{money(goal.savedCents)}</div>
          <div className="muted" style={{ fontSize: 13 }}>de {money(goal.targetCents)} · {Math.round(goal.percent)}%</div>
          <div className="progress" style={{ ["--c" as string]: goal.color, marginTop: 10 }} aria-hidden>
            <i style={{ width: `${Math.min(100, goal.percent)}%` }} />
          </div>
        </div>
      </div>
      <div className="segmented fill" role="group" aria-label="Operação">
        <button type="button" aria-pressed={mode === "in"} onClick={() => setMode("in")}><Plus size={15} /> Guardar</button>
        <button type="button" aria-pressed={mode === "out"} onClick={() => setMode("out")}><Minus size={15} /> Retirar</button>
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="money-input">
          <span className="prefix">R$</span>
          <input className="input" inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Valor" />
        </div>
        <input className="input" placeholder="Observação (opcional)" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} />
        {save.error && <div className="alert bad" role="alert">{save.error.message}</div>}
        <button className="btn btn-primary" disabled={save.isPending}>{mode === "in" ? "Registrar contribuição" : "Registrar retirada"}</button>
      </form>
      <div>
        <p className="eyebrow" style={{ marginBottom: 4 }}>Histórico</p>
        {history.data?.length ? (
          <div className="list">
            {history.data.map((c) => {
              const who = lookup(c.userId);
              return (
                <div className="list-item" key={c.id}>
                  {who ? <Avatar name={who.name} color={who.color} size="sm" /> : <span />}
                  <div style={{ minWidth: 0 }}>
                    <div className="title">{c.note || (c.amountCents > 0 ? "Contribuição" : "Retirada")}</div>
                    <div className="sub">{dateFull(c.date)} · {who ? firstName(who.name) : ""}</div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <span className={`num ${c.amountCents > 0 ? "is-income" : ""}`}>{(c.amountCents > 0 ? "+" : "−") + money(Math.abs(c.amountCents))}</span>
                    {c.userId === me?.id && (
                      <button className="btn btn-ghost icon-btn" aria-label="Excluir contribuição" onClick={() => window.confirm("Excluir esta contribuição?") && remove.mutate(c.id)}>
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="faint">Nenhuma contribuição ainda.</p>
        )}
      </div>
    </Modal>
  );
}

export function GoalsPage() {
  const { data: me } = useMe();
  const { toast } = useApp();
  const invalidate = useInvalidateFinance();
  const lookup = useMemberLookup();
  const [filter, setFilter] = useState<"all" | "mine" | "family">("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [open, setOpen] = useState<Goal | null>(null);
  const goals = useQuery({ queryKey: ["goals"], queryFn: () => get<Goal[]>("/goals") });
  const remove = useMutation({
    mutationFn: (g: Goal) => del(`/goals/${g.id}`),
    onSuccess: () => {
      invalidate();
      toast("Meta excluída");
    },
    onError: (e) => toast(e.message, "error"),
  });
  const list = (goals.data ?? []).filter((g) => (filter === "all" ? true : filter === "mine" ? g.scope === "individual" && g.ownerId === me?.id : g.scope === "family"));
  const totalSaved = list.reduce((s, g) => s + g.savedCents, 0);
  const totalTarget = list.reduce((s, g) => s + g.targetCents, 0);
  const current = open ? goals.data?.find((g) => g.id === open.id) ?? open : null;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Planejamento</p>
          <h1>Metas</h1>
          {list.length > 0 && (
            <p>
              <b className="num" style={{ color: "var(--text)" }}>{money(totalSaved)}</b> guardados de <span className="tnum">{money(totalTarget)}</span>
            </p>
          )}
        </div>
        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Filtro">
            <button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Todas</button>
            <button aria-pressed={filter === "mine"} onClick={() => setFilter("mine")}>Minhas</button>
            <button aria-pressed={filter === "family"} onClick={() => setFilter("family")}>Família</button>
          </div>
          <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> Nova meta</button>
        </div>
      </div>

      {goals.error && <ErrorState error={goals.error} retry={() => goals.refetch()} />}
      {!goals.data && !goals.error ? (
        <div className="grid grid-3"><CardSkeleton /><CardSkeleton /><CardSkeleton /></div>
      ) : list.length === 0 ? (
        <div className="card">
          <Empty icon={<Target size={22} />} title="Nenhuma meta por aqui" text="Defina um objetivo — reserva de emergência, viagem, um curso — e acompanhe a lua encher." action={<button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Plus size={15} /> Criar meta</button>} />
        </div>
      ) : (
        <div className="grid grid-3 reveal">
          {list.map((g) => {
            const mine = g.ownerId === me?.id;
            const canContribute = g.scope === "family" || mine;
            return (
              <article className="card goal-card" key={g.id} style={{ ["--c" as string]: g.color }}>
                <div className="goal-card-top">
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                      {g.scope === "family" ? <span className="chip primary">Família</span> : <span className="chip">Individual</span>}
                      {g.achievedAt && <span className="chip lime">Atingida</span>}
                    </div>
                    <h2 className="goal-name">{g.name}</h2>
                  </div>
                  <MoonPhase percent={g.percent} size={60} color={g.color} />
                </div>
                <div>
                  <div className="num goal-amount">{money(g.savedCents)}</div>
                  <div className="muted" style={{ fontSize: 13 }}>de <span className="tnum">{money(g.targetCents)}</span></div>
                </div>
                <div className="progress lg" role="progressbar" aria-label={`Progresso de ${g.name}`} aria-valuenow={Math.round(g.percent)} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: `${Math.min(100, g.percent)}%` }} />
                </div>
                <div className="row between" style={{ fontSize: 13 }}>
                  <span className="tnum"><b>{Math.round(g.percent)}%</b> concluído</span>
                  <span className="faint">{g.deadline ? `até ${dateFull(g.deadline)}` : "sem prazo"}</span>
                </div>
                {g.monthlyNeededCents && !g.achievedAt && (
                  <div className="alert info"><span>Guardando <b className="num">{money(g.monthlyNeededCents)}</b> por mês você chega lá no prazo.</span></div>
                )}
                {g.scope === "family" && g.contributors.length > 0 && (
                  <div className="row" style={{ gap: 6 }}>
                    <span className="avatar-stack">
                      {g.contributors.map((c) => {
                        const m = lookup(c.userId);
                        return m ? <Avatar key={c.userId} name={m.name} color={m.color} size="sm" /> : null;
                      })}
                    </span>
                    <span className="faint" style={{ fontSize: 12.5 }}>contribuíram</span>
                  </div>
                )}
                <div className="goal-actions">
                  {canContribute && <button className="btn btn-sm" onClick={() => setOpen(g)}><Plus size={14} /> Contribuir</button>}
                  {mine && (
                    <>
                      <button className="btn btn-sm btn-ghost" aria-label="Editar meta" onClick={() => setEditing(g)}><Pencil size={14} /></button>
                      <button className="btn btn-sm btn-ghost btn-danger" aria-label="Excluir meta" onClick={() => window.confirm(`Excluir a meta “${g.name}” e seu histórico?`) && remove.mutate(g)}><Trash2 size={14} /></button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {creating && <GoalForm onClose={() => setCreating(false)} />}
      {editing && <GoalForm goal={editing} onClose={() => setEditing(null)} />}
      {current && <ContributeForm goal={current} onClose={() => setOpen(null)} />}
    </>
  );
}
