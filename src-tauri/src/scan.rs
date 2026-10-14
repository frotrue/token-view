//! Incremental ingestion of Claude Code and Codex session logs.
//!
//! Every file is read from the byte offset where the previous scan stopped, so only
//! new lines are parsed. Only complete (newline-terminated) lines are consumed.

use crate::db::{self, Event, LimitSnap};
use crate::pricing::Pricing;
use memchr::memmem;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanStatus {
    pub running: bool,
    pub files_total: usize,
    pub files_done: usize,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub current: String,
    pub last_scan_ms: i64,
    pub last_duration_ms: i64,
    pub new_events: usize,
    pub last_error: String,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Claude,
    Codex,
    ClaudeLimits,
}

struct Target {
    path: PathBuf,
    kind: Kind,
    size: u64,
    mtime: i64,
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn claude_limits_file() -> PathBuf {
    home().join(".token-view").join("claude-rate-limits.jsonl")
}

pub fn claude_roots() -> Vec<PathBuf> {
    let mut v = vec![];
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        for part in d.split([',', ';']) {
            if !part.trim().is_empty() {
                v.push(PathBuf::from(part.trim()).join("projects"));
            }
        }
    }
    v.push(home().join(".claude").join("projects"));
    v.push(home().join(".config").join("claude").join("projects"));
    v.dedup();
    v
}

pub fn codex_roots() -> Vec<PathBuf> {
    let base = std::env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".codex"));
    vec![base.join("sessions"), base.join("archived_sessions")]
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let p = ent.path();
        match ent.file_type() {
            Ok(t) if t.is_dir() => walk(&p, out),
            Ok(t) if t.is_file() => {
                let name = p.to_string_lossy();
                if name.ends_with(".jsonl") || name.ends_with(".jsonl.zst") {
                    out.push(p);
                }
            }
            _ => {}
        }
    }
}

fn collect_targets() -> Vec<Target> {
    let mut targets = vec![];
    let mut push = |paths: Vec<PathBuf>, kind: Kind| {
        for path in paths {
            if let Ok(md) = std::fs::metadata(&path) {
                let mtime = md
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                targets.push(Target { path, kind, size: md.len(), mtime });
            }
        }
    };
    let mut claude = vec![];
    for r in claude_roots() {
        walk(&r, &mut claude);
    }
    push(claude, Kind::Claude);
    let mut codex = vec![];
    for r in codex_roots() {
        walk(&r, &mut codex);
    }
    push(codex, Kind::Codex);
    let lim = claude_limits_file();
    if lim.exists() {
        push(vec![lim], Kind::ClaudeLimits);
    }
    targets
}

fn parse_ts(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.timestamp_millis()),
        Value::Number(n) => {
            let x = n.as_f64()?;
            // seconds vs milliseconds
            Some(if x < 1e11 { (x * 1000.0) as i64 } else { x as i64 })
        }
        _ => None,
    }
}

fn i(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Remembers the last stored limit snapshot per window so we only persist changes.
struct LimitDedup {
    last: HashMap<(String, String, String), (f64, i64, i64)>,
}

impl LimitDedup {
    fn load(conn: &Connection) -> Self {
        let mut last = HashMap::new();
        if let Ok(mut st) = conn.prepare(
            "SELECT source, limit_id, win, used_pct, resets_at, max(ts) FROM limits GROUP BY source, limit_id, win",
        ) {
            let rows = st.query_map([], |r| {
                Ok((
                    (r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?),
                    (r.get::<_, f64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?),
                ))
            });
            if let Ok(rows) = rows {
                for (k, v) in rows.flatten() {
                    last.insert(k, v);
                }
            }
        }
        LimitDedup { last }
    }

    fn offer(&mut self, conn: &Connection, snap: LimitSnap) {
        let key = (snap.source.to_string(), snap.limit_id.clone(), snap.win.clone());
        if let Some(&(pct, resets, ts)) = self.last.get(&key) {
            // Files are not strictly chronological (parallel sessions), so compare
            // against the last stored value in either direction of time.
            let same = (pct - snap.used_pct).abs() < 0.01 && (resets - snap.resets_at).abs() < 120_000;
            if same && (snap.ts - ts).abs() < 15 * 60_000 {
                return;
            }
        }
        if db::insert_limit(conn, &snap).is_ok() {
            self.last.insert(key, (snap.used_pct, snap.resets_at, snap.ts));
        }
    }
}

struct Ctx<'a> {
    conn: &'a Connection,
    pricing: &'a Pricing,
    limits: &'a mut LimitDedup,
    new_events: usize,
}

