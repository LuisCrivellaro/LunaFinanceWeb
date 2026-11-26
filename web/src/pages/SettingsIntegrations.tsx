/**
 * Configurações → Integrações (WhatsApp/OpenBot) e Finanças (orçamentos,
 * cartões e fatura). Só usa rotas já existentes em server/src/routes/api.ts;
 * toda permissão é decidida no servidor — aqui apenas escondemos o que a
 * pessoa não pode usar.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Link2, MessageCircle, Plus, ShieldCheck, Trash2, Unlink, X } from "lucide-react";
import { del, get, patch, post, put } from "../lib/api";
import { useApp, useCategories, useMemberLookup, useMembers } from "../lib/app";
import { centsToInput, firstName, money, monthLong, parseCents } from "../lib/format";
import type { Me } from "../lib/types";
import { Modal, Skeleton } from "../components/ui";
import { Section } from "../components/SettingsSection";

const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");

/** Segundos restantes até `iso` (atualiza a cada segundo). */
function useCountdown(iso: string | null) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const tick = () => setLeft(Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [iso]);
  return left;
}
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function copy(text: string, toast: (m: string) => void, msg = "Copiado") {
  navigator.clipboard?.writeText(text).then(() => toast(msg));
}

// ============================== Seu WhatsApp ==============================

interface MyWhatsApp {
  linked: boolean;
  phoneMasked: string | null;
  linkedAt: string | null;
  linkedVia: string | null;
  lastSeenAt: string | null;
  pinSet: boolean;
  activeSessions: number;
  integrationEnabled: boolean;
}

