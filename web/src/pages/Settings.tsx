import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowLeftRight, Copy, ExternalLink, Link2, Plus, Send, Trash2, Unlink } from "lucide-react";
import { del, get, patch, post } from "../lib/api";
import { useAccounts, useApp, useCategories, useMe } from "../lib/app";
import { centsToInput, dateFull, firstName, memberColor, money, parseCents, todayIso } from "../lib/format";
import type { Me } from "../lib/types";
import { Avatar, ICON_CHOICES, Icon, Modal, Skeleton } from "../components/ui";

function Section({ id, title, desc, children }: { id: string; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card" style={{ scrollMarginTop: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <h2>{title}</h2>
        {desc && <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>{desc}</p>}
      </div>
      <div className="stack">{children}</div>
    </section>
  );
}

function ProfileSection({ me }: { me: Me }) {
  const { toast, theme, setTheme, dark } = useApp();
  const qc = useQueryClient();
  const [name, setName] = useState(me.name);
  const save = useMutation({
    mutationFn: (body: Partial<Me>) => patch<Me>("/me", body),
    onSuccess: (data) => {
      qc.setQueryData(["me"], data);
      qc.invalidateQueries({ queryKey: ["members"] });
      toast("Perfil atualizado");
    },
    onError: (e) => toast(e.message, "error"),
  });
  const palette = ["#2a78d6", "#eb6834", "#1baf7a", "#6250d6", "#e87ba4", "#eda100"];
  return (
    <Section id="perfil" title="Seu perfil">
      <div className="row" style={{ gap: 14 }}>
        <Avatar name={me.name} color={memberColor(me.color, dark)} size="lg" />
        <div>
          <div style={{ fontWeight: 650 }}>{me.name}</div>
          <div className="faint" style={{ fontSize: 13 }}>{me.email}</div>
        </div>
      </div>
      <form
        className="row wrap"
        style={{ alignItems: "end" }}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ name });
        }}
      >
        <label className="field" style={{ flex: "1 1 220px" }}>
          <span>Como quer ser chamado(a)</span>
          <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn" disabled={name === me.name || save.isPending}>Salvar</button>
      </form>
      <div className="field">
        <span>Sua cor</span>
        <div className="row">
          {palette.map((c) => (
            <button key={c} type="button" aria-label={`Usar cor ${c}`} aria-pressed={me.color === c} onClick={() => save.mutate({ color: c })} style={{ width: 30, height: 30, borderRadius: "50%", cursor: "pointer", background: memberColor(c, dark), border: me.color === c ? "3px solid var(--ink)" : "3px solid transparent" }} />
          ))}
        </div>
      </div>
      <div className="field">
        <span>Aparência</span>
        <div className="segmented" role="group">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} aria-pressed={theme === t} onClick={() => setTheme(t)}>{t === "system" ? "Automático" : t === "light" ? "Claro" : "Escuro"}</button>
          ))}
        </div>
      </div>
    </Section>
  );
}

