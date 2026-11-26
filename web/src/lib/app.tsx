import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get } from "./api";
import type { Account, Category, Me, Member, View } from "./types";
import { memberColor } from "./format";

// --------- preferências locais (só conveniência; tudo em try/catch) ---------
function readLocal(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* modo privado */
  }
}

type Theme = "system" | "light" | "dark";
type Toast = { id: number; text: string; tone: "ok" | "error" };

interface AppState {
  theme: Theme;
  setTheme(t: Theme): void;
  dark: boolean;
  view: View;
  setView(v: View): void;
  toast(text: string, tone?: "ok" | "error"): void;
  openNewTransaction(preset?: Partial<{ kind: "income" | "expense"; status: "paid" | "pending" }>): void;
  newTxPreset: Partial<{ kind: "income" | "expense"; status: "paid" | "pending" }> | null;
  closeNewTransaction(): void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readLocal("luna.theme", "dark") as Theme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [view, setViewState] = useState<View>(() => {
    const v = readLocal("luna.view", "me");
    return v === "family" ? "family" : "me";
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [newTxPreset, setNewTxPreset] = useState<AppState["newTxPreset"]>(null);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq?.addEventListener("change", on);
    return () => mq?.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toast = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 6000 : 3500);
  }, []);

  const value = useMemo<AppState>(
    () => ({
      theme,
      setTheme: (t) => {
        setThemeState(t);
        writeLocal("luna.theme", t);
      },
      dark: theme === "dark" || (theme === "system" && systemDark),
      view,
      setView: (v) => {
        setViewState(v);
        writeLocal("luna.view", v === "family" ? "family" : "me");
      },
      toast,
      newTxPreset,
      openNewTransaction: (preset) => setNewTxPreset(preset ?? {}),
      closeNewTransaction: () => setNewTxPreset(null),
    }),
    [theme, systemDark, view, toast, newTxPreset],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === "error" ? "error" : ""}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppProvider ausente");
  return c;
}

// ------------------------------- dados -------------------------------
export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/me"), retry: false, staleTime: 60_000 });
}
export function useMembers() {
  return useQuery({ queryKey: ["members"], queryFn: () => get<Member[]>("/members"), staleTime: 5 * 60_000 });
}
export function useCategories() {
  return useQuery({ queryKey: ["categories"], queryFn: () => get<Category[]>("/categories"), staleTime: 5 * 60_000 });
}
export function useAccounts() {
  return useQuery({ queryKey: ["accounts", "me"], queryFn: () => get<Account[]>("/accounts"), staleTime: 60_000 });
}

/** Recarrega tudo que depende de movimentações. */
export function useInvalidateFinance() {
  const qc = useQueryClient();
  return () => {
    for (const k of ["dashboard", "wallet", "transactions", "bills", "accounts", "reports", "goals", "recurrences"]) qc.invalidateQueries({ queryKey: [k] });
  };
}

export function useMemberLookup() {
  const { data } = useMembers();
  const { dark } = useApp();
  return useMemo(() => {
    const map = new Map((data ?? []).map((m) => [m.id, { ...m, color: memberColor(m.color, dark) }]));
    return (id: number) => map.get(id);
  }, [data, dark]);
}

/** Pode alternar para a visão familiar? (decisão final é sempre do backend) */
export function useCanSeeFamily() {
  const { data } = useMe();
  return data ? data.familyAccess !== "none" : false;
}

export function viewParam(view: View) {
  return view === "me" ? "me" : view === "family" ? "family" : String(view);
}