export function WhatsAppSection() {
  const { toast } = useApp();
  const qc = useQueryClient();
  // `before`: linkedAt no momento em que o código foi gerado (detecta a conclusão)
  const [code, setCode] = useState<{ code: string; expiresAt: string; phoneMasked: string; before: string | null } | null>(null);
  const left = useCountdown(code?.expiresAt ?? null);
  const status = useQuery({
    queryKey: ["me-whatsapp"],
    queryFn: () => get<MyWhatsApp>("/me/whatsapp"),
    // enquanto há um código válido, confere se a vinculação foi concluída
    refetchInterval: code && left > 0 ? 5000 : false,
  });
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState({ pin: "", password: "" });
  const [pinOpen, setPinOpen] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["me-whatsapp"] });
    qc.invalidateQueries({ queryKey: ["openbot"] });
  };
  const s = status.data;
  useEffect(() => {
    if (code && s?.linked && s.linkedAt && s.linkedAt !== code.before) {
      setCode(null);
      toast("WhatsApp vinculado ✅");
    }
  }, [s?.linked, s?.linkedAt, code, toast]);

  const gen = useMutation({
    mutationFn: () => post<{ code: string; expiresAt: string; phoneMasked: string }>("/me/whatsapp/link-code", { phone }),
    onSuccess: (c) => { setCode({ ...c, before: status.data?.linkedAt ?? null }); setPhone(""); },
    onError: (e) => toast(e.message, "error"),
  });
  const savePin = useMutation({
    mutationFn: () => put("/me/whatsapp/pin", pin),
    onSuccess: () => { refresh(); setPin({ pin: "", password: "" }); setPinOpen(false); toast("PIN salvo. Sessões abertas foram encerradas."); },
  });
  const endSessions = useMutation({
    mutationFn: () => del<{ revoked: number }>("/me/whatsapp/sessions"),
    onSuccess: (r) => { refresh(); toast(`${r.revoked} sessão(ões) encerrada(s)`); },
    onError: (e) => toast(e.message, "error"),
  });
  const unlink = useMutation({
    mutationFn: () => del("/me/whatsapp"),
    onSuccess: () => { refresh(); toast("WhatsApp desvinculado"); },
    onError: (e) => toast(e.message, "error"),
  });

  const pinValid = /^\d{6,8}$/.test(pin.pin) && pin.password.length > 0;
  return (
    <Section id="whatsapp" title="Seu WhatsApp" desc="Converse com o Luna pelo WhatsApp (agente no OpenBot). Cada pessoa vincula o próprio número e define um PIN.">
      {!s ? <Skeleton h={60} /> : (
        <>
          {!s.integrationEnabled && <div className="alert">A integração com o WhatsApp está desligada no momento. Você pode deixar tudo pronto; ela funciona assim que for ligada.</div>}
          <div className="row wrap between">
            <div className="row">
              <span className="cat-icon" style={{ ["--c" as string]: "#25d366" }}><MessageCircle size={18} /></span>
              <div>
                <div className="row wrap" style={{ gap: 8, fontWeight: 650 }}>
                  {s.linked ? <span className="chip ok">Vinculado</span> : <span className="chip">Não vinculado</span>}
                  {s.phoneMasked && <span className="tnum">{s.phoneMasked}</span>}
                  {s.pinSet ? <span className="chip ok">PIN definido</span> : <span className="chip warn">Sem PIN</span>}
                </div>
                <div className="faint" style={{ fontSize: 13 }}>
                  {s.linked
                    ? `desde ${when(s.linkedAt)}${s.linkedVia === "admin" ? " · vinculado por quem gerencia a família" : ""} · última mensagem autenticada: ${when(s.lastSeenAt)}`
                    : "Vincule seu número para registrar gastos e consultar saldos por mensagem."}
                </div>
              </div>
            </div>
            {s.linked && (
              <div className="row wrap">
                {s.activeSessions > 0 && (
                  <button className="btn btn-sm" disabled={endSessions.isPending} onClick={() => endSessions.mutate()}>
                    <X size={14} /> Encerrar {s.activeSessions} sessão(ões)
                  </button>
                )}
                <button className="btn btn-sm btn-danger" disabled={unlink.isPending} onClick={() => window.confirm("Desvincular seu WhatsApp? Sessões e rascunhos pendentes são cancelados na hora.") && unlink.mutate()}>
                  <Unlink size={14} /> Desvincular
                </button>
              </div>
            )}
          </div>

          {code && left > 0 ? (
            <div className="alert info" style={{ display: "grid", gap: 6 }}>
              <span>Do número <b className="tnum">{code.phoneMasked}</b>, envie esta mensagem ao Luna no WhatsApp:</span>
              <div className="row">
                <code className="link-code">vincular {code.code}</code>
                <button className="btn btn-sm btn-ghost" aria-label="Copiar" onClick={() => copy(`vincular ${code.code}`, toast)}><Copy size={14} /></button>
              </div>
              <span className="faint" style={{ fontSize: 12.5 }}>Código pessoal, de uso único, só vale para esse número. Expira em {mmss(left)}. Não compartilhe.</span>
            </div>
          ) : (
            <form className="row wrap" style={{ alignItems: "end" }} onSubmit={(e) => { e.preventDefault(); gen.mutate(); }}>
              <label className="field" style={{ flex: "1 1 220px" }}>
                <span>{s.linked ? "Trocar de número" : "Seu número de WhatsApp"}</span>
                <input className="input" type="tel" inputMode="tel" autoComplete="tel" placeholder="+55 11 98765-4321" value={phone} maxLength={24} onChange={(e) => setPhone(e.target.value)} />
              </label>
              <button className="btn btn-primary" disabled={phone.replace(/\D/g, "").length < 10 || gen.isPending}><Link2 size={16} /> Gerar código</button>
            </form>
          )}

          <div className="row wrap between">
            <small className="faint" style={{ maxWidth: 520 }}>
              O PIN (6 a 8 dígitos) prova que é você quem está escrevendo: o WhatsApp sozinho não garante isso ao Luna. Ele é pedido ao abrir uma sessão no chat.
            </small>
            <button className="btn btn-sm" onClick={() => setPinOpen(true)}><KeyRound size={14} /> {s.pinSet ? "Trocar PIN" : "Definir PIN"}</button>
          </div>
        </>
      )}
      {pinOpen && (
        <Modal title={s?.pinSet ? "Trocar PIN do WhatsApp" : "Definir PIN do WhatsApp"} onClose={() => setPinOpen(false)} footer={<>
          <button className="btn" onClick={() => setPinOpen(false)}>Cancelar</button>
          <button className="btn btn-primary" disabled={!pinValid || savePin.isPending} onClick={() => savePin.mutate()}>Salvar PIN</button></>}>
          <p className="muted" style={{ margin: 0 }}>Use de 6 a 8 dígitos, sem sequências (123456) nem repetições (111111). Não use a senha do banco nem a do site.</p>
          <label className="field"><span>Novo PIN</span>
            <input className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={pin.pin} onChange={(e) => setPin({ ...pin, pin: e.target.value.replace(/\D/g, "").slice(0, 8) })} />
          </label>
          <label className="field"><span>Sua senha do Luna (para confirmar)</span>
            <input className="input" type="password" autoComplete="current-password" value={pin.password} onChange={(e) => setPin({ ...pin, password: e.target.value })} />
          </label>
          {savePin.error && <div className="alert bad" role="alert">{savePin.error.message}</div>}
        </Modal>
      )}
    </Section>
  );
}

