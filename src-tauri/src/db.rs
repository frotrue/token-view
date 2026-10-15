use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS events (
             uid TEXT PRIMARY KEY,
             source TEXT NOT NULL,
             ts INTEGER NOT NULL,
             session TEXT NOT NULL DEFAULT '',
             project TEXT NOT NULL DEFAULT '',
             model TEXT NOT NULL DEFAULT '',
             input INTEGER NOT NULL DEFAULT 0,
             cache_write_5m INTEGER NOT NULL DEFAULT 0,
             cache_write_1h INTEGER NOT NULL DEFAULT 0,
             cache_read INTEGER NOT NULL DEFAULT 0,
             output INTEGER NOT NULL DEFAULT 0,
             reasoning INTEGER NOT NULL DEFAULT 0,
             web_search INTEGER NOT NULL DEFAULT 0,
             fast INTEGER NOT NULL DEFAULT 0,
             cost REAL NOT NULL DEFAULT 0,
             priced INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
         CREATE INDEX IF NOT EXISTS idx_events_session ON events(source, session);
         CREATE TABLE IF NOT EXISTS files (
             path TEXT PRIMARY KEY,
             offset INTEGER NOT NULL,
             size INTEGER NOT NULL,
             mtime INTEGER NOT NULL,
             meta TEXT NOT NULL DEFAULT '{}'
         );
         CREATE TABLE IF NOT EXISTS limits (
             source TEXT NOT NULL,
             limit_id TEXT NOT NULL,
             win TEXT NOT NULL,
             ts INTEGER NOT NULL,
             used_pct REAL NOT NULL,
             window_minutes INTEGER NOT NULL,
             resets_at INTEGER NOT NULL,
             plan TEXT NOT NULL DEFAULT '',
             PRIMARY KEY (source, limit_id, win, ts)
         );
         CREATE TABLE IF NOT EXISTS settings (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         -- 0.3.0-beta.1 stored the OAuth usage array's duplicate names next to the
         -- flat ones (five_hour/seven_day), showing every Claude limit twice.
         DELETE FROM limits WHERE source='claude' AND (win='session' OR win LIKE 'weekly%');",
    )?;
    Ok(conn)
}

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// One normalized usage record, regardless of which tool produced it.
#[derive(Debug, Default, Clone)]
pub struct Event {
    pub uid: String,
    pub source: &'static str,
    pub ts: i64,
    pub session: String,
    pub project: String,
    pub model: String,
    pub input: i64,
    pub cache_write_5m: i64,
    pub cache_write_1h: i64,
    pub cache_read: i64,
    pub output: i64,
    pub reasoning: i64,
    pub web_search: i64,
    pub fast: bool,
}

pub fn upsert_event(conn: &Connection, e: &Event, cost: f64, priced: bool) -> rusqlite::Result<()> {
    // Claude Code writes several lines per API response while streaming; keep the
    // largest counts seen for the same response id.
    conn.execute(
        "INSERT INTO events(uid, source, ts, session, project, model, input, cache_write_5m,
             cache_write_1h, cache_read, output, reasoning, web_search, fast, cost, priced)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
         ON CONFLICT(uid) DO UPDATE SET
             input=max(input, excluded.input),
             cache_write_5m=max(cache_write_5m, excluded.cache_write_5m),
             cache_write_1h=max(cache_write_1h, excluded.cache_write_1h),
             cache_read=max(cache_read, excluded.cache_read),
             output=max(output, excluded.output),
             reasoning=max(reasoning, excluded.reasoning),
             web_search=max(web_search, excluded.web_search),
             cost=max(cost, excluded.cost)",
        params![
            e.uid,
            e.source,
            e.ts,
            e.session,
            e.project,
            e.model,
            e.input,
            e.cache_write_5m,
            e.cache_write_1h,
            e.cache_read,
            e.output,
            e.reasoning,
            e.web_search,
            e.fast as i64,
            cost,
            priced as i64
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct LimitSnap {
    pub source: &'static str,
    pub limit_id: String,
    pub win: String,
    pub ts: i64,
    pub used_pct: f64,
    pub window_minutes: i64,
    pub resets_at: i64,
    pub plan: String,
}

pub fn insert_limit(conn: &Connection, s: &LimitSnap) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO limits(source, limit_id, win, ts, used_pct, window_minutes, resets_at, plan)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![s.source, s.limit_id, s.win, s.ts, s.used_pct, s.window_minutes, s.resets_at, s.plan],
    )?;
    Ok(())
}