impl Ctx<'_> {
    fn add(&mut self, e: Event) {
        let (cost, priced) = self.pricing.cost(&e);
        if db::upsert_event(self.conn, &e, cost, priced).is_ok() {
            self.new_events += 1;
        }
    }
}

// ---------- Claude Code ----------

/// A 429 "limit reached" message is the one place Claude logs reveal plan usage: it
/// means 100% of that window was used at this moment. Used to calibrate %/$ estimates.
fn claude_quota_line(ctx: &mut Ctx, line: &[u8]) {
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
    let Some(q) = v.get("quotaLimits") else { return };
    if q.get("status").and_then(|s| s.as_str()) != Some("rejected") {
        return;
    }
    let kind = s(q, "rateLimitType");
    let window_minutes = match kind.as_str() {
        "five_hour" => 300,
        k if k.starts_with("seven_day") => 10080,
        _ => return,
    };
    let (Some(ts), Some(resets_at)) = (v.get("timestamp").and_then(parse_ts), q.get("resetsAt").and_then(parse_ts)) else {
        return;
    };
    ctx.limits.offer(
        ctx.conn,
        LimitSnap {
            source: "claude",
            limit_id: "claude".into(),
            win: kind,
            ts,
            used_pct: 100.0,
            window_minutes,
            resets_at,
            plan: String::new(),
        },
    );
}

fn claude_line(ctx: &mut Ctx, line: &[u8]) {
    if memmem::find(line, b"\"quotaLimits\"").is_some() {
        claude_quota_line(ctx, line);
    }
    if memmem::find(line, b"\"usage\"").is_none() || memmem::find(line, b"\"assistant\"").is_none() {
        return;
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return;
    }
    let Some(msg) = v.get("message") else { return };
    let Some(u) = msg.get("usage") else { return };
    let model = s(msg, "model");
    if model.is_empty() || model.starts_with('<') {
        return; // "<synthetic>" placeholder messages carry no real usage
    }
    let id = s(msg, "id");
    let id = if id.is_empty() { s(&v, "uuid") } else { id };
    if id.is_empty() {
        return;
    }
    let Some(ts) = v.get("timestamp").and_then(parse_ts) else { return };
    let cw_total = i(u, "cache_creation_input_tokens");
    let (cw5, cw1) = match u.get("cache_creation") {
        Some(cc) => {
            let a = i(cc, "ephemeral_5m_input_tokens");
            let b = i(cc, "ephemeral_1h_input_tokens");
            if a + b == 0 && cw_total > 0 { (cw_total, 0) } else { (a, b) }
        }
        None => (cw_total, 0),
    };
    let reasoning = u
        .get("output_tokens_details")
        .map(|d| i(d, "thinking_tokens"))
        .unwrap_or(0);
    let web = u
        .get("server_tool_use")
        .map(|d| i(d, "web_search_requests"))
        .unwrap_or(0);
    ctx.add(Event {
        uid: format!("claude:{id}"),
        source: "claude",
        ts,
        session: s(&v, "sessionId"),
        project: s(&v, "cwd"),
        model,
        input: i(u, "input_tokens"),
        cache_write_5m: cw5,
        cache_write_1h: cw1,
        cache_read: i(u, "cache_read_input_tokens"),
        output: i(u, "output_tokens"),
        reasoning,
        web_search: web,
        fast: u.get("speed").and_then(|x| x.as_str()) == Some("fast"),
    });
}

fn claude_limits_line(ctx: &mut Ctx, line: &[u8]) {
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
    let Some(ts) = v.get("ts").and_then(parse_ts) else { return };
    let Some(rl) = v.get("rate_limits").and_then(|x| x.as_object()) else { return };
    for (name, w) in rl {
        let Some(pct) = w
            .get("used_percentage")
            .or_else(|| w.get("used_percent"))
            .and_then(|x| x.as_f64())
        else {
            continue;
        };
        let resets_at = w.get("resets_at").and_then(parse_ts).unwrap_or(0);
        let window_minutes = if name.contains("five_hour") || name.contains("5h") {
            300
        } else if name.contains("seven_day") || name.contains("week") {
            10080
        } else {
            w.get("window_minutes").and_then(|x| x.as_i64()).unwrap_or(0)
        };
        ctx.limits.offer(
            ctx.conn,
            LimitSnap {
                source: "claude",
                limit_id: "claude".into(),
                win: name.clone(),
                ts,
                used_pct: pct,
                window_minutes,
                resets_at,
                plan: s(&v, "plan"),
            },
        );
    }
}

