import type { ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LimitView } from "./forecast";
import { fmtAgo, fmtDateTime, fmtDuration } from "./format";
import { StatusIcon, TipBox, srcColor, useApp } from "./ui";

function StatusLine({ v }: { v: LimitView }) {
  const { snapshotAt } = useApp();
  const now = Date.now();
  const paceLabel = snapshotAt === undefined ? "현재 속도면" : "캡처 당시 속도면";
  let main: ReactNode;
  if (v.idle) {
    main = (
      <>
        진행 중인 윈도우 없음 · <span className="muted">다음 요청부터 새 {v.windowLabel} 윈도우가 시작돼요</span>
      </>
    );
  } else if (v.isReset && v.nowPct < 0.5 && !v.estimated) {
    main = (
      <>
        윈도우가 리셋됐어요 · <span className="muted">다음 사용 시 갱신</span>
      </>
    );
  } else if (v.nowPct >= 100) {
    main = (
      <>
        <b>한도 도달</b> · 리셋까지 {fmtDuration(v.resetsAt - now)}
      </>
    );
  } else if (v.exhaustAt) {
    main = (
      <>
        {paceLabel} <b>{fmtDateTime(v.exhaustAt)}</b> 소진 예상
        <span className="muted"> · 리셋 {fmtDuration(v.resetsAt - v.exhaustAt)} 전</span>
      </>
    );
  } else if (v.recentRate <= 0.001) {
    main = (
      <>
        {v.recentLabel} 사용 없음 · 리셋 시 <b>{Math.round(v.nowPct)}%</b> 유지
      </>
    );
  } else {
    main = (
      <>
        {paceLabel} 리셋 시 약 <b>{Math.round(Math.min(v.atReset, 100))}%</b>
        <span className="muted"> · 리셋 전 소진 없음</span>
        {v.atResetRange && (
          <div className="muted" style={{ fontSize: 12 }}>
            평소 사용 패턴 기준 {Math.round(v.atResetRange[0])}~{Math.min(100, Math.round(v.atResetRange[1]))}%
            {v.atResetRange[1] >= 100 ? " · 많이 쓰면 소진될 수 있어요" : ""}
          </div>
        )}
      </>
    );
  }
  return (
    <div className="status">
      <StatusIcon kind={v.status} />
      <div>{main}</div>
    </div>
  );
}