function SecuritySection() {
  const { toast } = useApp();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const save = useMutation({
    mutationFn: () => post("/me/password", { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast("Senha alterada. As outras sessões foram encerradas.");
      setCurrent("");
      setNext("");
    },
  });
  return (
    <Section id="seguranca" title="Senha" desc="Trocar a senha encerra o acesso em outros aparelhos.">
      <form className="grid grid-2" style={{ alignItems: "end" }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="field"><span>Senha atual</span><input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label className="field"><span>Nova senha</span><input className="input" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></label>
        {save.error && <div className="alert bad span-2">{save.error.message}</div>}
        <div><button className="btn" disabled={!current || next.length < 10 || save.isPending}>Alterar senha</button></div>
      </form>
    </Section>
  );
}

function TelegramSection({ me }: { me: Me }) {
  const { toast } = useApp();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["telegram-status"], queryFn: () => get<{ configured: boolean; botUsername: string | null }>("/telegram/status") });
  const [code, setCode] = useState<{ code: string; deepLink: string | null; expiresAt: string } | null>(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!code) return;
    const tick = () => setLeft(Math.max(0, Math.round((Date.parse(code.expiresAt) - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [code]);
  // ao voltar para a aba, verifica se a vinculação foi concluída
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ["me"] }), 5000);
    return () => clearInterval(t);
  }, [code, qc]);
  useEffect(() => {
    if (me.telegramLinkedAt && code) {
      setCode(null);
      toast("Telegram conectado ✅");
    }
  }, [me.telegramLinkedAt, code, toast]);
  const gen = useMutation({ mutationFn: () => post<{ code: string; deepLink: string | null; expiresAt: string }>("/telegram/link-code"), onSuccess: setCode, onError: (e) => toast(e.message, "error") });
  const unlink = useMutation({
    mutationFn: () => del("/telegram/link"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["members"] });
      toast("Telegram desconectado");
    },
  });
  const bot = status.data?.botUsername;
  return (
    <Section id="telegram" title="Telegram" desc="Consulte saldos e registre gastos por mensagem. Cada pessoa conecta o próprio Telegram.">
      {status.data && !status.data.configured && <div className="alert">O bot ainda não foi configurado no servidor. Veja o guia em docs/TELEGRAM.md.</div>}
      {me.telegramLinkedAt ? (
        <div className="row wrap between">
          <div className="row">
            <span className="cat-icon" style={{ ["--c" as string]: "#2a9fd8" }}><Send size={18} /></span>
            <div>
              <div style={{ fontWeight: 650 }}>Conectado{me.telegramUsername ? ` como @${me.telegramUsername}` : ""}</div>
              <div className="faint" style={{ fontSize: 13 }}>desde {new Date(me.telegramLinkedAt).toLocaleDateString("pt-BR")}</div>
            </div>
          </div>
          <div className="row">
            {bot && <a className="btn btn-sm" href={`https://t.me/${bot}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Abrir bot</a>}
            <button className="btn btn-sm btn-danger" onClick={() => window.confirm("Desconectar o Telegram desta conta?") && unlink.mutate()}><Unlink size={14} /> Desconectar</button>
          </div>
        </div>
      ) : code && left > 0 ? (
        <div className="stack" style={{ gap: 12 }}>
          {code.deepLink && (
            <a className="btn btn-primary" href={code.deepLink} target="_blank" rel="noreferrer" style={{ justifySelf: "start" }}>
              <Send size={16} /> Abrir no Telegram e conectar
            </a>
          )}
          <div className="alert info" style={{ display: "grid", gap: 6 }}>
            <span>Ou envie esta mensagem para {bot ? <b>@{bot}</b> : "o bot"}:</span>
            <div className="row">
              <code className="num" style={{ fontSize: 20, letterSpacing: "0.08em" }}>/vincular {code.code}</code>
              <button className="btn btn-sm btn-ghost" aria-label="Copiar" onClick={() => navigator.clipboard?.writeText(`/vincular ${code.code}`).then(() => toast("Copiado"))}><Copy size={14} /></button>
            </div>
            <span className="faint" style={{ fontSize: 12.5 }}>Código pessoal, de uso único. Expira em {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}. Não compartilhe.</span>
          </div>
        </div>
      ) : (
        <div>
          <button className="btn btn-primary" onClick={() => gen.mutate()} disabled={gen.isPending || status.data?.configured === false}>
            <Link2 size={16} /> Conectar meu Telegram
          </button>
        </div>
      )}
    </Section>
  );
}

function NotificationsSection({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useApp();
  const save = useMutation({
    mutationFn: (body: Partial<Me>) => patch<Me>("/me", body),
    onSuccess: (d) => qc.setQueryData(["me"], d),
    onError: (e) => toast(e.message, "error"),
  });
  const items: Array<[keyof Me, string, string]> = [
    ["notifyOverdue", "Contas atrasadas", "Um aviso quando uma conta passa do vencimento."],
    ["notifyWeekly", "Resumo semanal", "Toda segunda, às 9h."],
    ["notifyDaily", "Resumo diário", "Todos os dias, às 20h."],
    ["notifyGoals", "Metas", "Quando uma meta chega a 90% e quando é atingida."],
    ["notifyAnomaly", "Gastos fora do padrão", "Só quando há histórico suficiente na categoria (gasto ≥ 3× o seu típico)."],
  ];
  return (
    <Section id="notificacoes" title="Avisos no Telegram" desc={me.telegramLinkedAt ? "Mensagens automáticas entre 9h e 21h." : "Conecte o Telegram para receber os avisos."}>
      <label className="field" style={{ maxWidth: 320 }}>
        <span>Lembrete de vencimento</span>
        <select className="select" value={me.notifyDueDays} onChange={(e) => save.mutate({ notifyDueDays: Number(e.target.value) })}>
          <option value={0}>Desligado</option>
          {[1, 2, 3, 5, 7].map((n) => <option key={n} value={n}>{n} dia(s) antes</option>)}
        </select>
      </label>
      {items.map(([key, label, desc]) => (
        <label className="check" key={key} style={{ alignItems: "flex-start" }}>
          <input type="checkbox" checked={Boolean(me[key])} onChange={(e) => save.mutate({ [key]: e.target.checked } as Partial<Me>)} style={{ marginTop: 3 }} />
          <span>
            <span style={{ display: "block" }}>{label}</span>
            <span className="faint" style={{ fontSize: 13, fontWeight: 400 }}>{desc}</span>
          </span>
        </label>
      ))}
    </Section>
  );
}

const ACCOUNT_TYPES: Record<string, string> = { checking: "Conta corrente", savings: "Poupança", cash: "Dinheiro", investment: "Investimentos", wallet: "Carteira digital", other: "Outra" };

interface TransferItem { id: number; fromAccountName: string; toAccountName: string; amountCents: number; date: string; source: string }

function TransfersList() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["transfers"], queryFn: () => get<TransferItem[]>("/transfers") });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/transfers/${id}`),
    onSuccess: () => {
      for (const k of ["transfers", "accounts", "dashboard"]) qc.invalidateQueries({ queryKey: [k] });
      toast("Transferência excluída");
    },
    onError: (e) => toast(e.message, "error"),
  });
  if (!list.data?.length) return null;
  return (
    <div>
      <p className="eyebrow" style={{ margin: "4px 0 6px" }}>Transferências recentes</p>
      <div className="list">
        {list.data.slice(0, 6).map((t) => (
          <div className="list-item" key={t.id} style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}>
              <div className="title">{t.fromAccountName} → {t.toAccountName}</div>
              <div className="sub">{dateFull(t.date)}{t.source === "telegram" ? " · pelo Telegram" : ""}</div>
            </div>
            <div className="row">
              <b className="num">{money(t.amountCents)}</b>
              <button className="btn btn-ghost icon-btn" aria-label="Excluir transferência" onClick={() => window.confirm("Excluir esta transferência? Os saldos das contas voltam ao que eram.") && remove.mutate(t.id)}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AccountsSection() {
  const { data: accounts, isLoading } = useAccounts();
  const { toast } = useApp();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ id?: number; name: string; type: string; initial: string } | null>(null);
  const [transfer, setTransfer] = useState<{ from: number; to: number; amount: string; date: string } | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["transfers"] });
  };
  const doTransfer = useMutation({
    mutationFn: () => {
      const cents = parseCents(transfer!.amount);
      if (!cents || cents <= 0) throw new Error("Informe o valor.");
      if (transfer!.from === transfer!.to) throw new Error("Escolha contas diferentes.");
      return post("/transfers", { fromAccountId: transfer!.from, toAccountId: transfer!.to, amountCents: cents, date: transfer!.date });
    },
    onSuccess: () => { refresh(); setTransfer(null); toast("Transferência registrada"); },
    onError: (e) => toast(e.message, "error"),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form!.name, type: form!.type, initialBalanceCents: parseCents(form!.initial) ?? 0 };
      return form!.id ? patch(`/accounts/${form!.id}`, body) : post("/accounts", body);
    },
    onSuccess: () => { refresh(); setForm(null); toast("Conta salva"); },
    onError: (e) => toast(e.message, "error"),
  });
  const action = useMutation({
    mutationFn: ({ id, body }: { id: number; body: object }) => patch(`/accounts/${id}`, body),
    onSuccess: refresh,
    onError: (e) => toast(e.message, "error"),
  });
  return (
    <Section id="contas" title="Suas contas" desc="Onde o dinheiro fica. O saldo inicial é o valor que havia antes de começar a usar o Luna.">
      {isLoading ? <Skeleton h={60} /> : (
        <div className="list">
          {accounts?.map((a) => (
            <div className="list-item" key={a.id}>
              <span className="cat-icon"><Icon name="wallet" /></span>
              <div style={{ minWidth: 0 }} className="clickable" onClick={() => setForm({ id: a.id, name: a.name, type: a.type, initial: centsToInput(a.initialBalanceCents) })}>
                <div className="title">{a.name} {a.isDefault && <span className="chip">Principal</span>}</div>
                <div className="sub">{ACCOUNT_TYPES[a.type] ?? a.type}</div>
              </div>
              <div className="row">
                <b className="num">{money(a.balanceCents)}</b>
                {!a.isDefault && (
                  <>
                    <button className="btn btn-sm btn-ghost" onClick={() => action.mutate({ id: a.id, body: { isDefault: true } })}>Tornar principal</button>
                    <button className="btn btn-sm btn-ghost" aria-label="Arquivar" onClick={() => window.confirm("Arquivar esta conta? Ela deixa de somar no saldo.") && action.mutate({ id: a.id, body: { archived: true } })}><Archive size={14} /></button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row wrap">
        <button className="btn btn-sm" onClick={() => setForm({ name: "", type: "checking", initial: "" })}><Plus size={14} /> Nova conta</button>
        {(accounts?.length ?? 0) >= 2 && <button className="btn btn-sm" onClick={() => setTransfer({ from: accounts![0].id, to: accounts![1].id, amount: "", date: todayIso() })}><ArrowLeftRight size={14} /> Transferir entre contas</button>}
      </div>
      <TransfersList />
      {transfer && accounts && (
        <Modal title="Transferência entre contas" onClose={() => setTransfer(null)} footer={<><button className="btn" onClick={() => setTransfer(null)}>Cancelar</button><button className="btn btn-primary" disabled={doTransfer.isPending} onClick={() => doTransfer.mutate()}>Transferir</button></>}>
          <p className="muted" style={{ margin: 0 }}>Move dinheiro entre suas contas. Não conta como receita nem despesa.</p>
          <div className="grid grid-2">
            <label className="field"><span>De</span>
              <select className="select" value={transfer.from} onChange={(e) => setTransfer({ ...transfer, from: Number(e.target.value) })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </label>
            <label className="field"><span>Para</span>
              <select className="select" value={transfer.to} onChange={(e) => setTransfer({ ...transfer, to: Number(e.target.value) })}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </label>
          </div>
          <div className="grid grid-2">
            <label className="field"><span>Valor</span>
              <div className="money-input"><span className="prefix">R$</span><input className="input" inputMode="decimal" value={transfer.amount} onChange={(e) => setTransfer({ ...transfer, amount: e.target.value })} /></div>
            </label>
            <label className="field"><span>Data</span><input className="input" type="date" max={todayIso()} value={transfer.date} onChange={(e) => setTransfer({ ...transfer, date: e.target.value })} /></label>
          </div>
        </Modal>
      )}
      {form && (
        <Modal title={form.id ? "Editar conta" : "Nova conta"} onClose={() => setForm(null)} footer={<><button className="btn" onClick={() => setForm(null)}>Cancelar</button><button className="btn btn-primary" onClick={() => save.mutate()} disabled={!form.name || save.isPending}>Salvar</button></>}>
          <label className="field"><span>Nome</span><input className="input" value={form.name} maxLength={40} placeholder="Ex.: Nubank" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Tipo</span>
            <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(ACCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </label>
          <label className="field"><span>Saldo inicial</span>
            <div className="money-input"><span className="prefix">R$</span><input className="input" inputMode="decimal" value={form.initial} onChange={(e) => setForm({ ...form, initial: e.target.value })} /></div>
          </label>
        </Modal>
      )}
    </Section>
  );
}

function CategoriesSection({ me }: { me: Me }) {
  const { data: categories } = useCategories();
  const { toast } = useApp();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ id?: number; name: string; kind: "income" | "expense"; icon: string; keywords: string } | null>(null);
  const save = useMutation({
    mutationFn: () => form!.id ? patch(`/categories/${form!.id}`, { name: form!.name, icon: form!.icon, keywords: form!.keywords }) : post("/categories", { ...form, color: "#7d8191" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["categories"] }); setForm(null); toast("Categoria salva"); },
    onError: (e) => toast(e.message, "error"),
  });
  const archive = useMutation({
    mutationFn: (id: number) => patch(`/categories/${id}`, { archived: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
    onError: (e) => toast(e.message, "error"),
  });
  const canEdit = (c: { createdBy: number | null; isDefault: boolean }) => c.createdBy === me.id || (c.isDefault && me.capabilities.manageMembers);
  return (
    <Section id="categorias" title="Categorias" desc="Compartilhadas pela família. As palavras-chave ajudam o bot a classificar mensagens.">
      {(["expense", "income"] as const).map((k) => (
        <div key={k}>
          <p className="eyebrow" style={{ margin: "0 0 8px" }}>{k === "expense" ? "Despesas" : "Receitas"}</p>
          <div className="row wrap" style={{ gap: 8 }}>
            {categories?.filter((c) => c.kind === k).map((c) => (
              <button key={c.id} className="chip" style={{ height: 32, border: 0, cursor: canEdit(c) ? "pointer" : "default", ["--c" as string]: c.color }} onClick={() => canEdit(c) && setForm({ id: c.id, name: c.name, kind: c.kind, icon: c.icon, keywords: c.keywords })}>
                <span style={{ color: c.color, display: "inline-flex" }}><Icon name={c.icon} size={14} /></span> {c.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div><button className="btn btn-sm" onClick={() => setForm({ name: "", kind: "expense", icon: "tag", keywords: "" })}><Plus size={14} /> Nova categoria</button></div>
      {form && (
        <Modal title={form.id ? "Editar categoria" : "Nova categoria"} onClose={() => setForm(null)} footer={<>
          {form.id && <button className="btn btn-ghost btn-danger" style={{ marginRight: "auto" }} onClick={() => { archive.mutate(form.id!); setForm(null); }}><Archive size={15} /> Arquivar</button>}
          <button className="btn" onClick={() => setForm(null)}>Cancelar</button>
          <button className="btn btn-primary" disabled={!form.name || save.isPending} onClick={() => save.mutate()}>Salvar</button></>}>
          {!form.id && (
            <div className="segmented" role="group">
              <button type="button" aria-pressed={form.kind === "expense"} onClick={() => setForm({ ...form, kind: "expense" })}>Despesa</button>
              <button type="button" aria-pressed={form.kind === "income"} onClick={() => setForm({ ...form, kind: "income" })}>Receita</button>
            </div>
          )}
          <label className="field"><span>Nome</span><input className="input" value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Palavras-chave (separadas por vírgula)</span><input className="input" value={form.keywords} maxLength={400} placeholder="academia, smartfit" onChange={(e) => setForm({ ...form, keywords: e.target.value })} /></label>
          <div className="field"><span>Ícone</span>
            <div className="row wrap" style={{ gap: 6 }}>
              {ICON_CHOICES.map((i) => (
                <button key={i} type="button" className="btn icon-btn" aria-pressed={form.icon === i} aria-label={i} onClick={() => setForm({ ...form, icon: i })} style={{ borderColor: form.icon === i ? "var(--ink)" : undefined }}><Icon name={i} size={16} /></button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </Section>
  );
}

interface ManagedMember { id: number; name: string; email: string; color: string; familyAccess: "none" | "summary" | "full"; active: boolean; hasPassword: boolean; telegramLinked: boolean; lastSeenAt: string | null }

/**
 * Pessoas da família — só aparece para quem pode gerenciar o sistema,
 * mas sem nenhum título, selo ou texto que indique isso.
 */
function FamilySection({ me }: { me: Me }) {
  const { toast, dark } = useApp();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["family-members"], queryFn: () => get<ManagedMember[]>("/family/members") });
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newM, setNewM] = useState({ name: "", email: "" });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["family-members"] }); qc.invalidateQueries({ queryKey: ["members"] }); };
  const access = useMutation({
    mutationFn: ({ id, body }: { id: number; body: object }) => patch(`/family/members/${id}`, body),
    onSuccess: () => { refresh(); toast("Acesso atualizado"); },
    onError: (e) => toast(e.message, "error"),
  });
  const issue = useMutation({
    mutationFn: (m: ManagedMember) => post<{ url: string }>(`/family/members/${m.id}/access-link`).then((r) => ({ name: m.name, url: r.url })),
    onSuccess: setLink,
    onError: (e) => toast(e.message, "error"),
  });
  const create = useMutation({
    mutationFn: () => post<{ url: string }>("/family/members", newM),
    onSuccess: (r) => { refresh(); setAdding(false); setLink({ name: newM.name, url: r.url }); setNewM({ name: "", email: "" }); },
    onError: (e) => toast(e.message, "error"),
  });
  return (
    <Section id="familia" title="Pessoas da família" desc="Defina o que cada pessoa enxerga dos dados dos outros e gere links de acesso.">
      {!list.data ? <Skeleton h={80} /> : (
        <div className="list">
          {list.data.map((m) => (
            <div className="list-item" key={m.id} style={{ gridTemplateColumns: "auto 1fr auto", opacity: m.active ? 1 : 0.5 }}>
              <Avatar name={m.name} color={memberColor(m.color, dark)} />
              <div style={{ minWidth: 0 }}>
                <div className="title">{m.name}</div>
                <div className="sub">
                  <span>{m.email}</span>
                  {!m.hasPassword && <span className="chip warn">Aguardando primeiro acesso</span>}
                  {m.telegramLinked && <span className="chip">Telegram</span>}
                </div>
              </div>
              <div className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
                <select className="select" style={{ width: "auto", height: 34 }} aria-label={`O que ${firstName(m.name)} vê da família`} value={m.familyAccess} onChange={(e) => access.mutate({ id: m.id, body: { familyAccess: e.target.value } })}>
                  <option value="full">Vê tudo da família</option>
                  <option value="summary">Só totais da família</option>
                  <option value="none">Só os próprios dados</option>
                </select>
                {m.active && <button className="btn btn-sm" onClick={() => issue.mutate(m)}>Link de acesso</button>}
                {m.id !== me.id && (
                  <button className="btn btn-sm btn-ghost" onClick={() => window.confirm(m.active ? `Desativar o acesso de ${m.name}?` : `Reativar ${m.name}?`) && access.mutate({ id: m.id, body: { active: !m.active } })}>
                    {m.active ? "Desativar" : "Reativar"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div><button className="btn btn-sm" onClick={() => setAdding(true)}><Plus size={14} /> Adicionar pessoa</button></div>
      {adding && (
        <Modal title="Adicionar pessoa" onClose={() => setAdding(false)} footer={<><button className="btn" onClick={() => setAdding(false)}>Cancelar</button><button className="btn btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>Adicionar</button></>}>
          <label className="field"><span>Nome</span><input className="input" value={newM.name} onChange={(e) => setNewM({ ...newM, name: e.target.value })} /></label>
          <label className="field"><span>E-mail</span><input className="input" type="email" value={newM.email} onChange={(e) => setNewM({ ...newM, email: e.target.value })} /></label>
        </Modal>
      )}
      {link && (
        <Modal title={`Link para ${firstName(link.name)}`} onClose={() => setLink(null)}>
          <p className="muted" style={{ margin: 0 }}>Envie este link somente para {firstName(link.name)}, por mensagem privada. Ele é de uso único e expira em breve.</p>
          <input className="input" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn btn-primary" onClick={() => navigator.clipboard?.writeText(link.url).then(() => toast("Link copiado"))}><Copy size={15} /> Copiar link</button>
        </Modal>
      )}
    </Section>
  );
}

export function SettingsPage() {
  const { data: me } = useMe();
  if (!me) return <Skeleton h={300} />;
  const links = [
    ["perfil", "Perfil"], ["telegram", "Telegram"], ["notificacoes", "Avisos"], ["contas", "Contas"], ["categorias", "Categorias"], ["seguranca", "Senha"],
    ...(me.capabilities.manageMembers ? [["familia", "Pessoas"]] : []),
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">Preferências</p>
          <h1>Configurações</h1>
        </div>
      </div>
      <nav className="segmented" aria-label="Seções" style={{ marginBottom: 16 }}>
        {links.map(([id, label]) => (
          <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })}>{label}</button>
        ))}
      </nav>
      <div className="stack" style={{ maxWidth: 860 }}>
        <ProfileSection me={me} />
        <TelegramSection me={me} />
        <NotificationsSection me={me} />
        <AccountsSection />
        <CategoriesSection me={me} />
        <SecuritySection />
        {me.capabilities.manageMembers && <FamilySection me={me} />}
      </div>
    </>
  );
}