// ---------- Codex ----------

fn usage_event(u: &Value, uid: String, ts: i64, meta: &Value) -> Event {
    let input_total = i(u, "input_tokens");
    let cached = i(u, "cached_input_tokens");
    let cw = i(u, "cache_write_input_tokens");
    Event {
        uid,
        source: "codex",
        ts,
        session: s(meta, "session"),
        project: s(meta, "cwd"),
        model: {
            let m = s(meta, "model");
            if m.is_empty() { "unknown".into() } else { m }
        },
        // OpenAI reports cached and cache-write tokens inside input_tokens.
        input: (input_total - cached - cw).max(0),
        cache_write_5m: cw,
        cache_write_1h: 0,
        cache_read: cached,
        output: i(u, "output_tokens"),
        reasoning: i(u, "reasoning_output_tokens"),
        web_search: 0,
        fast: false,
    }
}

fn codex_limits(ctx: &mut Ctx, rl: &Value, ts: i64) {
    let limit_id = {
        let id = s(rl, "limit_id");
        if id.is_empty() { "codex".to_string() } else { id }
    };
    let plan = s(rl, "plan_type");
    for win in ["primary", "secondary"] {
        let Some(w) = rl.get(win).filter(|w| w.is_object()) else { continue };
        let Some(pct) = w.get("used_percent").and_then(|x| x.as_f64()) else { continue };
        let window_minutes = i(w, "window_minutes");
        let resets_at = match w.get("resets_at").and_then(parse_ts) {
            Some(r) => r,
            None => {
                let secs = w
                    .get("resets_in_seconds")
                    .or_else(|| w.get("resets_after_seconds"))
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0);
                if secs > 0 { ts + secs * 1000 } else { 0 }
            }
        };
        ctx.limits.offer(
            ctx.conn,
            LimitSnap {
                source: "codex",
                limit_id: limit_id.clone(),
                win: win.into(),
                ts,
                used_pct: pct,
                window_minutes,
                resets_at,
                plan: plan.clone(),
            },
        );
    }
}

fn codex_line(ctx: &mut Ctx, line: &[u8], meta: &mut Value) {
    const KEYS: [&[u8]; 4] = [
        b"\"type\":\"token_usage_record\"",
        b"\"type\":\"token_count\"",
        b"\"type\":\"turn_context\"",
        b"\"type\":\"session_meta\"",
    ];
    if !KEYS.iter().any(|k| memmem::find(line, k).is_some()) {
        return;
    }
    let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
    let ts = v.get("timestamp").and_then(parse_ts).unwrap_or(0);
    let outer = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let Some(p) = v.get("payload") else { return };
    let inner = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match (outer, inner) {
        ("session_meta", _) => {
            let id = s(p, "id");
            let id = if id.is_empty() { s(p, "session_id") } else { id };
            if !id.is_empty() && s(meta, "session").is_empty() {
                meta["session"] = json!(id);
            }
            let cwd = s(p, "cwd");
            if !cwd.is_empty() {
                meta["cwd"] = json!(cwd);
            }
        }
        ("turn_context", _) => {
            let m = s(p, "model");
            if !m.is_empty() {
                if s(meta, "model").is_empty() {
                    // Subagent logs can report usage before their first turn_context;
                    // back-fill those rows (they are re-priced at the end of the scan).
                    let _ = ctx.conn.execute(
                        "UPDATE events SET model=?1, priced=0 WHERE source='codex' AND session=?2 AND model='unknown'",
                        params![m, s(meta, "session")],
                    );
                }
                meta["model"] = json!(m);
            }
            let cwd = s(p, "cwd");
            if !cwd.is_empty() {
                meta["cwd"] = json!(cwd);
            }
        }
        (_, "token_usage_record") => {
            if s(meta, "session").is_empty() {
                meta["session"] = json!(s(p, "session_id"));
            }
            if !meta.get("has_records").and_then(|x| x.as_bool()).unwrap_or(false) {
                // Older logs only had cumulative token_count events; once per-response
                // records appear, drop the coarse fallback rows for this session.
                let _ = ctx.conn.execute(
                    "DELETE FROM events WHERE source='codex' AND session=?1 AND uid LIKE 'codex:tc:%'",
                    params![s(meta, "session")],
                );
                meta["has_records"] = json!(true);
            }
            let Some(u) = p.get("usage") else { return };
            let rid = s(p, "response_id");
            let rid = if rid.is_empty() { format!("{}:{}", s(p, "turn_id"), ts) } else { rid };
            let e = usage_event(u, format!("codex:{rid}"), ts, meta);
            ctx.add(e);
        }
        (_, "token_count") => {
            if let Some(rl) = p.get("rate_limits").filter(|x| x.is_object()) {
                codex_limits(ctx, rl, ts);
            }
            if meta.get("has_records").and_then(|x| x.as_bool()).unwrap_or(false) {
                return;
            }
            let Some(info) = p.get("info").filter(|x| x.is_object()) else { return };
            let (Some(last), Some(total)) = (info.get("last_token_usage"), info.get("total_token_usage")) else {
                return;
            };
            let cum = i(total, "total_tokens");
            let first = !meta.get("tc_seen").and_then(|x| x.as_bool()).unwrap_or(false);
            meta["tc_seen"] = json!(true);
            if first && cum != i(last, "total_tokens") {
                return; // forked/resumed session: totals carried over from the parent
            }
            let uid = format!("codex:tc:{}:{}", s(meta, "session"), cum);
            let e = usage_event(last, uid, ts, meta);
            ctx.add(e);
        }
        _ => {}
    }
}