export function LimitCard({ v, detailed = false }: { v: LimitView; detailed?: boolean }) {
  const { colors, money, snapshotAt } = useApp();
  const now = snapshotAt ?? Date.now();
  const expiredSinceCapture = snapshotAt !== undefined && v.resetsAt <= Date.now();
  const color = srcColor(colors, v.source);
  const elapsed = Math.min(1, Math.max(0, (now - v.startAt) / (v.resetsAt - v.startAt)));
  return (
    <section className="card limit-card">
      <div className="limit-top">
        <span className="dot" style={{ background: color }} />
        <span className="name">{v.title}</span>
        <span className="win">{v.windowLabel} 한도</span>
        {v.plan && <span className="plan">{v.plan}</span>}
      </div>
      <div className="limit-pct">
        {v.nowPct.toFixed(v.nowPct < 10 ? 1 : 0)}%
        <small>
          {v.basis === "calibrated" ? "추정 · 과거 한도 도달 기록 기준" : v.estimated ? `추정 · 마지막 확인 ${Math.round(v.lastPct)}%` : snapshotAt === undefined ? "사용" : "캡처 당시 사용"}
        </small>
      </div>
      <div className="bar" title={`시간 경과 ${Math.round(elapsed * 100)}%`}>
        <div className="fill" style={{ width: `${Math.min(100, v.lastPct)}%`, background: color }} />
        {v.estimated && (
          <div className="est" style={{ left: `${Math.min(100, v.lastPct)}%`, width: `${Math.min(100, v.nowPct) - Math.min(100, v.lastPct)}%`, background: color }} />
        )}
        <div className="marker" style={{ left: `calc(${elapsed * 100}% - 1px)` }} />
      </div>
      <div className="limit-meta">
        <span>{v.idle ? "리셋 시각 미정" : expiredSinceCapture ? `기록된 리셋 ${fmtDateTime(v.resetsAt)} · 시각 지남` : `리셋 ${fmtDateTime(v.resetsAt)} (${fmtDuration(v.resetsAt - Date.now())} 후)`}</span>
        <span>시간 경과 {Math.round(elapsed * 100)}%</span>
      </div>
      {snapshotAt !== undefined && <div className="hint limit-capture">{v.basis === "calibrated" ? "추정 기준 마지막 기록" : "한도 마지막 확인"} {fmtDateTime(v.lastSnapTs)} · {fmtAgo(v.lastSnapTs)}</div>}
      {expiredSinceCapture ? <div className="status"><div>기록된 리셋 시각이 지났어요. 최신 한도는 PC의 새 캡처가 필요해요.</div></div> : <StatusLine v={v} />}
      {detailed && (
        <>
          <LimitChart v={v} />
          <dl className="kv">
            <dt>{v.recentLabel} 속도</dt>
            <dd>{v.recentRate.toFixed(2)}%/시간</dd>
            <dt>윈도우 평균 속도</dt>
            <dd>{v.avgRate.toFixed(2)}%/시간</dd>
            {v.atResetRange && (
              <>
                <dt>리셋 시 범위 (80%)</dt>
                <dd>
                  {Math.round(v.atResetRange[0])}% ~ {Math.round(v.atResetRange[1])}%
                </dd>
              </>
            )}
            <dt>평균 속도 기준</dt>
            <dd>{v.exhaustAtAvg ? `${fmtDateTime(v.exhaustAtAvg)} 소진` : `리셋 시 약 ${Math.round(Math.min(100, v.atResetAvg))}%`}</dd>
            <dt>남은 여유</dt>
            <dd>
              {Math.max(0, 100 - v.nowPct).toFixed(0)}%
              {v.usdPerFull ? ` ≈ ${money((v.usdPerFull * Math.max(0, 100 - v.nowPct)) / 100)} 상당` : ""}
            </dd>
            {v.usdPerFull && (
              <>
                <dt>한도 100% 환산</dt>
                <dd>≈ API {money(v.usdPerFull)} 상당</dd>
              </>
            )}
            <dt>{v.basis === "calibrated" ? "마지막 기준 기록" : "마지막 스냅샷"}</dt>
            <dd>{fmtDateTime(v.lastSnapTs)}</dd>
          </dl>
          {v.history.length > 0 && (
            <div className="row" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              지난 윈도우 최종:
              {v.history.map((h) => (
                <span key={h.resetsAt} title={`리셋 ${fmtDateTime(h.resetsAt)}`}>
                  <b style={{ color: "var(--ink)" }}>{Math.round(h.finalPct)}%</b>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function LimitChart({ v }: { v: LimitView }) {
  const { colors, snapshotAt } = useApp();
  const now = snapshotAt ?? Date.now();
  const color = srcColor(colors, v.source);
  const actual = [...v.points];
  if (!v.isReset && actual.length && (v.estimated || actual[actual.length - 1].ts < now)) actual.push({ ts: now, pct: v.nowPct });
  if (actual.length === 0) actual.push({ ts: v.startAt, pct: 0 }, { ts: Math.min(now, v.resetsAt), pct: v.nowPct });
  const end = v.exhaustAt ?? v.resetsAt;
  const projection =
    v.recentRate > 0 && v.nowPct < 100
      ? [
          { ts: now, pct: v.nowPct },
          { ts: end, pct: Math.min(100, v.exhaustAt ? 100 : v.atReset) },
        ]
      : [];
  const pace = [
    { ts: v.startAt, pct: 0 },
    { ts: v.resetsAt, pct: 100 },
  ];
  const span = v.resetsAt - v.startAt;
  const step = span <= 6 * 3_600_000 ? 3_600_000 : 86_400_000;
  const ticks: number[] = [];
  const first = new Date(v.startAt);
  if (step === 86_400_000) first.setHours(24, 0, 0, 0);
  else first.setMinutes(60, 0, 0);
  for (let t = first.getTime(); t <= v.resetsAt; t += step) ticks.push(t);
  const tickFmt = (t: number) => {
    const d = new Date(t);
    return step === 86_400_000 ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getHours()}시`;
  };
  return (
    <div>
      <div className="legend" style={{ margin: "4px 0 6px" }}>
        <span>
          <span className="sw" style={{ background: color }} />
          사용률
        </span>
        <span>
          <span className="sw dash" />
          {snapshotAt === undefined ? "현재 속도 예측" : "캡처 당시 속도 예측"}
        </span>
        <span>
          <span className="sw" style={{ background: colors.axis, height: 2, verticalAlign: 3 }} />
          균등 사용 기준
        </span>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={[v.startAt, v.resetsAt]}
            ticks={ticks}
            tickFormatter={tickFmt}
            stroke={colors.axis}
            tick={{ fill: colors.muted, fontSize: 11 }}
            allowDuplicatedCategory={false}
          />
          <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} stroke={colors.axis} tick={{ fill: colors.muted, fontSize: 11 }} tickFormatter={(x) => `${x}%`} />
          <ReferenceLine y={100} stroke={colors.critical} strokeWidth={1} />
          <ReferenceLine x={now} stroke={colors.muted} strokeWidth={1} label={{ value: snapshotAt === undefined ? "지금" : "캡처", fill: colors.muted, fontSize: 11, position: "insideTopLeft" }} />
          <Line data={pace} dataKey="pct" stroke={colors.axis} strokeWidth={1} dot={false} isAnimationActive={false} activeDot={false} />
          <Line data={projection} dataKey="pct" stroke={color} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          <Line data={actual} dataKey="pct" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Tooltip
            cursor={{ stroke: colors.axis }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[payload.length - 1].payload as { ts: number; pct: number };
              return <TipBox title={fmtDateTime(p.ts)} rows={[["사용률", `${p.pct.toFixed(1)}%`, color]]} />;
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
