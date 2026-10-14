import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Dashboard, Source, UiSettings } from "./api";
import type { Money } from "./format";

export interface Colors {
  claude: string;
  codex: string;
  seq: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  surface: string;
  good: string;
  warning: string;
  serious: string;
  critical: string;
}

function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    claude: v("--claude"),
    codex: v("--codex"),
    seq: v("--seq"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    muted: v("--muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    surface: v("--surface"),
    good: v("--good"),
    warning: v("--warning"),
    serious: v("--serious"),
    critical: v("--critical"),
  };
}

/** Chart colors follow the CSS tokens, re-read when the OS theme flips. */
export function useColors(): Colors {
  const [c, setC] = useState(readColors);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setC(readColors());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return c;
}

export interface Ctx {
  data: Dashboard;
  settings: UiSettings;
  money: Money;
  colors: Colors;
}
export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export const SOURCE_NAME: Record<Source, string> = { claude: "Claude Code", codex: "Codex" };
export const srcColor = (c: Colors, s: Source) => (s === "claude" ? c.claude : c.codex);

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} className={v === value ? "on" : ""} onClick={() => onChange(v)} role="radio" aria-checked={v === value}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Card({ title, sub, right, children, className = "" }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={"card " + className}>
      {(title || right) && (
        <div className="card-h">
          {title && <h2>{title}</h2>}
          {sub && <span className="sub">{sub}</span>}
          <span className="spacer" />
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }) {
  return (
    <section className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {detail && <div className="detail">{detail}</div>}
    </section>
  );
}

export function SrcDot({ source }: { source: Source }) {
  const { colors } = useApp();
  return <span className="dot" style={{ background: srcColor(colors, source) }} />;
}

/** Tooltip body used by every chart. */
export function TipBox({ title, rows }: { title: ReactNode; rows: [ReactNode, ReactNode, string?][] }) {
  return (
    <div className="tip">
      <div className="t">{title}</div>
      {rows.map(([k, v, color], i) => (
        <div className="r" key={i}>
          <span>
            {color && <span className="dot" style={{ background: color }} />}
            {k}
          </span>
          <b>{v}</b>
        </div>
      ))}
    </div>
  );
}

export function StatusIcon({ kind }: { kind: "ok" | "warn" | "danger" | "idle" }) {
  const { colors } = useApp();
  const map = {
    ok: [colors.good, "✓"],
    idle: [colors.muted, "–"],
    warn: [colors.warning, "!"],
    danger: [colors.critical, "!"],
  } as const;
  const [bg, ch] = map[kind];
  return (
    <span className="ico" style={{ background: bg, color: kind === "warn" ? "#1a1a19" : "#fff" }}>
      {ch}
    </span>
  );
}
