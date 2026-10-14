import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LimitSnap } from "./api";
import { buildLimitViews } from "./forecast";
import { fmtDateTime } from "./format";
import { LimitCard } from "./LimitCard";
import { Card, TipBox, srcColor, useApp } from "./ui";

export function Limits({ claudeHooked }: { claudeHooked: boolean }) {
  const { data } = useApp();
  const views = useMemo(() => buildLimitViews(data), [data]);
  const hasClaude = views.some((v) => v.source === "claude" && v.basis === "live");
  return (
    <div className="page">
      {!hasClaude && (
        <div className="notice">
          {claudeHooked ? (
            <>Claude 한도 수집이 연결돼 있어요. 터미널의 Claude Code를 한 번 사용하면 상태줄이 갱신되면서 실제 5시간/주간 %가 기록됩니다.</>
          ) : (
            <>
              Claude 한도의 실제 %는 터미널 Claude Code의 상태줄로만 받을 수 있어요 (데스크톱 앱은 상태줄을 실행하지 않아요). 지금 보이는 Claude 한도는 과거 “한도 도달” 기록과 사용 비용으로 추정한 값이에요. 설정 → <b>Claude 한도 수집</b>에서 연결할 수 있어요.
            </>
          )}
        </div>
      )}
      <div className="grid g2">
        {views.map((v) => (
          <LimitCard key={v.key} v={v} detailed />
        ))}
      </div>
      <HistoryChart />
      <Card title="예측 방식">
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--ink-2)", fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <b>현재 속도</b>: 5시간 한도는 최근 1시간, 주간 한도는 최근 24시간 동안 늘어난 사용률을 시간당으로 환산해요.
          </li>
          <li>
            <b>추정 사용률</b>: 마지막 스냅샷 이후 쓴 토큰의 API 환산 비용 × (이 윈도우에서 관측된 %/달러 비율)로 지금 값을 추정해요. 한도는 웹·앱 사용량과도 공유되므로 실제와 다를 수 있어요.
          </li>
          <li>
            <b>소진 예상</b>: 지금 사용률에서 100%까지 남은 양을 현재 속도로 나눈 시각이에요. 리셋보다 늦으면 “리셋 전 소진 없음”으로 표시해요.
          </li>
          <li>
            <b>한도 100% 환산</b>: 같은 윈도우의 사용률과 그동안 쓴 API 환산 비용으로 계산한, 한도 전체가 대략 몇 달러어치인지에 대한 추정치예요.
          </li>
        </ul>
      </Card>
    </div>
  );
}

function HistoryChart() {
  const { data, colors } = useApp();
  const series = useMemo(() => {
    const m = new Map<string, LimitSnap[]>();
    const since = Date.now() - 14 * 86_400_000;
    for (const s of data.limits) {
      if (s.ts < since || !s.windowMinutes) continue;
      const k = `${s.source}|${s.win}|${s.windowMinutes}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    // Only window kinds that are still in use.
    return [...m.entries()].filter(([, v]) => Date.now() - v[v.length - 1].ts < 8 * 86_400_000);
  }, [data]);
  if (!series.length) return null;
  const now = Date.now();
  const start = now - 14 * 86_400_000;
  const ticks: number[] = [];
  const d0 = new Date(start);
  d0.setHours(24, 0, 0, 0);
  for (let t = d0.getTime(); t <= now; t += 2 * 86_400_000) ticks.push(t);
  return (
    <Card title="최근 14일 한도 사용 흐름" sub="리셋마다 0%로 돌아가는 톱니 모양">
      <div className="legend" style={{ marginBottom: 8 }}>
        {series.map(([k, v], i) => (
          <span key={k}>
            <span className="sw" style={{ background: srcColor(colors, v[0].source), opacity: i % 2 ? 0.55 : 1 }} />
            {v[0].source === "claude" ? "Claude" : "Codex"} · {v[0].windowMinutes === 300 ? "5시간" : v[0].windowMinutes === 10080 ? "주간" : `${v[0].windowMinutes}분`}
            {v[0].win.includes("opus") ? " (Opus)" : v[0].win.includes("sonnet") ? " (Sonnet)" : ""}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={[start, now]}
            ticks={ticks}
            tickFormatter={(t) => `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}`}
            stroke={colors.axis}
            tick={{ fill: colors.muted, fontSize: 11 }}
            allowDuplicatedCategory={false}
          />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(x) => `${x}%`} stroke={colors.axis} tick={{ fill: colors.muted, fontSize: 11 }} />
          <Tooltip
            cursor={{ stroke: colors.axis }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as LimitSnap;
              return <TipBox title={fmtDateTime(p.ts)} rows={[[p.source === "claude" ? "Claude" : "Codex", `${p.usedPct.toFixed(1)}%`, srcColor(colors, p.source)]]} />;
            }}
          />
          {series.map(([k, v], i) => (
            <Line
              key={k}
              data={withResets(v)}
              dataKey="usedPct"
              stroke={srcColor(colors, v[0].source)}
              strokeOpacity={i % 2 ? 0.55 : 1}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}

/** Insert a drop to 0% at each reset so the line doesn't slant across windows. */
function withResets(v: LimitSnap[]): LimitSnap[] {
  const out: LimitSnap[] = [];
  for (let i = 0; i < v.length; i++) {
    const s = v[i];
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.resetsAt - s.resetsAt) > 10 * 60_000) {
      // Windows can also reset earlier than announced, so cut at whichever comes first.
      const cut = Math.min(prev.resetsAt, s.ts - 1);
      out.push({ ...prev, ts: cut - 1 });
      out.push({ ...prev, ts: cut, usedPct: 0 });
    }
    out.push(s);
  }
  return out;
}
