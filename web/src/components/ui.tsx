import { useEffect, useId, useRef, type ReactNode } from "react";
import {
  Briefcase, Car, CircleDashed, GraduationCap, HeartPulse, Home, Landmark, Laptop, PawPrint, PlusCircle, Repeat,
  ShoppingBag, ShoppingCart, Sparkles, Tag, TrendingUp, Utensils, X, Zap, Target, Plane, Gift, Shield, Baby,
  Dumbbell, Smartphone, Wallet, PiggyBank, type LucideIcon,
} from "lucide-react";
import { initials, money, moneyParts, firstName } from "../lib/format";
import { useApp, useCanSeeFamily, useMembers } from "../lib/app";
import type { View } from "../lib/types";

export const ICONS: Record<string, LucideIcon> = {
  briefcase: Briefcase, laptop: Laptop, "trending-up": TrendingUp, "plus-circle": PlusCircle, "shopping-cart": ShoppingCart,
  home: Home, zap: Zap, car: Car, utensils: Utensils, "heart-pulse": HeartPulse, "graduation-cap": GraduationCap,
  sparkles: Sparkles, repeat: Repeat, "shopping-bag": ShoppingBag, "paw-print": PawPrint, landmark: Landmark,
  "circle-dashed": CircleDashed, tag: Tag, target: Target, plane: Plane, gift: Gift, shield: Shield, baby: Baby,
  dumbbell: Dumbbell, smartphone: Smartphone, wallet: Wallet, "piggy-bank": PiggyBank,
};
export const ICON_CHOICES = Object.keys(ICONS);

export function Icon({ name, size = 18 }: { name: string | null | undefined; size?: number }) {
  const C = ICONS[name ?? "tag"] ?? Tag;
  return <C size={size} strokeWidth={1.8} aria-hidden />;
}

export function CategoryIcon({ icon, color, size = 38 }: { icon: string | null; color: string | null; size?: number }) {
  return (
    <span className="cat-icon" style={{ ["--c" as string]: color ?? undefined, width: size, height: size }}>
      <Icon name={icon} size={Math.round(size * 0.47)} />
    </span>
  );
}

/** Valor em reais com tipografia numérica. `sign` mostra +/− (sem cor no texto). */
export function Money({ cents, sign, kind, className = "", big }: { cents: number; sign?: boolean; kind?: "income" | "expense"; className?: string; big?: boolean }) {
  const prefix = sign || kind ? (kind === "expense" || (sign && cents < 0) ? "−" : cents === 0 ? "" : "+") : "";
  const abs = sign || kind ? Math.abs(cents) : cents;
  if (big) {
    const p = moneyParts(abs);
    return (
      <span className={`num ${className}`}>
        {prefix}
        {p.main}
        <span className="cents">{p.cents}</span>
      </span>
    );
  }
  return (
    <span className={`num ${className}`}>
      {prefix}
      {money(abs)}
    </span>
  );
}

export function Avatar({ name, color, size }: { name: string; color: string; size?: "sm" | "lg" }) {
  return (
    <span className={`avatar ${size ?? ""}`} style={{ ["--c" as string]: color }} title={name} aria-hidden>
      {initials(name)}
    </span>
  );
}

/**
 * Fase da lua como indicador de progresso: 0% = lua nova, 100% = cheia.
 * A sombra desliza da direita para a esquerda conforme a meta avança.
 */
export function MoonPhase({ percent, size = 44, color }: { percent: number; size?: number; color?: string }) {
  const p = Math.max(0, Math.min(100, percent)) / 100;
  const id = useId().replace(/:/g, "");
  const r = size / 2 - 2;
  const c = size / 2;
  // terminador: elipse cuja largura varia de -r a r
  const k = Math.cos(p * Math.PI) * r; // r → -r
  const lit = color ?? "var(--brass)";
  const path = `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${Math.abs(k)} ${r} 0 0 ${k > 0 ? 0 : 1} ${c} ${c - r} Z`;
  return (
    <svg className="moon-phase" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${Math.round(percent)}% concluído`}>
      <defs>
        <radialGradient id={`g${id}`} cx="40%" cy="38%" r="70%">
          <stop offset="0%" stopColor={lit} stopOpacity="1" />
          <stop offset="100%" stopColor={lit} stopOpacity="0.78" />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c} r={r} fill="color-mix(in oklab, var(--ink) 9%, transparent)" />
      {p >= 0.995 ? <circle cx={c} cy={c} r={r} fill={`url(#g${id})`} /> : p > 0.005 ? <path d={path} fill={`url(#g${id})`} /> : null}
      <circle cx={c} cy={c} r={r} fill="none" stroke="color-mix(in oklab, var(--ink) 14%, transparent)" strokeWidth="1" />
    </svg>
  );
}

export function Modal({ title, onClose, children, footer, labelledBy }: { title: string; onClose(): void; children: ReactNode; footer?: ReactNode; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not(.modal-close)");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? titleId} ref={ref}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="btn btn-ghost icon-btn modal-close" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} aria-hidden />;
}

export function CardSkeleton({ lines = 3, h = 120 }: { lines?: number; h?: number }) {
  return (
    <div className="card stack" aria-busy="true" aria-label="Carregando">
      <Skeleton h={14} w="40%" />
      <Skeleton h={h / 3} w="60%" />
      {Array.from({ length: lines - 2 }).map((_, i) => (
        <Skeleton key={i} h={12} />
      ))}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Não foi possível carregar.";
  return (
    <div className="alert bad" role="alert">
      <span style={{ flex: 1 }}>{msg}</span>
      {retry && (
        <button className="btn btn-sm" onClick={retry}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

/** Alterna entre "Eu", "Família" e (com acesso completo) cada pessoa. */
export function ViewSwitch({ allowPeople = false }: { allowPeople?: boolean }) {
  const { view, setView } = useApp();
  const canFamily = useCanSeeFamily();
  const { data: members } = useMembers();
  if (!canFamily) return null;
  const options: Array<{ v: View; label: string }> = [
    { v: "me", label: "Eu" },
    { v: "family", label: "Família" },
  ];
  return (
    <div className="row wrap">
      <div className="segmented" role="group" aria-label="Visão">
        {options.map((o) => (
          <button key={String(o.v)} aria-pressed={view === o.v} onClick={() => setView(o.v)}>
            {o.label}
          </button>
        ))}
      </div>
      {allowPeople && view !== "me" && members && (
        <select
          className="select"
          style={{ width: "auto", height: 38 }}
          aria-label="Filtrar por pessoa"
          value={typeof view === "number" ? view : ""}
          onChange={(e) => setView(e.target.value ? Number(e.target.value) : "family")}
        >
          <option value="">Todos</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {firstName(m.name)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function StatusChip({ status, overdue, kind }: { status: "paid" | "pending"; overdue?: boolean; kind?: "income" | "expense" }) {
  if (status === "paid") return <span className="chip ok">{kind === "income" ? "Recebido" : "Pago"}</span>;
  if (overdue) return <span className="chip bad">Atrasado</span>;
  return <span className="chip warn">Pendente</span>;
}
