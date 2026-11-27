import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Lock, ShieldCheck } from "lucide-react";
import { post } from "../lib/api";
import { LunaMark } from "../components/Layout";

function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <section className="auth-art" aria-hidden>
        <div className="row" style={{ gap: 12 }}>
          <LunaMark size={36} />
          <span className="brand-name">
            Luna <span>Finance</span>
          </span>
        </div>
        <svg className="auth-moon" viewBox="0 0 600 600">
          <defs>
            <radialGradient id="authGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#c48aff" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#c48aff" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="300" cy="300" r="290" fill="url(#authGlow)" />
          <circle cx="300" cy="300" r="250" fill="none" stroke="#c48aff" strokeOpacity="0.1" />
          <circle cx="300" cy="300" r="190" fill="none" stroke="#c48aff" strokeOpacity="0.14" />
          <image href="/brand/logo-512.webp" x="125" y="125" width="350" height="350" />
        </svg>
        <div className="auth-copy">
          <p className="eyebrow">Finanças da família</p>
          <p className="auth-quote">
            O dinheiro da casa, <span>claro como a lua cheia</span> — para quem divide a mesma rotina.
          </p>
        </div>
      </section>
      <section className="auth-form">{children}</section>
    </div>
  );
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const login = useMutation({
    mutationFn: () => post("/auth/login", { email, password }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate(loc.state?.from && loc.state.from !== "/entrar" ? loc.state.from : "/", { replace: true });
    },
  });
  return (
    <AuthFrame>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <div className="auth-mobile-brand">
          <LunaMark size={34} />
        </div>
        <div className="auth-head">
          <p className="eyebrow">Acesso da família</p>
          <h1>Bem-vindo de volta</h1>
          <p className="muted">Entre com o seu e-mail e a sua senha pessoal.</p>
        </div>
        <label className="field">
          <span>E-mail</span>
          <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Senha</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {login.error && (
          <div className="alert bad" role="alert">
            <AlertTriangle size={16} aria-hidden />
            {login.error.message}
          </div>
        )}
        <button className="btn btn-primary btn-lg" disabled={login.isPending}>
          {login.isPending ? "Entrando…" : "Entrar"}
          {!login.isPending && <ArrowRight size={16} aria-hidden />}
        </button>
        <p className="auth-note">
          <Lock size={14} aria-hidden /> Esqueceu a senha? Peça um novo link de acesso para a família — ele chega só para você.
        </p>
      </form>
    </AuthFrame>
  );
}

export function SetPasswordPage() {
  // o token vem no fragmento (#t=...) — nunca é enviado em logs de servidor/referrer
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get("t") ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
  }, []);
  const info = useQuery({ queryKey: ["access-link"], queryFn: () => post<{ name: string; purpose: string }>("/auth/access-link/inspect", { token }), enabled: Boolean(token), retry: false });
  const save = useMutation({
    mutationFn: () => {
      if (password !== confirm) throw new Error("As senhas não coincidem.");
      return post("/auth/access-link/consume", { token, password });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      navigate("/", { replace: true });
    },
  });
  return (
    <AuthFrame>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="auth-mobile-brand">
          <LunaMark size={34} />
        </div>
        {!token || info.error ? (
          <>
            <div className="auth-head">
              <p className="eyebrow">Link de acesso</p>
              <h1>Link inválido</h1>
            </div>
            <div className="alert bad" role="alert">
              <AlertTriangle size={16} aria-hidden />
              {info.error?.message ?? "Este link de acesso está incompleto."}
            </div>
            <p className="auth-note">Peça um novo link para a família. Cada link é pessoal, de uso único e expira em pouco tempo.</p>
          </>
        ) : (
          <>
            <div className="auth-head">
              <p className="eyebrow">{info.data?.purpose === "reset" ? "Nova senha" : "Primeiro acesso"}</p>
              <h1>{info.data ? `Olá, ${info.data.name}` : "Olá"}</h1>
              <p className="muted">Crie uma senha pessoal. Ela é só sua — ninguém da família consegue vê-la.</p>
            </div>
            {info.isLoading && <div className="skeleton" style={{ height: 12, width: "60%" }} aria-hidden />}
            <label className="field">
              <span>Nova senha</span>
              <input className="input" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
              <small>Mínimo de 10 caracteres, com letras e números.</small>
            </label>
            <label className="field">
              <span>Confirme a senha</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                aria-invalid={confirm.length > 0 && confirm !== password}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            {save.error && (
              <div className="alert bad" role="alert">
                <AlertTriangle size={16} aria-hidden />
                {save.error.message}
              </div>
            )}
            <button className="btn btn-primary btn-lg" disabled={save.isPending || !info.data}>
              {save.isPending ? "Salvando…" : "Salvar e entrar"}
            </button>
            <p className="auth-note">
              <ShieldCheck size={14} aria-hidden /> Depois de salvar, este link deixa de funcionar.
            </p>
          </>
        )}
      </form>
    </AuthFrame>
  );
}
