import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api";
import { LunaMark } from "../components/Layout";

function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <section className="auth-art" aria-hidden>
        <div className="row">
          <LunaMark size={34} />
          <span className="brand-name" style={{ color: "#eee6d2" }}>
            Luna <em style={{ color: "#d9b36c" }}>Finance</em>
          </span>
        </div>
        <div className="moon" />
        <blockquote>
          As finanças da casa, <em>em ordem</em> e à vista de quem importa.
        </blockquote>
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
        <div>
          <p className="eyebrow">Acesso da família</p>
          <h1>Bem-vindo de volta</h1>
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
            {login.error.message}
          </div>
        )}
        <button className="btn btn-primary" style={{ height: 46 }} disabled={login.isPending}>
          {login.isPending ? "Entrando…" : "Entrar"}
        </button>
        <p className="faint" style={{ fontSize: 13, margin: 0 }}>
          Esqueceu a senha? Peça um novo link de acesso para a família — ele chega só para você.
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
        {!token || info.error ? (
          <>
            <h1>Link inválido</h1>
            <div className="alert bad">{info.error?.message ?? "Este link de acesso está incompleto."}</div>
          </>
        ) : (
          <>
            <div>
              <p className="eyebrow">{info.data?.purpose === "reset" ? "Nova senha" : "Primeiro acesso"}</p>
              <h1>{info.data ? `Olá, ${info.data.name}` : "Olá"}</h1>
              <p className="muted">Crie uma senha pessoal. Ela é só sua — ninguém da família consegue vê-la.</p>
            </div>
            <label className="field">
              <span>Nova senha</span>
              <input className="input" type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
              <small>Mínimo de 10 caracteres, com letras e números.</small>
            </label>
            <label className="field">
              <span>Confirme a senha</span>
              <input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {save.error && (
              <div className="alert bad" role="alert">
                {save.error.message}
              </div>
            )}
            <button className="btn btn-primary" style={{ height: 46 }} disabled={save.isPending || !info.data}>
              {save.isPending ? "Salvando…" : "Salvar e entrar"}
            </button>
          </>
        )}
      </form>
    </AuthFrame>
  );
}