// ============================== OpenBot (gestão) ==============================

interface Credential { id: number; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
interface OBMember {
  userId: number; name: string; relation: string | null; linked: boolean; phoneMasked: string | null; linkedVia: string | null;
  linkedAt: string | null; lastSeenAt: string | null; pinSet: boolean; pinLocked: boolean; activeSessions: number; authorized: boolean;
}
interface OBEvent { id: number; operation: string; outcome: "ok" | "denied" | "error"; status: number; errorCode: string | null; durationMs: number; createdAt: string; memberName: string | null }
interface Overview {
  settings: { enabled: boolean; autoConfirm: boolean; pinRequired: boolean; sessionHours: number; updatedAt: string };
  api: { enabled: boolean; activeCredentials: number; lastCallAt: string | null; lastSuccessAt: string | null; lastErrorAt: string | null; status: "disabled" | "no_credentials" | "waiting_first_call" | "ok" };
  whatsapp: { lastAuthenticatedActivityAt: string | null; linkedMembers: number; status: "no_evidence" | "recent_activity" | "no_recent_activity"; note: string };
  credentials: Credential[];
  members: OBMember[];
  events: OBEvent[];
  notifications: Record<string, number>;
}
interface SelfTest { ok: boolean; checks: Array<{ id: string; ok: boolean; message: string }>; whatsapp: string }

const API_STATUS: Record<Overview["api"]["status"], [string, string]> = {
  disabled: ["Desligada", ""],
  no_credentials: ["Sem credencial", "warn"],
  waiting_first_call: ["Aguardando o OpenBot", "warn"],
  ok: ["Recebendo chamadas", "ok"],
};
const WA_STATUS: Record<Overview["whatsapp"]["status"], [string, string]> = {
  no_evidence: ["Sem evidência ainda", ""],
  recent_activity: ["Atividade nas últimas 24 h", "ok"],
  no_recent_activity: ["Sem atividade recente", "warn"],
};
const SCOPE_LABEL: Record<string, string> = { link: "Vincular números", read: "Consultar", write: "Registrar (com confirmação)", notifications: "Avisos" };
const QUEUE_LABEL: Record<string, string> = { pending: "Na fila", claimed: "Em entrega", sent: "Entregues", failed: "Falharam", cancelled: "Cancelados" };

export function OpenBotSection() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const ov = useQuery({ queryKey: ["openbot"], queryFn: () => get<Overview>("/integrations/openbot"), refetchInterval: 30_000 });
  const [newCred, setNewCred] = useState<{ name: string; scopes: string[] } | null>(null);
  const [createdKey, setCreatedKey] = useState<{ name: string; key: string } | null>(null);
  const [linkFor, setLinkFor] = useState<{ member: OBMember; phone: string } | null>(null);
  const [test, setTest] = useState<SelfTest | null>(null);
  const [allEvents, setAllEvents] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["openbot"] });
    qc.invalidateQueries({ queryKey: ["me-whatsapp"] });
  };
  const onError = (e: Error) => toast(e.message, "error");

  const settings = useMutation({
    mutationFn: (body: Partial<Overview["settings"]>) => patch("/integrations/openbot/settings", body),
    onSuccess: () => { refresh(); toast("Integração atualizada"); },
    onError,
  });
  const create = useMutation({
    mutationFn: () => post<{ name: string; key: string }>("/integrations/openbot/credentials", newCred),
    onSuccess: (r) => { refresh(); setNewCred(null); setCreatedKey({ name: r.name, key: r.key }); },
    onError,
  });
  const revoke = useMutation({
    mutationFn: (id: number) => del(`/integrations/openbot/credentials/${id}`),
    onSuccess: () => { refresh(); toast("Credencial revogada. O OpenBot perde o acesso na hora."); },
    onError,
  });
  const link = useMutation({
    mutationFn: () => post<{ phoneMasked: string }>(`/integrations/openbot/members/${linkFor!.member.userId}/link`, { phone: linkFor!.phone }),
    onSuccess: (r) => { refresh(); toast(`Número ${r.phoneMasked} vinculado a ${firstName(linkFor!.member.name)}`); setLinkFor(null); },
  });
  const memberAction = useMutation({
    mutationFn: ({ id, what }: { id: number; what: "link" | "sessions" | "pin" }) => del<{ revoked?: number }>(`/integrations/openbot/members/${id}/${what}`),
    onSuccess: (_r, v) => { refresh(); toast(v.what === "link" ? "Número desvinculado" : v.what === "pin" ? "PIN apagado — a pessoa define outro no site" : "Sessões encerradas"); },
    onError,
  });
  const runTest = useMutation({ mutationFn: () => post<SelfTest>("/integrations/openbot/test"), onSuccess: setTest, onError });

  if (ov.isError) return <Section id="openbot" title="OpenBot"><div className="alert bad">{ov.error.message}</div></Section>;
  const d = ov.data;
  const switches: Array<[keyof Overview["settings"], string, string]> = [
    ["enabled", "Integração ligada", "Desligar derruba todas as sessões na hora; o OpenBot passa a receber erro 503."],
    ["pinRequired", "Exigir PIN", "Recomendado. Sem PIN, qualquer texto que convença o agente a informar outro número poderia agir em nome dessa pessoa."],
    ["autoConfirm", "Gravar sem pedir confirmação", "Só para lançamentos simples sem alertas. Correções, exclusões e pagamento de fatura sempre pedem confirmação."],
  ];
  const events = d ? (allEvents ? d.events : d.events.slice(0, 8)) : [];
  return (
    <Section id="openbot" title="OpenBot" desc="Agente externo que atende a família pelo WhatsApp e conversa com o Luna pela API.">
      {!d ? <Skeleton h={120} /> : (
        <>
          <div className="grid grid-2">
            <div className="integration-status stack">
              <span className="eyebrow">API do Luna</span>
              <div><span className={`chip ${API_STATUS[d.api.status][1]}`}>{API_STATUS[d.api.status][0]}</span></div>
              <small className="faint">
                {d.api.activeCredentials} credencial(is) ativa(s) · última chamada: {when(d.api.lastCallAt)}
                {d.api.lastErrorAt && <> · último erro: {when(d.api.lastErrorAt)}</>}
              </small>
            </div>
            <div className="integration-status stack">
              <span className="eyebrow">WhatsApp</span>
              <div><span className={`chip ${WA_STATUS[d.whatsapp.status][1]}`}>{WA_STATUS[d.whatsapp.status][0]}</span></div>
              <small className="faint">
                {d.whatsapp.linkedMembers} número(s) vinculado(s) · última mensagem autenticada: {when(d.whatsapp.lastAuthenticatedActivityAt)}
              </small>
            </div>
          </div>
          <small className="faint">{d.whatsapp.note}</small>

          <div>
            {switches.map(([key, label, desc]) => (
              <label className="switch-row" key={key}>
                <span className="switch-text"><b>{label}</b><small>{desc}</small></span>
                <input
                  type="checkbox" role="switch" className="switch" checked={Boolean(d.settings[key])} disabled={settings.isPending}
                  onChange={(e) => {
                    const v = e.target.checked;
                    if (key === "pinRequired" && !v && !window.confirm("Desligar o PIN reduz bastante a segurança. Continuar?")) return;
                    if (key === "enabled" && !v && !window.confirm("Desligar a integração encerra todas as sessões do WhatsApp agora. Continuar?")) return;
                    settings.mutate({ [key]: v });
                  }}
                />
              </label>
            ))}
            <label className="switch-row">
              <span className="switch-text"><b>Duração da sessão</b><small>Depois disso, a pessoa informa o PIN de novo no chat.</small></span>
              <select className="select select-inline" aria-label="Duração da sessão" value={d.settings.sessionHours} onChange={(e) => settings.mutate({ sessionHours: Number(e.target.value) })}>
                {Array.from(new Set([1, 4, 8, 12, 24, 48, 72, d.settings.sessionHours])).sort((a, b) => a - b).map((h) => <option key={h} value={h}>{h} h</option>)}
              </select>
            </label>
          </div>

          <div>
            <p className="eyebrow" style={{ margin: "4px 0 6px" }}>Credenciais do OpenBot</p>
            {d.credentials.length === 0 ? <p className="faint" style={{ margin: 0, fontSize: 13 }}>Nenhuma credencial. Crie uma e cole no OpenBot (veja integrations/openbot/SETUP.md).</p> : (
              <div className="list">
                {d.credentials.map((c) => (
                  <div className="list-item no-icon" key={c.id} style={{ opacity: c.revokedAt ? 0.55 : 1 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="title">{c.name} <code className="faint">lfo_{c.prefix}_…</code> {c.revokedAt && <span className="chip bad">Revogada</span>}</div>
                      <div className="sub">{c.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(" · ")} · criada {when(c.createdAt)} · último uso {when(c.lastUsedAt)}</div>
                    </div>
                    {!c.revokedAt && (
                      <button className="btn btn-sm btn-ghost btn-danger" onClick={() => window.confirm(`Revogar "${c.name}"? O OpenBot deixa de acessar o Luna com esta chave.`) && revoke.mutate(c.id)}>
                        <Trash2 size={14} /> Revogar
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 8 }}><button className="btn btn-sm" onClick={() => setNewCred({ name: "OpenBot", scopes: ["link", "read", "write", "notifications"] })}><Plus size={14} /> Nova credencial</button></div>
          </div>

          <div>
            <p className="eyebrow" style={{ margin: "4px 0 6px" }}>Pessoas no WhatsApp</p>
            <div className="list">
              {d.members.map((m) => (
                <div className="list-item no-icon ob-member" key={m.userId}>
                  <div style={{ minWidth: 0 }}>
                    <div className="title">{m.name}{m.relation && <span className="faint" style={{ fontWeight: 400 }}> · {m.relation}</span>}</div>
                    <div className="sub">
                      {m.linked ? <span className="tnum">{m.phoneMasked}</span> : <span>Sem número</span>}
                      {m.linked && (m.authorized ? <span className="chip ok">Autorizado</span> : <span className="chip warn">Falta PIN</span>)}
                      {m.pinSet && <span className="chip">PIN</span>}
                      {m.pinLocked && <span className="chip bad">PIN bloqueado</span>}
                      {m.activeSessions > 0 && <span className="chip primary">{m.activeSessions} sessão(ões)</span>}
                      {m.lastSeenAt && <span className="faint">última: {when(m.lastSeenAt)}</span>}
                    </div>
                  </div>
                  <div className="member-actions">
                    <button className="btn btn-sm" onClick={() => setLinkFor({ member: m, phone: "" })}><Link2 size={14} /> {m.linked ? "Trocar número" : "Vincular número"}</button>
                    {m.activeSessions > 0 && <button className="btn btn-sm btn-ghost" onClick={() => memberAction.mutate({ id: m.userId, what: "sessions" })}>Encerrar sessões</button>}
                    {(m.pinSet || m.pinLocked) && <button className="btn btn-sm btn-ghost" onClick={() => window.confirm(`Apagar o PIN de ${firstName(m.name)}? Ela precisará definir outro no site.`) && memberAction.mutate({ id: m.userId, what: "pin" })}>Resetar PIN</button>}
                    {m.linked && <button className="btn btn-sm btn-ghost btn-danger" onClick={() => window.confirm(`Desvincular o WhatsApp de ${firstName(m.name)}?`) && memberAction.mutate({ id: m.userId, what: "link" })}><Unlink size={14} /> Desvincular</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="row wrap between">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="eyebrow" style={{ margin: 0 }}>Avisos para o WhatsApp</span>
              {Object.keys(d.notifications).length === 0 ? <span className="faint" style={{ fontSize: 13 }}>fila vazia</span> :
                Object.entries(d.notifications).map(([k, n]) => <span key={k} className={`chip ${k === "failed" ? "bad" : k === "sent" ? "ok" : ""}`}>{QUEUE_LABEL[k] ?? k}: {n}</span>)}
            </div>
            <button className="btn btn-sm" disabled={runTest.isPending} onClick={() => runTest.mutate()}><ShieldCheck size={14} /> Testar integração</button>
          </div>
          {test && (
            <div className={`alert ${test.ok ? "ok" : "info"}`} style={{ display: "grid", gap: 4 }}>
              {test.checks.map((c) => <span key={c.id}>{c.ok ? "✅" : "⚠️"} {c.message}</span>)}
              <span className="faint" style={{ fontSize: 12.5 }}>{test.whatsapp}</span>
            </div>
          )}

          <div>
            <p className="eyebrow" style={{ margin: "4px 0 6px" }}>Últimas chamadas do OpenBot</p>
            {events.length === 0 ? <p className="faint" style={{ margin: 0, fontSize: 13 }}>Nenhuma chamada registrada ainda.</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Quando</th><th>Operação</th><th>Pessoa</th><th>Resultado</th><th className="num">Tempo</th></tr></thead>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.id}>
                        <td className="tnum">{when(e.createdAt)}</td>
                        <td><code>{e.operation}</code></td>
                        <td>{e.memberName ? firstName(e.memberName) : "—"}</td>
                        <td><span className={`chip ${e.outcome === "ok" ? "ok" : e.outcome === "denied" ? "warn" : "bad"}`}>{e.status}{e.errorCode ? ` · ${e.errorCode}` : ""}</span></td>
                        <td className="num tnum">{e.durationMs} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.events.length > 8 && <button className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} onClick={() => setAllEvents(!allEvents)}>{allEvents ? "Mostrar menos" : `Ver todas (${d.events.length})`}</button>}
          </div>
        </>
      )}

      {newCred && (
        <Modal title="Nova credencial do OpenBot" onClose={() => setNewCred(null)} footer={<>
          <button className="btn" onClick={() => setNewCred(null)}>Cancelar</button>
          <button className="btn btn-primary" disabled={!newCred.name.trim() || !newCred.scopes.length || create.isPending} onClick={() => create.mutate()}>Criar</button></>}>
          <label className="field"><span>Nome</span><input className="input" maxLength={60} value={newCred.name} onChange={(e) => setNewCred({ ...newCred, name: e.target.value })} /></label>
          <div className="field"><span>Permissões</span>
            {Object.entries(SCOPE_LABEL).map(([k, label]) => (
              <label className="row" key={k} style={{ gap: 8 }}>
                <input type="checkbox" checked={newCred.scopes.includes(k)} onChange={(e) => setNewCred({ ...newCred, scopes: e.target.checked ? [...newCred.scopes, k] : newCred.scopes.filter((s) => s !== k) })} />
                {label}
              </label>
            ))}
          </div>
        </Modal>
      )}
      {createdKey && (
        <Modal title={`Chave "${createdKey.name}"`} onClose={() => setCreatedKey(null)}>
          <div className="alert bad" role="alert" style={{ margin: 0 }}>Esta chave aparece só agora. O Luna guarda apenas uma impressão dela; se perder, revogue e crie outra.</div>
          <input className="input" readOnly value={createdKey.key} onFocus={(e) => e.currentTarget.select()} aria-label="Chave da credencial" />
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Cole no OpenBot como <code>LUNA_API_KEY</code> (cabeçalho <code>Authorization: Bearer …</code>). Não envie por WhatsApp nem e-mail.</p>
          <button className="btn btn-primary" onClick={() => copy(createdKey.key, toast, "Chave copiada")}><Copy size={15} /> Copiar chave</button>
        </Modal>
      )}
      {linkFor && (
        <Modal title={`WhatsApp de ${firstName(linkFor.member.name)}`} onClose={() => setLinkFor(null)} footer={<>
          <button className="btn" onClick={() => setLinkFor(null)}>Cancelar</button>
          <button className="btn btn-primary" disabled={linkFor.phone.replace(/\D/g, "").length < 10 || link.isPending} onClick={() => link.mutate()}>Vincular</button></>}>
          <p className="muted" style={{ margin: 0 }}>Confirme o número com a própria pessoa. O ideal é ela mesma vincular em "Seu WhatsApp", com código.</p>
          <label className="field"><span>Número (formato internacional)</span>
            <input className="input" type="tel" inputMode="tel" placeholder="+55 11 98765-4321" maxLength={24} value={linkFor.phone} onChange={(e) => setLinkFor({ ...linkFor, phone: e.target.value })} />
          </label>
          {link.error && <div className="alert bad" role="alert">{link.error.message}</div>}
        </Modal>
      )}
    </Section>
  );
}

// ============================== Cartões e fatura ==============================

interface CardSettings { productName: string; holderUserId: number | null; closingDay: number | null; dueDay: number | null; limitCents: number | null; cycleConfigured: boolean }

export function CardsSettingsSection() {
  const { toast } = useApp();
  const qc = useQueryClient();
  const { data: members } = useMembers();
  const cards = useQuery({ queryKey: ["cards", "settings"], queryFn: () => get<{ settings: CardSettings }>("/cards") });
  const [form, setForm] = useState<{ holderUserId: string; closingDay: string; dueDay: string; limit: string } | null>(null);
  const s = cards.data?.settings;
  useEffect(() => {
    if (s) setForm({ holderUserId: s.holderUserId ? String(s.holderUserId) : "", closingDay: s.closingDay ? String(s.closingDay) : "", dueDay: s.dueDay ? String(s.dueDay) : "", limit: s.limitCents ? centsToInput(s.limitCents) : "" });
  }, [s]);
  const save = useMutation({
    mutationFn: () => {
      const day = (v: string) => (v ? Number(v) : null);
      const limitCents = form!.limit.trim() ? parseCents(form!.limit) : null;
      if (form!.limit.trim() && (!limitCents || limitCents <= 0)) throw new Error("Limite inválido.");
      return patch<CardSettings>("/cards/settings", { holderUserId: form!.holderUserId ? Number(form!.holderUserId) : null, closingDay: day(form!.closingDay), dueDay: day(form!.dueDay), limitCents });
    },
    onSuccess: () => {
      for (const k of ["cards", "wallet", "dashboard"]) qc.invalidateQueries({ queryKey: [k] });
      toast("Cartão atualizado");
    },
    onError: (e) => toast(e.message, "error"),
  });
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  return (
    <Section id="cartoes" title="Cartões e fatura" desc="Cartão da família: titular, fechamento e vencimento da fatura. Usado no painel e nas consultas pelo WhatsApp.">
      {!form || !s ? <Skeleton h={80} /> : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="faint" style={{ fontSize: 13 }}>{s.productName}{!s.cycleConfigured && <> · <span className="chip warn">Ciclo não cadastrado</span></>}</div>
          <div className="grid grid-2">
            <label className="field"><span>Titular</span>
              <select className="select" value={form.holderUserId} onChange={(e) => setForm({ ...form, holderUserId: e.target.value })}>
                <option value="">— escolha —</option>
                {members?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Limite total</span>
              <div className="money-input"><span className="prefix">R$</span><input className="input" inputMode="decimal" placeholder="opcional" value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} /></div>
            </label>
            <label className="field"><span>Dia do fechamento</span>
              <select className="select" value={form.closingDay} onChange={(e) => setForm({ ...form, closingDay: e.target.value })}>
                <option value="">—</option>{days.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="field"><span>Dia do vencimento</span>
              <select className="select" value={form.dueDay} onChange={(e) => setForm({ ...form, dueDay: e.target.value })}>
                <option value="">—</option>{days.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <small className="faint">Compras feitas a partir do dia do fechamento entram na fatura do mês seguinte. Pagar a fatura não cria despesa nova (as compras já foram lançadas).</small>
          <div><button className="btn" disabled={save.isPending}>Salvar</button></div>
        </form>
      )}
    </Section>
  );
}

// ============================== Orçamentos ==============================

interface Budget {
  id: number; scope: "individual" | "family"; ownerId: number | null; categoryId: number | null; categoryName: string | null;
  amountCents: number; month: string; spentCents: number; remainingCents: number; percent: number; level: "ok" | "70" | "90" | "100";
}
const LEVEL_COLOR: Record<Budget["level"], string> = { ok: "var(--primary)", "70": "var(--warn, #eda100)", "90": "var(--warn, #eb6834)", "100": "var(--bad, #e5484d)" };

export function BudgetsSection({ me }: { me: Me }) {
  const { toast } = useApp();
  const qc = useQueryClient();
  const member = useMemberLookup();
  const { data: categories } = useCategories();
  const list = useQuery({ queryKey: ["budgets"], queryFn: () => get<Budget[]>("/budgets") });
  const [form, setForm] = useState<{ scope: "individual" | "family"; categoryId: string; amount: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["budgets"] });
  const save = useMutation({
    mutationFn: () => {
      const cents = parseCents(form!.amount);
      if (!cents || cents <= 0) throw new Error("Informe o valor do orçamento.");
      return post("/budgets", { scope: form!.scope, categoryId: form!.categoryId ? Number(form!.categoryId) : null, amountCents: cents });
    },
    onSuccess: () => { refresh(); setForm(null); toast("Orçamento salvo"); },
    onError: (e) => toast(e.message, "error"),
  });
  const remove = useMutation({
    mutationFn: (id: number) => del(`/budgets/${id}`),
    onSuccess: () => { refresh(); toast("Orçamento removido"); },
    onError: (e) => toast(e.message, "error"),
  });
  const manage = me.capabilities.manageMembers;
  const canRemove = (b: Budget) => (b.scope === "family" ? manage : b.ownerId === me.id);
  const label = (b: Budget) => `${b.categoryName ?? "Todas as despesas"} · ${b.scope === "family" ? "Família" : b.ownerId === me.id ? "Você" : firstName(member(b.ownerId!)?.name ?? "—")}`;
  return (
    <Section id="orcamentos" title="Orçamentos" desc="Limite mensal de gastos, geral ou por categoria. Avisos em 70%, 90% e 100% (no WhatsApp, quando vinculado).">
      {!list.data ? <Skeleton h={60} /> : list.data.length === 0 ? <p className="faint" style={{ margin: 0, fontSize: 13 }}>Nenhum orçamento ainda.</p> : (
        <div className="list">
          <p className="eyebrow" style={{ margin: "0 0 2px" }}>{monthLong(list.data[0].month)}</p>
          {list.data.map((b) => (
            <div className="list-item no-icon budget-row" key={b.id}>
              <div className="row between">
                <div style={{ minWidth: 0 }}>
                  <div className="title ellipsis">{label(b)}</div>
                  <div className="sub tnum">{money(b.spentCents)} de {money(b.amountCents)} · {b.remainingCents >= 0 ? `restam ${money(b.remainingCents)}` : `${money(-b.remainingCents)} acima`}</div>
                </div>
                <div className="row">
                  <b className="num tnum">{Math.round(b.percent)}%</b>
                  {canRemove(b) && <button className="btn btn-ghost icon-btn" aria-label={`Remover orçamento ${label(b)}`} onClick={() => window.confirm("Remover este orçamento?") && remove.mutate(b.id)}><Trash2 size={14} /></button>}
                </div>
              </div>
              <div className="progress" role="progressbar" aria-label={`Uso do orçamento ${label(b)}`} aria-valuenow={Math.min(100, Math.round(b.percent))} aria-valuetext={`${Math.round(b.percent)}% usado`} aria-valuemin={0} aria-valuemax={100}>
                <i style={{ width: `${Math.min(100, b.percent)}%`, ["--c" as string]: LEVEL_COLOR[b.level] }} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div><button className="btn btn-sm" onClick={() => setForm({ scope: "individual", categoryId: "", amount: "" })}><Plus size={14} /> Novo orçamento</button></div>
      {form && (
        <Modal title="Novo orçamento" onClose={() => setForm(null)} footer={<>
          <button className="btn" onClick={() => setForm(null)}>Cancelar</button>
          <button className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Salvar</button></>}>
          {manage && (
            <div className="segmented fill" role="group" aria-label="De quem">
              <button type="button" aria-pressed={form.scope === "individual"} onClick={() => setForm({ ...form, scope: "individual" })}>Só meu</button>
              <button type="button" aria-pressed={form.scope === "family"} onClick={() => setForm({ ...form, scope: "family" })}>Da família</button>
            </div>
          )}
          <label className="field"><span>Categoria</span>
            <select className="select" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">Todas as despesas</option>
              {categories?.filter((c) => c.kind === "expense").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Limite por mês</span>
            <div className="money-input"><span className="prefix">R$</span><input className="input" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
          </label>
          <small className="faint">Se já existir um orçamento para a mesma categoria, o valor é atualizado.</small>
        </Modal>
      )}
    </Section>
  );
}
