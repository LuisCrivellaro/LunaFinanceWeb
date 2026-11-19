import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisMoney, money, monthLong, monthShort, pct, signedMoney } from "../lib/format";
import type { CategorySlice, SeriesPoint } from "../lib/types";
import { prefersReducedMotion } from "./ui";

const tick = { fill: "var(--text-3)", fontSize: 11.5 } as const;
const axis = { tick, tickLine: false, axisLine: false, tickMargin: 8 } as const;

function Tip({ active, payload, label, rows }: { active?: boolean; payload?: Array<{ payload: SeriesPoint }>; label?: string; rows: "flow" | "balance" }) {
  if (!active || !payload?.length || !label) return null;
  const p = payload[0].payload as SeriesPoint & { balanceCents?: number };
  return (
    <div className="viz-tip">
      <div className="t">{monthLong(label)}</div>
      {rows === "flow" ? (
        <>
          <div className="r">
            <span>
              <i className="marker income" /> Receitas
            </span>
            <b className="num">{money(p.incomeCents)}</b>
          </div>
          <div className="r">
            <span>
              <i className="marker expense" /> Despesas
            </span>
            <b className="num">{money(p.expenseCents)}</b>
          </div>
          <div className="r total">
            <span>Resultado</span>
            <b className="num">{signedMoney(p.resultCents)}</b>
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

/** Legenda das duas séries (sempre visível — cor nunca é a única pista). */
export function FlowLegend() {
  return (
    <div className="legend">
      <span>
        <i style={{ background: "var(--viz-income)" }} /> Receitas
      </span>
      <span>
        <i style={{ background: "var(--viz-expense)" }} /> Despesas
      </span>
    </div>
  );
}

/** Receitas x despesas por mês. */
export function FlowChart({ data, height = 240, legend = true }: { data: SeriesPoint[]; height?: number; legend?: boolean }) {
  const empty = data.every((d) => !d.incomeCents && !d.expenseCents);
  return (
    <div className="stack" style={{ gap: 12 }}>
      {legend && <FlowLegend />}
      <div style={{ width: "100%", height }} role="img" aria-label="Gráfico de receitas e despesas por mês. Os valores também aparecem na tabela do relatório.">
        {empty ? (
          <div className="chart-empty">Sem movimentações no período</div>
        ) : (
          <ResponsiveContainer>
            <BarChart data={data} barGap={3} barCategoryGap="30%" margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="month" tickFormatter={monthShort} {...axis} />
              <YAxis tickFormatter={(v) => axisMoney(v)} width={58} {...axis} />
              <Tooltip content={<Tip rows="flow" />} cursor={{ fill: "var(--primary-softer)", radius: 8 } as object} />
              <Bar isAnimationActive={!prefersReducedMotion()} animationDuration={500} dataKey="incomeCents" name="Receitas" fill="var(--viz-income)" radius={[6, 6, 2, 2]} maxBarSize={16} />
              <Bar isAnimationActive={!prefersReducedMotion()} animationDuration={500} dataKey="expenseCents" name="Despesas" fill="var(--viz-expense)" radius={[6, 6, 2, 2]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

/** Evolução do patrimônio (uma série — o título nomeia, sem legenda). */
export function BalanceChart({ data, height = 200 }: { data: Array<{ month: string; balanceCents: number }>; height?: number }) {
  const id = useId().replace(/:/g, "");
  if (!data.length) return <div className="chart-empty" style={{ height }}>Ainda sem histórico de saldo</div>;
  return (
    <div style={{ width: "100%", height }} role="img" aria-label="Evolução do saldo nos últimos 12 meses">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`bal${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--viz-primary)" stopOpacity={0.28} />
              <stop offset="100%" stopColor="var(--viz-primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="month" tickFormatter={monthShort} {...axis} interval="preserveStartEnd" />
          <YAxis tickFormatter={(v) => axisMoney(v)} width={58} {...axis} />
          <Tooltip content={<Tip rows="balance" />} cursor={{ stroke: "var(--primary-line)", strokeDasharray: "4 4" }} />
          <Area
            type="monotone"
            isAnimationActive={!prefersReducedMotion()}
            animationDuration={600}
            dataKey="balanceCents"
            stroke="var(--viz-primary)"
            strokeWidth={2.25}
            fill={`url(#bal${id})`}
            activeDot={{ r: 5, strokeWidth: 3, stroke: "var(--surface)", fill: "var(--viz-primary)" }}
          />
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
