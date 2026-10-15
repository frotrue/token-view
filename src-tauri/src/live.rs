//! Live data that doesn't come from session logs: current plan limits straight from
//! Claude / Codex, and the public status pages of both services.

use crate::db::{self, LimitSnap};
use crate::scan::home;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn ts_of(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis()),
        Value::Number(n) => n.as_f64().map(|x| if x < 1e11 { (x * 1000.0) as i64 } else { x as i64 }),
        _ => None,
    }
}

/// Insert unless the latest stored value for this window is identical and recent.
fn store(conn: &Connection, s: &LimitSnap) {
    let last: Option<(f64, i64, i64)> = conn
        .query_row(
            "SELECT used_pct, resets_at, ts FROM limits WHERE source=?1 AND limit_id=?2 AND win=?3 ORDER BY ts DESC LIMIT 1",
            params![s.source, s.limit_id, s.win],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();
    if let Some((pct, resets, ts)) = last {
        if (pct - s.used_pct).abs() < 0.01 && (resets - s.resets_at).abs() < 120_000 && s.ts - ts < 15 * 60_000 {
            return;
        }
    }
    let _ = db::insert_limit(conn, s);
}

fn window_minutes(name: &str) -> i64 {
    if name.contains("five_hour") || name.contains("5h") || name.contains("session") {
        300
    } else if name.contains("seven_day") || name.contains("week") {
        10080
    } else {
        0
    }
}

// ---------- Claude: OAuth usage endpoint (opt-in) ----------

fn claude_credentials() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if let Some(first) = d.split([',', ';']).map(str::trim).find(|s| !s.is_empty()) {
            return std::path::PathBuf::from(first).join(".credentials.json");
        }
    }
    home().join(".claude").join(".credentials.json")
}

/// Reads Claude Code's own login token (never stored or sent anywhere but Anthropic)
/// and asks Anthropic for the current 5-hour / weekly utilisation.
/// Windows in an OAuth usage response. The response carries the same limits twice:
/// as flat objects (`five_hour`, `seven_day`, `seven_day_opus`, …) and as a `limits`
/// array (`session`, `weekly_all`, …). Array kinds are mapped onto the flat names
/// (which the statusline and history also use) and each window is kept once.
fn usage_windows(v: &Value) -> Vec<(String, i64, f64, Option<i64>)> {
    let mut out: Vec<(String, i64, f64, Option<i64>)> = Vec::new();
    let mut add = |name: &str, pct: f64, resets: Option<i64>| {
        let wm = window_minutes(name);
        if wm > 0 && !out.iter().any(|(n, ..)| n == name) {
            out.push((name.to_owned(), wm, pct, resets));
        }
    };
    if let Some(obj) = v.as_object() {
        for (k, w) in obj {
            if let Some(p) = w.get("utilization").and_then(|p| p.as_f64()) {
                add(k, p, w.get("resets_at").and_then(ts_of));
            }
        }
    }
    if let Some(arr) = v.get("limits").and_then(|l| l.as_array()) {
        for l in arr {
            let kind = l.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            let name = match kind {
                "session" => "five_hour".to_owned(),
                "weekly_all" | "weekly" => "seven_day".to_owned(),
                k if k.starts_with("weekly_") => format!("seven_day_{}", &k["weekly_".len()..]),
                k => k.to_owned(),
            };
            if let Some(p) = l.get("percent").or_else(|| l.get("utilization")).and_then(|p| p.as_f64()) {
                add(&name, p, l.get("resets_at").and_then(ts_of));
            }
        }
    }
    out
}

pub fn claude_usage(conn: &Connection) -> Result<usize, String> {
    let text = std::fs::read_to_string(claude_credentials())
        .map_err(|_| "Claude Code 로그인 정보를 찾지 못했어요".to_string())?;
    let cred: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let oauth = cred.get("claudeAiOauth").ok_or("Claude Code에 구독 계정으로 로그인돼 있지 않아요")?;
    let token = oauth.get("accessToken").and_then(|t| t.as_str()).ok_or("토큰 없음")?;
    if let Some(exp) = oauth.get("expiresAt").and_then(|e| e.as_i64()) {
        if exp < chrono::Utc::now().timestamp_millis() {
            return Err("로그인 토큰이 만료됐어요. Claude Code를 한 번 실행하면 갱신돼요".into());
        }
    }
    let mut resp = agent(15)
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", &format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "token-view")
        .call()
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if status != 200 {
        return Err(format!("Anthropic 응답 {status}"));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let mut n = 0;
    for (name, minutes, pct, resets) in usage_windows(&v) {
        store(
            conn,
            &LimitSnap {
                source: "claude",
                limit_id: "claude".into(),
                win: name,
                ts: now,
                used_pct: pct,
                window_minutes: minutes,
                resets_at: resets.unwrap_or(0),
                plan: String::new(),
            },
        );
        n += 1;
    }
    if n == 0 {
        return Err("응답에서 한도 정보를 찾지 못했어요".into());
    }
    Ok(n)
}

// ---------- Codex: local app-server JSON-RPC ----------

fn codex_command() -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `codex` is usually an npm .cmd shim, which only cmd can launch.
        let mut c = Command::new("cmd");
        c.args(["/D", "/C", "codex", "app-server"]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("codex");
        c.arg("app-server");
        c
    }
}

