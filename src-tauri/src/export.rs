//! CSV / JSON export of the stored usage history.

use rusqlite::Connection;
use std::io::Write;
use std::path::Path;

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn write_rows(conn: &Connection, sql: &str, header: &[&str], path: &Path) -> Result<usize, String> {
    let mut f = std::io::BufWriter::new(std::fs::File::create(path).map_err(|e| e.to_string())?);
    // BOM so Excel opens UTF-8 (Korean project names) correctly.
    f.write_all(b"\xEF\xBB\xBF").map_err(|e| e.to_string())?;
    writeln!(f, "{}", header.join(",")).map_err(|e| e.to_string())?;
    let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
    let cols = st.column_count();
    let mut rows = st.query([]).map_err(|e| e.to_string())?;
    let mut n = 0;
    while let Some(r) = rows.next().map_err(|e| e.to_string())? {
        let mut line = Vec::with_capacity(cols);
        for i in 0..cols {
            let v: rusqlite::types::Value = r.get(i).map_err(|e| e.to_string())?;
            line.push(match v {
                rusqlite::types::Value::Integer(x) => x.to_string(),
                rusqlite::types::Value::Real(x) => format!("{x:.6}"),
                rusqlite::types::Value::Text(s) => csv_field(&s),
                _ => String::new(),
            });
        }
        writeln!(f, "{}", line.join(",")).map_err(|e| e.to_string())?;
        n += 1;
    }
    f.flush().map_err(|e| e.to_string())?;
    Ok(n)
}

pub fn export(conn: &Connection, kind: &str, path: &Path) -> Result<usize, String> {
    match kind {
        "events" => write_rows(
            conn,
            "SELECT datetime(ts/1000,'unixepoch','localtime'), source, model, project, session, input,
                    cache_write_5m + cache_write_1h, cache_read, output, reasoning, round(cost, 6)
             FROM events ORDER BY ts",
            &["time", "source", "model", "project", "session", "input", "cache_write", "cache_read", "output", "reasoning", "cost_usd"],
            path,
        ),
        "daily" => write_rows(
            conn,
            "SELECT date(ts/1000,'unixepoch','localtime') AS d, source, model, count(*), sum(input),
                    sum(cache_write_5m + cache_write_1h), sum(cache_read), sum(output), sum(reasoning), round(sum(cost), 6)
             FROM events GROUP BY d, source, model ORDER BY d, source, model",
            &["date", "source", "model", "requests", "input", "cache_write", "cache_read", "output", "reasoning", "cost_usd"],
            path,
        ),
        "json" => {
            let v = crate::stats::dashboard(conn).map_err(|e| e.to_string())?;
            std::fs::write(path, serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            Ok(1)
        }
        _ => Err(format!("unknown export kind {kind}")),
    }
}
