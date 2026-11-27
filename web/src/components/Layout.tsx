import { Suspense, useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3, CalendarClock, ChevronDown, ChevronRight, LayoutDashboard, LogOut, Moon, PanelLeftClose, PanelLeftOpen, Plus,
  ReceiptText, Settings, Sun, Target,
} from "lucide-react";
import { get, post } from "../lib/api";
import { useApp, useLiveSync, useMe, useMemberLookup } from "../lib/app";
import { firstName, memberColor } from "../lib/format";
import type { Me } from "../lib/types";
import { Avatar } from "./ui";
import { TransactionForm } from "./TransactionForm";

/** Marca: crescente lunar recortado num quadrado lavanda. */
/** Logo do Luna Finance (arquivos em web/public/brand). Decorativa: o texto ao lado já nomeia. */
export function LunaMark({ size = 30 }: { size?: number }) {
  return <img className="brand-logo" src="/brand/logo-160.webp" width={size} height={size} alt="" aria-hidden draggable={false} />;
}

const NAV = [
  { to: "/", label: "Painel", short: "Painel", icon: LayoutDashboard, end: true },
  { to: "/movimentacoes", label: "Movimentações", short: "Lançar", icon: ReceiptText },
  { to: "/contas", label: "Contas a pagar", short: "Contas", icon: CalendarClock },
  { to: "/metas", label: "Metas", short: "Metas", icon: Target },
  { to: "/relatorios", label: "Relatórios", short: "Relatórios", icon: BarChart3 },
];

const TITLES: Record<string, string> = {
  "/": "Painel",
  "/movimentacoes": "Movimentações",
  "/contas": "Contas a pagar",
  "/metas": "Metas",
  "/relatorios": "Relatórios",
  "/configuracoes": "Configurações",
};
/** Páginas em que a visão (eu/família/pessoa) muda o conteúdo. */
const VIEW_PAGES = new Set(["/", "/movimentacoes", "/contas", "/relatorios"]);

function readCollapsed() {
  try {
    return localStorage.getItem("luna.sidebar") === "collapsed";
  } catch {
    return false;
  }
}
function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem("luna.sidebar", v ? "collapsed" : "expanded");
  } catch {
    /* modo privado */
  }
}

function UserMenu({ me, color, onLogout }: { me: Me; color: string; onLogout(): void }) {
  const { dark, setTheme } = useApp();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const next = e.key === "ArrowDown" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next]?.focus();
      }
      if (e.key === "Tab") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={trigger}
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Menu de ${firstName(me.name)}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar name={me.name} color={color} />
        <span className="hide-mobile">{firstName(me.name)}</span>
        <ChevronDown size={15} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu" id={menuId} aria-label="Conta">
          <div className="menu-head">
            <Avatar name={me.name} color={color} />
            <div>
              <b>{me.name}</b>
              <small>{me.email}</small>
            </div>
          </div>
          <Link role="menuitem" to="/configuracoes" onClick={() => setOpen(false)}>
            <Settings size={16} aria-hidden /> Configurações
          </Link>
          <button role="menuitem" onClick={() => setTheme(dark ? "light" : "dark")}>
            {dark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />} {dark ? "Usar tema claro" : "Usar tema escuro"}
          </button>
          <hr />
          <button role="menuitem" className="danger" onClick={onLogout}>
            <LogOut size={16} aria-hidden /> Sair
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { data: me } = useMe();
  useLiveSync(); // lançamentos feitos pelo WhatsApp/Telegram aparecem sem recarregar
  const { dark, setTheme, view, newTxPreset, openNewTransaction, closeNewTransaction } = useApp();
  const lookup = useMemberLookup();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
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

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  const color = me ? memberColor(me.color, dark) : "var(--primary)";
  const title = TITLES[pathname] ?? "Luna Finance";
  const viewLabel = view === "me" ? "Visão individual" : view === "family" ? "Visão da família" : `Visão de ${firstName(lookup(view)?.name ?? "integrante")}`;

  return (
    <div className={`shell ${collapsed ? "is-collapsed" : ""}`}>
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="Luna Finance — painel">
          <LunaMark size={32} />
          <span className="brand-name">
            Luna <span>Finance</span>
          </span>
        </NavLink>
        <button className="btn btn-primary" data-tip="Nova movimentação" onClick={() => openNewTransaction()}>
          <Plus size={17} aria-hidden /> <span className="nav-label">Nova movimentação</span>
        </button>
        <nav className="nav" aria-label="Principal">
          <p className="nav-title">Menu</p>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} data-tip={n.label}>
              <n.icon size={18} strokeWidth={1.8} aria-hidden />
              <span className="nav-label">{n.label}</span>
              {n.to === "/contas" && overdue > 0 && (
                <span className="nav-badge" aria-label={`${overdue} atrasadas`}>
                  {overdue}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <nav className="nav" aria-label="Preferências">
            <NavLink to="/configuracoes" data-tip="Configurações">
              <Settings size={18} strokeWidth={1.8} aria-hidden />
              <span className="nav-label">Configurações</span>
            </NavLink>
          </nav>
          <button className="nav-btn" data-tip={collapsed ? "Expandir menu" : "Recolher menu"} aria-expanded={!collapsed} onClick={toggleCollapsed}>
            {collapsed ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}
            <span className="nav-label">{collapsed ? "Expandir menu" : "Recolher menu"}</span>
          </button>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <NavLink to="/" className="brand" aria-label="Luna Finance — painel">
            <LunaMark size={30} />
            <span className="brand-name">
              Luna <span>Finance</span>
            </span>
          </NavLink>
          <div className="crumbs">
            <nav aria-label="Você está em" className="row" style={{ gap: 8 }}>
              <span>Luna Finance</span>
              <ChevronRight size={14} aria-hidden />
              <span aria-current="page">{title}</span>
            </nav>
            {VIEW_PAGES.has(pathname) && (
              <span className="context-chip">
                <i aria-hidden /> {viewLabel}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <button className="btn btn-ghost icon-btn tip-always hide-mobile" data-tip={dark ? "Tema claro" : "Tema escuro"} aria-label={dark ? "Usar tema claro" : "Usar tema escuro"} onClick={() => setTheme(dark ? "light" : "dark")}>
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {me && <UserMenu me={me} color={color} onLogout={() => logout.mutate()} />}
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
            <n.icon size={20} strokeWidth={1.8} aria-hidden />
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