/// Asks the locally installed Codex for the account's current rate limits.
pub fn codex_limits(conn: &Connection) -> Result<Value, String> {
    let mut child = codex_command()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Codex CLI를 실행하지 못했어요".to_string())?;
    let mut stdin = child.stdin.take().ok_or("stdin")?;
    let stdout = child.stdout.take().ok_or("stdout")?;
    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("id").and_then(|i| i.as_i64()) == Some(2) {
                    let _ = tx.send(v);
                    break;
                }
            }
        }
    });
    let msgs = [
        json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "token-view", "version": env!("CARGO_PKG_VERSION")}}}),
        json!({"method": "initialized"}),
        json!({"id": 2, "method": "account/rateLimits/read", "params": null}),
    ];
    for m in msgs {
        let _ = writeln!(stdin, "{m}");
    }
    let _ = stdin.flush();
    let reply = rx.recv_timeout(Duration::from_secs(25));
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let reply = reply.map_err(|_| "Codex 응답 시간 초과".to_string())?;
    let result = reply.get("result").ok_or_else(|| format!("Codex 오류: {}", reply.get("error").unwrap_or(&Value::Null)))?;

    let now = chrono::Utc::now().timestamp_millis();
    let buckets: Vec<Value> = match result.get("rateLimitsByLimitId").and_then(|b| b.as_object()) {
        Some(m) if !m.is_empty() => m.values().cloned().collect(),
        _ => result.get("rateLimits").cloned().into_iter().collect(),
    };
    for b in &buckets {
        let limit_id = b.get("limitId").and_then(|x| x.as_str()).unwrap_or("codex").to_string();
        let plan = b.get("planType").and_then(|x| x.as_str()).unwrap_or("").to_string();
        for win in ["primary", "secondary"] {
            let Some(w) = b.get(win).filter(|w| w.is_object()) else { continue };
            let Some(pct) = w.get("usedPercent").and_then(|x| x.as_f64()) else { continue };
            store(
                conn,
                &LimitSnap {
                    source: "codex",
                    limit_id: limit_id.clone(),
                    win: win.into(),
                    ts: now,
                    used_pct: pct,
                    window_minutes: w.get("windowDurationMins").and_then(|x| x.as_i64()).unwrap_or(0),
                    resets_at: w.get("resetsAt").and_then(ts_of).unwrap_or(0),
                    plan: plan.clone(),
                },
            );
        }
    }
    let main = result.get("rateLimits").cloned().unwrap_or(Value::Null);
    let info = json!({
        "ts": now,
        "planType": main.get("planType"),
        "credits": main.get("credits"),
        "resetCredits": result.pointer("/rateLimitResetCredits/availableCount"),
        "reached": main.get("rateLimitReachedType"),
    });
    let _ = db::set_setting(conn, "codex_live", &info.to_string());
    Ok(info)
}

// ---------- service status pages ----------

pub fn service_status() -> Value {
    let pages = [
        ("claude", "Claude", "https://status.claude.com/api/v2/status.json", "https://status.claude.com"),
        ("openai", "OpenAI", "https://status.openai.com/api/v2/status.json", "https://status.openai.com"),
    ];
    let a = agent(10);
    let list: Vec<Value> = pages
        .iter()
        .map(|(id, name, api, url)| {
            let st = a
                .get(*api)
                .call()
                .ok()
                .and_then(|mut r| r.body_mut().read_to_string().ok())
                .and_then(|b| serde_json::from_str::<Value>(&b).ok());
            json!({
                "id": id,
                "name": name,
                "url": url,
                "indicator": st.as_ref().and_then(|s| s.pointer("/status/indicator")).and_then(|x| x.as_str()).unwrap_or("unknown"),
                "description": st.as_ref().and_then(|s| s.pointer("/status/description")).and_then(|x| x.as_str()).unwrap_or("확인 실패"),
            })
        })
        .collect();
    json!({ "ts": chrono::Utc::now().timestamp_millis(), "pages": list })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_response_windows_are_counted_once_under_the_flat_names() {
        let v = json!({
            "five_hour": {"utilization": 22.0, "resets_at": "2026-10-15T08:59:00Z"},
            "seven_day": {"utilization": 41.0, "resets_at": "2026-10-17T13:59:00Z"},
            "seven_day_opus": null,
            "limits": [
                {"kind": "session", "percent": 22.0, "resets_at": "2026-10-15T08:59:00Z"},
                {"kind": "weekly_all", "percent": 41.0},
                {"kind": "weekly_sonnet", "percent": 12.0}
            ]
        });
        let w = usage_windows(&v);
        let names: Vec<&str> = w.iter().map(|x| x.0.as_str()).collect();
        assert_eq!(names, ["five_hour", "seven_day", "seven_day_sonnet"]);
        assert_eq!((w[0].1, w[1].1), (300, 10080));
        assert!(w[0].3.is_some());
        // An array-only response still works.
        let only = usage_windows(&json!({"limits": [{"kind": "session", "percent": 5.0}]}));
        assert_eq!(only[0].0, "five_hour");
    }
}
