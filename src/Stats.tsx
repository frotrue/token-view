import { Fragment, useMemo, useState } from "react";
import { totalTokens, type Source, type TokenSums } from "./api";
import { buildBlocks, type Metric, type SourceFilter } from "./forecast";
import { addDays, calendarDateAt, dayKey, fmtDateTime, fmtDuration, fmtInt, fmtTokens, projectName } from "./format";
import { Card, Seg, SrcDot, srcColor, useApp } from "./ui";

const zero = (): TokenSums => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, cost: 0, requests: 0 });
const add = (a: TokenSums, b: TokenSums) => {
  a.input += b.input;
  a.cacheWrite += b.cacheWrite;
  a.cacheRead += b.cacheRead;
  a.output += b.output;
  a.reasoning += b.reasoning;
  a.cost += b.cost;
  a.requests += b.requests;
};

export function Stats() {
  const { snapshotAt, snapshotTimeZone } = useApp();
  const [range, setRange] = useState(30);
  const [src, setSrc] = useState<SourceFilter>("all");
  const since = range > 0 ? dayKey(addDays(calendarDateAt(snapshotAt ?? Date.now(), snapshotTimeZone), -(range - 1))) : "";
  const keep = (r: { date: string; source: Source }) => r.date >= since && (src === "all" || r.source === src);
  return (
    <div className="page">
      {snapshotAt !== undefined && <div className="hint">기간은 PC 캡처일을 기준으로 표시해요.</div>}
      <div className="row">
        <Seg value={range} onChange={setRange} options={[[1, "오늘"], [7, "7일"], [30, "30일"], [90, "90일"], [0, "전체"]]} />
        <Seg value={src} onChange={setSrc} options={[["all", "전체"], ["claude", "Claude Code"], ["codex", "Codex"]]} />
      </div>
      <Composition keep={keep} />
      <div className="grid g2">
        <ModelTable keep={keep} />
        <ProjectTable keep={keep} />
      </div>
      <div className="grid g2">
        <SessionTable since={since} src={src} />
        {src !== "codex" && <BlockTable since={since} />}
      </div>
      <Heatmap src={src} />
    </div>
  );
}

type Keep = (r: { date: string; source: Source }) => boolean;

