import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisMoney, money, monthLong, monthShort, pct } from "../lib/format";
import type { CategorySlice, SeriesPoint } from "../lib/types";

const axis = { stroke: "var(--ink-3)", fontSize: 12, tickLine: false, axisLine: false } as const;

function Tip({ active, payload, label, rows }: { active?: boolean; payload?: Array<{ payload: SeriesPoint }>; label?: string; rows: "flow" | "balance" }) {
  if (!active || !payload?.length || !label) return null;
  const p = payload[0].payload as SeriesPoint & { balanceCents?: number };
  return (
    <div className="viz-tip">
      <div className="t">{monthLong(label)}</div>
      {rows === "flow" ? (
        <>
          <div className="r">
            <span className="row" style={{ gap: 6 }}>
              <i className="marker" style={{ background: "var(--income)" }} /> Receitas
            </span>
            <b className="num">{money(p.incomeCents)}</b>
          </div>
          <div className="r">
            <span className="row" style={{ gap: 6 }}>
              <i className="marker" style={{ background: "var(--expense)" }} /> Despesas
            </span>
            <b className="num">{money(p.expenseCents)}</b>
          </div>
          <div className="r" style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--line)" }}>
            <span>Resultado</span>
            <b className="num">{(p.resultCents >= 0 ? "+" : "−") + money(Math.abs(p.resultCents))}</b>
          </div>
        </>
      ) : (
        <div className="r">
          <span>Saldo no fim do mês</span>
          <b className="num">{money(p.balanceCents ?? 0)}</b>
        </div>
      )}
    </div>
  );
}

/** Receitas x despesas por mês (2 séries, legenda sempre visível). */
export function FlowChart({ data, height = 240 }: { data: SeriesPoint[]; height?: number }) {
  return (
    <div>
      <div className="legend" style={{ marginBottom: 10 }}>
        <span>
          <i style={{ background: "var(--income)" }} /> Receitas
        </span>
        <span>
          <i style={{ background: "var(--expense)" }} /> Despesas
        </span>
      </div>
      <div style={{ width: "100%", height }} role="img" aria-label="Gráfico de receitas e despesas por mês. Os valores também aparecem na tabela do relatório.">
        <ResponsiveContainer>
          <BarChart data={data} barGap={2} barCategoryGap="28%" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
            <YAxis tickFormatter={(v) => axisMoney(v)} width={52} {...axis} />
            <Tooltip content={<Tip rows="flow" />} cursor={{ fill: "color-mix(in oklab, var(--ink) 5%, transparent)" }} />
            <Bar dataKey="incomeCents" name="Receitas" fill="var(--income)" radius={[4, 4, 0, 0]} maxBarSize={22} />
            <Bar dataKey="expenseCents" name="Despesas" fill="var(--expense)" radius={[4, 4, 0, 0]} maxBarSize={22} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Evolução do patrimônio (uma série — o título nomeia, sem legenda). */
export function BalanceChart({ data, height = 200 }: { data: Array<{ month: string; balanceCents: number }>; height?: number }) {
  return (
    <div style={{ width: "100%", height }} role="img" aria-label="Evolução do saldo nos últimos 12 meses">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--seq)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--seq)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="month" tickFormatter={monthShort} {...axis} interval="preserveStartEnd" />
          <YAxis tickFormatter={(v) => axisMoney(v)} width={52} {...axis} />
          <Tooltip content={<Tip rows="balance" />} cursor={{ stroke: "var(--ink-3)", strokeDasharray: "3 3" }} />
          <Area type="monotone" dataKey="balanceCents" stroke="var(--seq)" strokeWidth={2} fill="url(#balFill)" activeDot={{ r: 5, strokeWidth: 2, stroke: "var(--surface)" }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Ranking de categorias: magnitude em um só tom (sem arco-íris). */
export function CategoryBars({ data, limit = 6 }: { data: CategorySlice[]; limit?: number }) {
  const top = data.slice(0, limit);
  const rest = data.slice(limit);
  const rows = rest.length
    ? [...top, { categoryId: -1, name: `Outras (${rest.length})`, color: "", icon: "", cents: rest.reduce((s, r) => s + r.cents, 0), count: 0, percent: Math.round(rest.reduce((s, r) => s + r.percent, 0) * 10) / 10 }]
    : top;
  const max = Math.max(1, ...rows.map((r) => r.cents));
  return (
    <div className="hbar">
      {rows.map((r) => (
        <div className="hbar-row" key={r.categoryId ?? r.name}>
          <div className="top">
            <span>{r.name}</span>
            <span className="row" style={{ gap: 10 }}>
              <span className="faint tnum">{pct(r.percent)}</span>
              <b className="num">{money(r.cents)}</b>
            </span>
          </div>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(r.cents / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
