//! Aggregations handed to the UI. Everything is bucketed in local time.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

const TOKENS: &str = "sum(input), sum(cache_write_5m + cache_write_1h), sum(cache_read), sum(output), sum(reasoning), sum(cost), count(*)";

fn tok_row(r: &rusqlite::Row, start: usize) -> rusqlite::Result<Value> {
    let input: i64 = r.get::<_, Option<i64>>(start)?.unwrap_or(0);
    let cw: i64 = r.get::<_, Option<i64>>(start + 1)?.unwrap_or(0);
    let cr: i64 = r.get::<_, Option<i64>>(start + 2)?.unwrap_or(0);
    let out: i64 = r.get::<_, Option<i64>>(start + 3)?.unwrap_or(0);
    let reasoning: i64 = r.get::<_, Option<i64>>(start + 4)?.unwrap_or(0);
    let cost: f64 = r.get::<_, Option<f64>>(start + 5)?.unwrap_or(0.0);
    let n: i64 = r.get(start + 6)?;
    Ok(json!({
        "input": input, "cacheWrite": cw, "cacheRead": cr, "output": out,
        "reasoning": reasoning, "cost": cost, "requests": n,
    }))
}

fn query(conn: &Connection, sql: &str, keys: &[&str], p: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<Vec<Value>> {
    let mut st = conn.prepare(sql)?;
    let rows = st.query_map(p, |r| {
        let mut v = tok_row(r, keys.len())?;
        for (idx, k) in keys.iter().enumerate() {
            let val: rusqlite::types::Value = r.get(idx)?;
            v[*k] = match val {
                rusqlite::types::Value::Integer(i) => json!(i),
                rusqlite::types::Value::Real(f) => json!(f),
                rusqlite::types::Value::Text(s) => json!(s),
                _ => Value::Null,
            };
        }
        Ok(v)
    })?;
    Ok(rows.flatten().collect())
}

pub fn dashboard(conn: &Connection) -> rusqlite::Result<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    let day = "date(ts/1000, 'unixepoch', 'localtime')";

    let totals = query(
        conn,
        &format!("SELECT source, min(ts), max(ts), {TOKENS} FROM events GROUP BY source"),
        &["source", "firstTs", "lastTs"],
        &[],
    )?;
    let daily = query(
        conn,
        &format!("SELECT {day} AS d, source, {TOKENS} FROM events GROUP BY d, source ORDER BY d"),
        &["date", "source"],
        &[],
    )?;
    let daily_model = query(
        conn,
        &format!("SELECT {day} AS d, source, model, {TOKENS} FROM events GROUP BY d, source, model ORDER BY d"),
        &["date", "source", "model"],
        &[],
    )?;
    let daily_project = query(
        conn,
        &format!(
            "SELECT {day} AS d, source, project, {TOKENS} FROM events GROUP BY d, source, project ORDER BY d"
        ),
        &["date", "source", "project"],
        &[],
    )?;
    // Hourly buckets (epoch ms of the hour start) for the last 35 days: pace + patterns.
    let since = now - 35 * 86_400_000;
    let hourly = query(
        conn,
        &format!("SELECT (ts / 3600000) * 3600000 AS h, source, {TOKENS} FROM events WHERE ts >= ?1 GROUP BY h, source ORDER BY h"),
        &["hour", "source"],
        &[&since],
    )?;
    // 10-minute buckets for the last 35 days: relate limit % to spend and find
    // when Claude's 5-hour windows started.
    let since8 = now - 35 * 86_400_000;
    let fine = query(
        conn,
        &format!("SELECT (ts / 600000) * 600000 AS b, source, {TOKENS} FROM events WHERE ts >= ?1 GROUP BY b, source ORDER BY b"),
        &["t", "source"],
        &[&since8],
    )?;

    let sessions = query(
        conn,
        &format!(
            "SELECT source, session, max(project), min(ts) AS first, max(ts), group_concat(DISTINCT model), {TOKENS}
             FROM events WHERE ts >= ?1 AND session != '' GROUP BY source, session ORDER BY first DESC LIMIT 500"
        ),
        &["source", "session", "project", "firstTs", "lastTs", "models"],
        &[&since],
    )?;

    let mut st = conn.prepare(
        "SELECT source, limit_id, win, ts, used_pct, window_minutes, resets_at, plan
         FROM limits WHERE ts >= ?1 ORDER BY ts",
    )?;
    let limits: Vec<Value> = st
        .query_map(params![now - 35 * 86_400_000], |r| {
            Ok(json!({
                "source": r.get::<_, String>(0)?,
                "limitId": r.get::<_, String>(1)?,
                "win": r.get::<_, String>(2)?,
                "ts": r.get::<_, i64>(3)?,
                "usedPct": r.get::<_, f64>(4)?,
                "windowMinutes": r.get::<_, i64>(5)?,
                "resetsAt": r.get::<_, i64>(6)?,
                "plan": r.get::<_, String>(7)?,
            }))
        })?
        .flatten()
        .collect();

    let mut st = conn.prepare(
        "SELECT source, model, count(*), sum(input + cache_write_5m + cache_write_1h + cache_read + output)
         FROM events WHERE priced = 0 GROUP BY source, model",
    )?;
    let unpriced: Vec<Value> = st
        .query_map([], |r| {
            Ok(json!({
                "source": r.get::<_, String>(0)?,
                "model": r.get::<_, String>(1)?,
                "requests": r.get::<_, i64>(2)?,
                "tokens": r.get::<_, i64>(3)?,
            }))
        })?
        .flatten()
        .collect();

    Ok(json!({
        "now": now,
        "totals": totals,
        "daily": daily,
        "dailyModel": daily_model,
        "dailyProject": daily_project,
        "hourly": hourly,
        "fine": fine,
        "sessions": sessions,
        "limits": limits,
        "unpriced": unpriced,
    }))
}
