import { Suspense } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, CalendarClock, LayoutDashboard, LogOut, Moon, Plus, ReceiptText, Settings, Sun, Target } from "lucide-react";
import { get, post } from "../lib/api";
import { useApp, useMe } from "../lib/app";
import { firstName, memberColor } from "../lib/format";
import { Avatar } from "./ui";
import { TransactionForm } from "./TransactionForm";

export function LunaMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="18" fill="var(--accent)" />
      <path d="M40 14a20 20 0 1 0 10 34A16 16 0 0 1 40 14z" fill="var(--accent-ink)" />
      <circle cx="46" cy="20" r="2.4" fill="var(--brass)" />
    </svg>
  );
}

const NAV = [
  { to: "/", label: "Painel", short: "Painel", icon: LayoutDashboard, end: true },
  { to: "/movimentacoes", label: "Movimentações", short: "Lançar", icon: ReceiptText },
  { to: "/contas", label: "Contas a pagar", short: "Contas", icon: CalendarClock },
  { to: "/metas", label: "Metas", short: "Metas", icon: Target },
  { to: "/relatorios", label: "Relatórios", short: "Relatórios", icon: BarChart3 },
];

export function Layout() {
  const { data: me } = useMe();
  const { dark, setTheme, newTxPreset, openNewTransaction, closeNewTransaction } = useApp();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // contador discreto de contas atrasadas (só as próprias)
  const { data: bills } = useQuery({ queryKey: ["bills", "me", "badge"], queryFn: () => get<{ overdue: unknown[] }>("/bills?view=me"), staleTime: 60_000 });
  const overdue = bills?.overdue.length ?? 0;

  const logout = useMutation({
    mutationFn: () => post("/auth/logout"),
    onSettled: () => {
      qc.clear();
      navigate("/entrar", { replace: true });
    },
  });

  const color = me ? memberColor(me.color, dark) : "var(--viz-1)";

  return (
    <div className="shell">
      <aside className="sidebar">
        <NavLink to="/" className="brand">
          <LunaMark />
          <span className="brand-name">
            Luna <em>Finance</em>
          </span>
        </NavLink>
        <button className="btn btn-primary" onClick={() => openNewTransaction()}>
          <Plus size={17} /> Nova movimentação
        </button>
        <nav className="nav" aria-label="Principal">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <n.icon size={18} strokeWidth={1.8} />
              {n.label}
              {n.to === "/contas" && overdue > 0 && <span className="nav-badge" aria-label={`${overdue} atrasadas`}>{overdue}</span>}
            </NavLink>
          ))}
          <NavLink to="/configuracoes">
            <Settings size={18} strokeWidth={1.8} />
            Configurações
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          {me && (
            <div className="row" style={{ padding: "0 8px" }}>
              <Avatar name={me.name} color={color} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{me.name}</div>
                <div className="faint" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{me.email}</div>
              </div>
              <button className="btn btn-ghost icon-btn" aria-label={dark ? "Usar tema claro" : "Usar tema escuro"} onClick={() => setTheme(dark ? "light" : "dark")}>
                {dark ? <Sun size={17} /> : <Moon size={17} />}
              </button>
              <button className="btn btn-ghost icon-btn" aria-label="Sair" onClick={() => logout.mutate()}>
                <LogOut size={17} />
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="content">
        <header className="mobile-top">
          <NavLink to="/" className="brand" style={{ padding: 0 }}>
            <LunaMark size={28} />
            <span className="brand-name" style={{ fontSize: 19 }}>
              Luna <em>Finance</em>
            </span>
          </NavLink>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn btn-ghost icon-btn" aria-label={dark ? "Usar tema claro" : "Usar tema escuro"} onClick={() => setTheme(dark ? "light" : "dark")}>
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <NavLink to="/configuracoes" aria-label="Configurações" className="btn btn-ghost icon-btn">
              {me ? <Avatar name={me.name} color={color} size="sm" /> : <Settings size={18} />}
            </NavLink>
          </div>
        </header>
        <main className="main" id="conteudo">
          <Suspense fallback={<div className="skeleton" style={{ height: 240 }} />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <nav className="tabbar" aria-label="Navegação">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <n.icon size={20} strokeWidth={1.8} />
            {n.short}
          </NavLink>
        ))}
      </nav>
      <button className="fab" aria-label="Nova movimentação" onClick={() => openNewTransaction()}>
        <Plus size={24} />
      </button>

      {newTxPreset && <TransactionForm preset={newTxPreset} onClose={closeNewTransaction} />}
      {me && <span className="sr-only">Conectado como {firstName(me.name)}</span>}
    </div>
  );
}
