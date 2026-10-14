import type { UiSettings } from "./api";

export function fmtTokens(n: number, digits = 1): string {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(digits) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(digits) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(digits) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(digits) + "K";
  return Math.round(n).toString();
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("ko-KR");
}

export function makeMoney(s: Pick<UiSettings, "currency" | "krwRate">) {
  return (usd: number, compact = false): string => {
    if (s.currency === "KRW") {
      const krw = usd * s.krwRate;
      if (compact && Math.abs(krw) >= 1e8) return "₩" + (krw / 1e8).toFixed(2) + "억";
      if (compact && Math.abs(krw) >= 1e4) return "₩" + (krw / 1e4).toFixed(krw >= 1e6 ? 0 : 1) + "만";
      return "₩" + Math.round(krw).toLocaleString("ko-KR");
    }
    if (compact && Math.abs(usd) >= 1e4) return "$" + (usd / 1e3).toFixed(1) + "K";
    const digits = Math.abs(usd) >= 100 ? 0 : 2;
    return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
}
export type Money = ReturnType<typeof makeMoney>;

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

export function fmtDate(d: string | Date): string {
  const x = typeof d === "string" ? parseDay(d) : d;
  return `${x.getMonth() + 1}/${x.getDate()} (${DOW[x.getDay()]})`;
}

export function fmtShortDate(d: string): string {
  const x = parseDay(d);
  return `${x.getMonth() + 1}/${x.getDate()}`;
}

export function fmtDateTime(ms: number): string {
  const x = new Date(ms);
  const today = new Date();
  const hm = `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
  if (dayKey(x) === dayKey(today)) return `오늘 ${hm}`;
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (dayKey(x) === dayKey(tomorrow)) return `내일 ${hm}`;
  return `${x.getMonth() + 1}/${x.getDate()} (${DOW[x.getDay()]}) ${hm}`;
}

export function fmtDuration(ms: number): string {
  if (!isFinite(ms)) return "∞";
  const neg = ms < 0;
  let m = Math.round(Math.abs(ms) / 60_000);
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const parts = d > 0 ? [`${d}일`, h ? `${h}시간` : ""] : h > 0 ? [`${h}시간`, m ? `${m}분` : ""] : [`${m}분`];
  return (neg ? "-" : "") + parts.filter(Boolean).join(" ");
}

export function fmtAgo(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return "방금";
  return fmtDuration(diff) + " 전";
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function pct(n: number, digits = 0): string {
  return n.toFixed(digits) + "%";
}

export function projectName(path: string): string {
  if (!path) return "(알 수 없음)";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}