function Composition({ keep }: { keep: Keep }) {
  const { data, money, colors } = useApp();
  const sums = useMemo(() => {
    const m: Record<Source, TokenSums> = { claude: zero(), codex: zero() };
    for (const r of data.daily) if (keep(r)) add(m[r.source], r);
    return m;
  }, [data, keep]);
  const rows: [string, keyof TokenSums, string][] = [
    ["입력 (캐시 미적용)", "input", "새로 처리된 입력"],
    ["캐시 쓰기", "cacheWrite", "캐시에 저장한 입력"],
    ["캐시 읽기", "cacheRead", "캐시에서 재사용한 입력 (저렴)"],
    ["출력", "output", "추론 토큰 포함"],
  ];
  return (
    <div className="grid g2">
      {(["claude", "codex"] as Source[]).map((s) => {
        const t = sums[s];
        const total = totalTokens(t);
        const inTotal = t.input + t.cacheWrite + t.cacheRead;
        const hit = inTotal > 0 ? (t.cacheRead / inTotal) * 100 : 0;
        return (
          <Card
            key={s}
            title={
              <>
                <SrcDot source={s} />
                {s === "claude" ? "Claude Code" : "Codex"} 토큰 구성
              </>
            }
            sub={`${fmtTokens(total, 2)} · ${money(t.cost)} · 요청 ${fmtInt(t.requests)}회`}
          >
            <div className="tbl-wrap"><table>
              <tbody>
                {rows.map(([label, k, hint]) => {
                  const v = t[k] as number;
                  const share = total ? (v / total) * 100 : 0;
                  return (
                    <tr key={k} title={hint}>
                      <td style={{ width: 150 }}>{label}</td>
                      <td style={{ textAlign: "left" }}>
                        <span className="share" style={{ width: `${Math.max(share, 0.5) * 1.6}px`, background: srcColor(colors, s) }} />
                        <span className="muted">{share.toFixed(1)}%</span>
                      </td>
                      <td>{fmtTokens(v, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              캐시 적중률 <b style={{ color: "var(--ink)" }}>{hit.toFixed(1)}%</b> · 추론 토큰 {fmtTokens(t.reasoning)} · 요청당 평균 {fmtTokens(t.requests ? total / t.requests : 0)} 토큰
            </div>
          </Card>
        );
      })}
    </div>
  );
}

type SortKey = "cost" | "tokens" | "requests";

function useSort(): [SortKey, (k: SortKey) => void] {
  return useState<SortKey>("cost");
}

function SortTh({ k, cur, set, children }: { k: SortKey; cur: SortKey; set: (k: SortKey) => void; children: string }) {
  return (
    <th className="sortable" onClick={() => set(k)} aria-sort={cur === k ? "descending" : "none"}>
      {children}
      {cur === k ? " ↓" : ""}
    </th>
  );
}

function groupRows<T extends { date: string; source: Source } & TokenSums>(rows: T[], keep: Keep, key: (r: T) => string) {
  const m = new Map<string, { name: string; sources: Set<Source>; sums: TokenSums }>();
  for (const r of rows) {
    if (!keep(r)) continue;
    const k = key(r);
    if (!m.has(k)) m.set(k, { name: k, sources: new Set(), sums: zero() });
    const g = m.get(k)!;
    g.sources.add(r.source);
    add(g.sums, r);
  }
  return [...m.values()];
}

function sortVal(s: TokenSums, k: SortKey) {
  return k === "cost" ? s.cost : k === "tokens" ? totalTokens(s) : s.requests;
}

function ModelTable({ keep }: { keep: Keep }) {
  const { data, money, colors } = useApp();
  const [sort, setSort] = useSort();
  const rows = useMemo(() => groupRows(data.dailyModel, keep, (r) => r.model), [data, keep]);
  rows.sort((a, b) => sortVal(b.sums, sort) - sortVal(a.sums, sort));
  const max = Math.max(1e-9, ...rows.map((r) => sortVal(r.sums, sort)));
  const unpriced = new Set(data.unpriced.map((u) => u.model));
  return (
    <Card title="모델별">
      {rows.length === 0 ? (
        <div className="empty">이 기간에는 사용 기록이 없어요</div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>모델</th>
                <SortTh k="requests" cur={sort} set={setSort}>요청</SortTh>
                <th>입력</th>
                <th>캐시 읽기</th>
                <th>출력</th>
                <SortTh k="tokens" cur={sort} set={setSort}>총 토큰</SortTh>
                <SortTh k="cost" cur={sort} set={setSort}>비용</SortTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = [...r.sources][0];
                return (
                  <tr key={r.name}>
                    <td className="name-cell" title={r.name}>
                      <span className="share" style={{ width: `${(sortVal(r.sums, sort) / max) * 40 + 2}px`, background: srcColor(colors, s) }} />
                      {r.name}
                    </td>
                    <td>{fmtInt(r.sums.requests)}</td>
                    <td>{fmtTokens(r.sums.input + r.sums.cacheWrite)}</td>
                    <td>{fmtTokens(r.sums.cacheRead)}</td>
                    <td>{fmtTokens(r.sums.output)}</td>
                    <td>{fmtTokens(totalTokens(r.sums))}</td>
                    <td>{unpriced.has(r.name) ? <span className="muted" title="설정에서 단가를 추가하세요">단가 없음</span> : money(r.sums.cost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ProjectTable({ keep }: { keep: Keep }) {
  const { data, money } = useApp();
  const [sort, setSort] = useSort();
  const rows = useMemo(() => groupRows(data.dailyProject, keep, (r) => r.project), [data, keep]);
  rows.sort((a, b) => sortVal(b.sums, sort) - sortVal(a.sums, sort));
  const total = rows.reduce((a, r) => a + sortVal(r.sums, sort), 0) || 1;
  return (
    <Card title="프로젝트별" sub={`${rows.length}개`}>
      {rows.length === 0 ? (
        <div className="empty">이 기간에는 사용 기록이 없어요</div>
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>프로젝트</th>
                <SortTh k="requests" cur={sort} set={setSort}>요청</SortTh>
                <SortTh k="tokens" cur={sort} set={setSort}>토큰</SortTh>
                <SortTh k="cost" cur={sort} set={setSort}>비용</SortTh>
                <th>비중</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((r) => (
                <tr key={r.name}>
                  <td className="name-cell" title={r.name}>
                    {[...r.sources].map((s) => (
                      <SrcDot key={s} source={s} />
                    ))}
                    {projectName(r.name)}
                  </td>
                  <td>{fmtInt(r.sums.requests)}</td>
                  <td>{fmtTokens(totalTokens(r.sums))}</td>
                  <td>{money(r.sums.cost)}</td>
                  <td>{((sortVal(r.sums, sort) / total) * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const DOW = ["월", "화", "수", "목", "금", "토", "일"];

function Heatmap({ src }: { src: SourceFilter }) {
  const { data, colors, money, snapshotTimeZone } = useApp();
  const [metric, setMetric] = useState<Metric>("cost");
  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const r of data.hourly) {
      if (src !== "all" && r.source !== src) continue;
      const d = calendarDateAt(r.hour, snapshotTimeZone);
      const dow = (d.getDay() + 6) % 7;
      g[dow][d.getHours()] += metric === "cost" ? r.cost : totalTokens(r);
    }
    return g;
  }, [data, src, metric, snapshotTimeZone]);
  const max = Math.max(1e-9, ...grid.flat());
  const fmt = (x: number) => (metric === "cost" ? money(x) : fmtTokens(x));
  const busiest = grid
    .flatMap((row, d) => row.map((v, h) => ({ d, h, v })))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3);
  return (
    <Card
      title="요일 · 시간대 패턴"
      sub="최근 35일 합계"
      right={<Seg value={metric} onChange={setMetric} options={[["cost", "비용"], ["tokens", "토큰"]]} />}
    >
      <div className="heat-scroll"><div className="heat">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="hl">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {grid.map((row, d) => (
          <Fragment key={d}>
            <span style={{ alignSelf: "center" }}>
              {DOW[d]}
            </span>
            {row.map((v, h) => (
              <div
                key={d + "-" + h}
                className="cell"
                title={`${DOW[d]}요일 ${h}시 · ${fmt(v)}`}
                style={v > 0 ? { background: colors.seq, opacity: 0.12 + 0.88 * Math.sqrt(v / max) } : undefined}
              />
            ))}
          </Fragment>
        ))}
      </div></div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        가장 많이 쓰는 시간: {busiest.filter((b) => b.v > 0).map((b) => `${DOW[b.d]} ${b.h}시`).join(", ") || "-"}
      </div>
    </Card>
  );
}

function SessionTable({ since, src }: { since: string; src: SourceFilter }) {
  const { data, money, snapshotTimeZone } = useApp();
  const rows = data.sessions.filter((r) => (!since || dayKey(calendarDateAt(r.lastTs, snapshotTimeZone)) >= since) && (src === "all" || r.source === src));
  return (
    <Card title="세션별" sub={`${rows.length}개 · 최근 35일까지`}>
      {rows.length === 0 ? (
        <div className="empty">이 기간에는 세션이 없어요</div>
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>시작</th>
                <th style={{ textAlign: "left" }}>프로젝트</th>
                <th>길이</th>
                <th>요청</th>
                <th>토큰</th>
                <th>비용</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r) => (
                <tr key={r.source + r.session} title={`${r.models}\n${r.session}`}>
                  <td>
                    <SrcDot source={r.source} />
                    {fmtDateTime(r.firstTs)}
                  </td>
                  <td className="name-cell" style={{ textAlign: "left", maxWidth: 180 }} title={r.project}>
                    {projectName(r.project)}
                  </td>
                  <td>{fmtDuration(r.lastTs - r.firstTs)}</td>
                  <td>{fmtInt(r.requests)}</td>
                  <td>{fmtTokens(totalTokens(r))}</td>
                  <td>{money(r.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function BlockTable({ since }: { since: string }) {
  const { data, money, colors, snapshotAt, snapshotTimeZone } = useApp();
  const blocks = useMemo(() => buildBlocks(data.fine, data.limits, "claude"), [data]).filter((b) => !since || dayKey(calendarDateAt(b.end, snapshotTimeZone)) >= since);
  const max = Math.max(1e-9, ...blocks.map((b) => b.cost));
  const now = snapshotAt ?? Date.now();
  return (
    <Card title="Claude 5시간 블록" sub="첫 요청부터 5시간씩 묶은 사용 구간">
      {blocks.length === 0 ? (
        <div className="empty">이 기간에는 블록이 없어요</div>
      ) : (
        <div className="tbl-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>시작</th>
                <th>사용 시간</th>
                <th>요청</th>
                <th>토큰</th>
                <th>비용</th>
                <th>시간당</th>
              </tr>
            </thead>
            <tbody>
              {blocks.slice(0, 200).map((b) => {
                const active = b.end > now;
                const hours = Math.max((Math.min(b.lastActivity, b.end) - b.start) / 3_600_000, 1 / 6);
                return (
                  <tr key={b.start}>
                    <td>
                      {fmtDateTime(b.start)}
                      {active && <b style={{ marginLeft: 6 }}>{snapshotAt === undefined ? "진행 중" : "캡처 당시 진행 중"}</b>}
                      {b.hitLimit && (
                        <span title="이 블록에서 한도에 도달했어요" style={{ marginLeft: 6, color: "var(--critical)" }}>
                          ● 한도 도달
                        </span>
                      )}
                    </td>
                    <td>{fmtDuration(Math.min(b.lastActivity, b.end) - b.start)}</td>
                    <td>{fmtInt(b.requests)}</td>
                    <td>{fmtTokens(b.tokens)}</td>
                    <td style={{ textAlign: "right" }}>
                      <span className="share" style={{ width: `${(b.cost / max) * 40 + 2}px`, background: colors.claude }} />
                      {money(b.cost)}
                    </td>
                    <td>{money(b.cost / hours)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