// ---------- driver ----------

fn process_lines<R: BufRead>(
    reader: &mut R,
    mut on_line: impl FnMut(&[u8]),
    mut on_progress: impl FnMut(u64),
) -> std::io::Result<u64> {
    let mut consumed: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut since_report: u64 = 0;
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 || buf.last() != Some(&b'\n') {
            break; // EOF or a partial line still being written
        }
        consumed += n as u64;
        since_report += n as u64;
        on_line(&buf);
        if since_report > 64 * 1024 * 1024 {
            on_progress(since_report);
            since_report = 0;
        }
        if buf.capacity() > 16 * 1024 * 1024 {
            buf = Vec::with_capacity(64 * 1024); // don't keep a giant buffer around
        }
    }
    on_progress(since_report);
    Ok(consumed)
}

fn scan_target(
    conn: &mut Connection,
    t: &Target,
    pricing: &Pricing,
    limits: &mut LimitDedup,
    progress: &mut dyn FnMut(u64),
) -> Result<usize, String> {
    let key = t.path.to_string_lossy().to_string();
    let prev: Option<(i64, i64, i64, String)> = conn
        .query_row(
            "SELECT offset, size, mtime, meta FROM files WHERE path=?1",
            params![key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();
    let zst = key.ends_with(".zst");
    let (mut offset, mut meta): (u64, Value) = match &prev {
        Some((off, size, mtime, meta)) => {
            if *size as u64 == t.size && *mtime == t.mtime {
                progress(t.size);
                return Ok(0); // unchanged
            }
            if zst || (t.size as i64) < *off {
                (0, json!({})) // rewritten / truncated: start over
            } else {
                (*off as u64, serde_json::from_str(meta).unwrap_or(json!({})))
            }
        }
        None => (0, json!({})),
    };
    progress(offset); // already-ingested part counts as done

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut ctx = Ctx { conn: &tx, pricing, limits, new_events: 0 };
    let file = File::open(&t.path).map_err(|e| e.to_string())?;
    let kind = t.kind;
    let mut handle = |line: &[u8]| match kind {
        Kind::Claude => claude_line(&mut ctx, line),
        Kind::Codex => codex_line(&mut ctx, line, &mut meta),
        Kind::ClaudeLimits => claude_limits_line(&mut ctx, line),
    };
    if zst {
        let mut data = Vec::new();
        zstd::stream::read::Decoder::new(file)
            .and_then(|mut d| d.read_to_end(&mut data))
            .map_err(|e| e.to_string())?;
        let mut r = BufReader::new(&data[..]);
        process_lines(&mut r, &mut handle, |_| {}).map_err(|e| e.to_string())?;
        offset = t.size;
        progress(t.size);
    } else {
        let mut f = file;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut r = BufReader::with_capacity(1 << 20, f);
        let n = process_lines(&mut r, &mut handle, |b| progress(b)).map_err(|e| e.to_string())?;
        offset += n;
    }
    let added = ctx.new_events;
    // A partially written trailing line means the file isn't fully consumed yet; store
    // the real size only when we reached the end so the next scan resumes correctly.
    let stored_size = if offset == t.size { t.size as i64 } else { -1 };
    tx.execute(
        "INSERT INTO files(path, offset, size, mtime, meta) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(path) DO UPDATE SET offset=excluded.offset, size=excluded.size,
             mtime=excluded.mtime, meta=excluded.meta",
        params![key, offset as i64, stored_size, t.mtime, meta.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

/// Scans every known log file. `report` is called with progress snapshots.
pub fn run_scan(db_path: &Path, report: &mut dyn FnMut(&ScanStatus)) -> ScanStatus {
    let started = std::time::Instant::now();
    let mut st = ScanStatus { running: true, ..Default::default() };
    let mut conn = match db::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            st.running = false;
            st.last_error = e.to_string();
            return st;
        }
    };
    // Bumped when parsing learns something new from old lines; forces one full re-read
    // (events are upserted, so re-reading never double counts).
    const SCAN_VERSION: &str = "2";
    if db::get_setting(&conn, "scan_version").as_deref() != Some(SCAN_VERSION) {
        let _ = conn.execute("DELETE FROM files", []);
        let _ = db::set_setting(&conn, "scan_version", SCAN_VERSION);
    }
    let pricing = load_pricing(&conn);
    // When the user hasn't customised prices, re-price everything once whenever the
    // built-in defaults change between app versions.
    if db::get_setting(&conn, "pricing").is_none() {
        let defaults = serde_json::to_string(&pricing).unwrap_or_default();
        if db::get_setting(&conn, "pricing_defaults_applied").as_deref() != Some(defaults.as_str()) {
            if recompute_costs(&mut conn, &pricing).is_ok() {
                let _ = db::set_setting(&conn, "pricing_defaults_applied", &defaults);
            }
        }
    }
    let mut limits = LimitDedup::load(&conn);
    let mut targets = collect_targets();
    // Oldest first so limit snapshots arrive roughly in time order; limits file last.
    targets.sort_by_key(|t| (t.kind == Kind::ClaudeLimits, t.mtime));
    st.files_total = targets.len();
    st.bytes_total = targets.iter().map(|t| t.size).sum();
    report(&st);

    let mut last_report = std::time::Instant::now();
    for t in &targets {
        st.current = t.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let base_done = st.bytes_done;
        let mut file_done: u64 = 0;
        let mut progress = |b: u64| {
            file_done += b;
            if last_report.elapsed().as_millis() > 300 {
                let mut snap = st.clone();
                snap.bytes_done = base_done + file_done.min(t.size);
                report(&snap);
                last_report = std::time::Instant::now();
            }
        };
        match scan_target(&mut conn, t, &pricing, &mut limits, &mut progress) {
            Ok(n) => st.new_events += n,
            Err(e) => st.last_error = format!("{}: {}", t.path.display(), e),
        }
        st.bytes_done = base_done + t.size;
        st.files_done += 1;
    }
    if let Err(e) = reprice_unpriced(&mut conn, &pricing) {
        st.last_error = e.to_string();
    }
    st.running = false;
    st.current.clear();
    st.last_scan_ms = chrono::Utc::now().timestamp_millis();
    st.last_duration_ms = started.elapsed().as_millis() as i64;
    report(&st);
    st
}

/// User-edited table if any, otherwise the newest default (remote or built-in).
pub fn load_pricing(conn: &Connection) -> Pricing {
    db::get_setting(conn, "pricing")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| crate::remote::default_pricing(conn))
}

/// Re-price every stored event (after the user edits the price table).
pub fn recompute_costs(conn: &mut Connection, pricing: &Pricing) -> rusqlite::Result<()> {
    reprice(conn, pricing, "")
}

fn reprice_unpriced(conn: &mut Connection, pricing: &Pricing) -> rusqlite::Result<()> {
    reprice(conn, pricing, "WHERE priced = 0")
}

fn reprice(conn: &mut Connection, pricing: &Pricing, filter: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare(&format!(
            "SELECT uid, model, input, cache_write_5m, cache_write_1h, cache_read, output, web_search, fast FROM events {filter}"
        ))?;
        let rows: Vec<Event> = st
            .query_map([], |r| {
                Ok(Event {
                    uid: r.get(0)?,
                    model: r.get(1)?,
                    input: r.get(2)?,
                    cache_write_5m: r.get(3)?,
                    cache_write_1h: r.get(4)?,
                    cache_read: r.get(5)?,
                    output: r.get(6)?,
                    web_search: r.get(7)?,
                    fast: r.get::<_, i64>(8)? != 0,
                    ..Default::default()
                })
            })?
            .flatten()
            .collect();
        let mut up = tx.prepare("UPDATE events SET cost=?2, priced=?3 WHERE uid=?1")?;
        for e in rows {
            let (c, p) = pricing.cost(&e);
            up.execute(params![e.uid, c, p as i64])?;
        }
    }
    tx.commit()
}
