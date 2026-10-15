//! Snapshot sanitizing: only allowlisted aggregate fields leave the PC. No paths,
//! raw logs, provider tokens or raw error text.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const SHARED_KEYS: [&str; 5] = [
    "currency",
    "krwRate",
    "monthlyBudget",
    "budgetClaude",
    "budgetCodex",
];

pub fn shared_settings(ui: &Value) -> Value {
    let defaults = json!({"currency":"USD", "krwRate":1400, "monthlyBudget":null, "budgetClaude":null, "budgetCodex":null});
    let mut out = Map::new();
    for key in SHARED_KEYS {
        let v = ui.get(key).unwrap_or(&defaults[key]);
        let valid = match key {
            "currency" => v.as_str().is_some_and(|s| matches!(s, "USD" | "KRW")),
            "krwRate" => v.as_f64().is_some_and(|n| n > 0.0 && n <= 1e6),
            _ => v.is_null() || v.as_f64().is_some_and(|n| (0.0..=1e9).contains(&n)),
        };
        out.insert(
            key.into(),
            if valid {
                v.clone()
            } else {
                defaults[key].clone()
            },
        );
    }
    Value::Object(out)
}
pub fn valid_shared(v: &Value) -> bool {
    v.as_object().is_some_and(|m| {
        m.len() == SHARED_KEYS.len() && SHARED_KEYS.iter().all(|k| m.contains_key(*k))
    }) && shared_settings(v) == *v
}
pub fn hex_digest(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn suspicious_text(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    s.chars().any(char::is_control)
        || s.starts_with('/')
        || s.starts_with('\\')
        || s.starts_with('~')
        || s.as_bytes().get(1) == Some(&b':')
        || s.contains("\\")
        || lower.contains("bearer ")
        || lower.contains("sk-ant-")
        || lower.contains("sk-proj-")
        || lower.starts_with("sk-")
        || lower.contains("access_token")
        || lower.contains("refresh_token")
        || s.split('.').count() == 3 && s.starts_with("eyJ")
}
fn safe_text(v: Option<&Value>, fallback: &str, max: usize) -> Value {
    json!(v
        .and_then(Value::as_str)
        .filter(|s| s.chars().count() <= max && !suspicious_text(s))
        .unwrap_or(fallback))
}
pub fn project_label(v: &Value) -> String {
    let text = v.as_str().unwrap_or("");
    if text.is_empty() {
        return String::new();
    }
    let leaf = text
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("");
    let leaf = if leaf.is_empty() || suspicious_text(leaf) {
        "Project"
    } else {
        leaf
    };
    format!(
        "{} [{}]",
        leaf.chars().take(80).collect::<String>(),
        &hex_digest(text)[..8]
    )
}
fn pick_numbers(v: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .map(|key| {
            (
                (*key).into(),
                v.get(*key)
                    .filter(|n| n.is_number() || n.is_null())
                    .cloned()
                    .unwrap_or(json!(0)),
            )
        })
        .collect()
}
const TOKEN_KEYS: [&str; 7] = [
    "input",
    "cacheWrite",
    "cacheRead",
    "output",
    "reasoning",
    "cost",
    "requests",
];
pub fn dashboard_payload(v: &Value, device: &str) -> Value {
    let mut out = Map::new();
    let now = v.get("now").and_then(Value::as_i64).unwrap_or(0);
    out.insert("now".into(), json!(now));
    // The desktop keeps a sliding 35-day window, so rows would fall off every few
    // minutes and defeat change detection. Cut at a UTC day boundary instead.
    let cutoff = if now > 0 {
        (now - 34 * 86_400_000).div_euclid(86_400_000) * 86_400_000
    } else {
        0
    };
    for (group, nums, texts) in [
        ("totals", vec!["firstTs", "lastTs"], vec!["source"]),
        ("daily", vec![], vec!["date", "source"]),
        ("dailyModel", vec![], vec!["date", "source", "model"]),
        ("dailyProject", vec![], vec!["date", "source", "project"]),
        ("hourly", vec!["hour"], vec!["source"]),
        ("fine", vec!["t"], vec!["source"]),
        (
            "sessions",
            vec!["firstTs", "lastTs"],
            vec!["source", "session", "project", "models"],
        ),
        (
            "limits",
            vec!["ts", "usedPct", "windowMinutes", "resetsAt"],
            vec!["source", "limitId", "win", "plan"],
        ),
        (
            "unpriced",
            vec!["requests", "tokens"],
            vec!["source", "model"],
        ),
    ] {
        let rows = v
            .get(group)
            .and_then(Value::as_array)
            .map(|rows| {
                let time_key = match group {
                    "fine" => Some("t"),
                    "hourly" => Some("hour"),
                    "limits" => Some("ts"),
                    "sessions" => Some("lastTs"),
                    _ => None,
                };
                rows.iter()
                    .filter(|row| {
                        time_key.is_none_or(|k| {
                            row.get(k).and_then(Value::as_i64).unwrap_or(0) >= cutoff
                        })
                    })
                    .map(|row| {
                        let mut result = if matches!(group, "limits" | "unpriced") {
                            Map::new()
                        } else {
                            pick_numbers(row, &TOKEN_KEYS)
                        };
                        result.extend(pick_numbers(row, &nums));
                        for key in &texts {
                            let value = match *key {
                                "project" => {
                                    json!(project_label(row.get(*key).unwrap_or(&Value::Null)))
                                }
                                "session" => json!(hex_digest(&format!(
                                    "{device}:{}:{}",
                                    row.get("source").and_then(Value::as_str).unwrap_or(""),
                                    row.get(*key).and_then(Value::as_str).unwrap_or("")
                                ))),
                                _ => safe_text(
                                    row.get(*key),
                                    "",
                                    if *key == "models" { 512 } else { 256 },
                                ),
                            };
                            result.insert((*key).into(), value);
                        }
                        Value::Object(result)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        out.insert(group.into(), json!(rows));
    }
    Value::Object(out)
}
fn codex_info(v: &Value) -> Value {
    let mut out = pick_numbers(v, &["ts", "resetCredits"]);
    for k in ["planType", "reached"] {
        out.insert(
            k.into(),
            if v.get(k).is_none_or(Value::is_null) {
                Value::Null
            } else {
                safe_text(v.get(k), "", 128)
            },
        );
    }
    if let Some(credits) = v.get("credits").filter(|v| v.is_object()) {
        let mut c = Map::new();
        for k in ["hasCredits", "unlimited"] {
            if let Some(n) = credits.get(k).and_then(Value::as_bool) {
                c.insert(k.into(), json!(n));
            }
        }
        if let Some(balance) = credits
            .get("balance")
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 64 && s.parse::<f64>().is_ok())
        {
            c.insert("balance".into(), json!(balance));
        }
        out.insert("credits".into(), Value::Object(c));
    }
    Value::Object(out)
}
pub fn live_payload(v: &Value) -> Value {
    let mut out = Map::new();
    for k in ["claude", "codex"] {
        if let Some(r) = v.get(k) {
            if r.is_null() {
                out.insert(k.into(), Value::Null);
                continue;
            }
            let mut result = pick_numbers(r, &["ts"]);
            result.insert(
                "ok".into(),
                json!(r.get("ok").and_then(Value::as_bool).unwrap_or(false)),
            );
            if let Some(t) = r.get("lastOk").and_then(Value::as_i64).filter(|t| *t > 0) {
                result.insert("lastOk".into(), json!(t));
            }
            if let Some(reason) = r.get("reason").and_then(Value::as_str).filter(|s| {
                matches!(*s, "rate_limited" | "expired" | "no_login" | "format" | "http" | "network")
            }) {
                result.insert("reason".into(), json!(reason));
            }
            if let Some(info) = r.get("info").filter(|v| v.is_object()) {
                let mut i = if k == "codex" {
                    codex_info(info).as_object().unwrap().clone()
                } else {
                    Map::new()
                };
                if let Some(w) = info.get("windows").and_then(Value::as_u64) {
                    i.insert("windows".into(), json!(w));
                }
                result.insert("info".into(), Value::Object(i));
            }
            out.insert(k.into(), Value::Object(result));
        }
    }
    if let Some(v) = v.get("codexInfo").filter(|v| v.is_object()) {
        out.insert("codexInfo".into(), codex_info(v));
    }
    if let Some(status) = v.get("status") {
        if status.is_null() {
            out.insert("status".into(), Value::Null);
        } else {
            let pages = status.get("pages").and_then(Value::as_array).map(|rows| rows.iter().filter_map(|p| {
                let id = p.get("id").and_then(Value::as_str)?;
                let (name, url) = match id { "claude" => ("Claude", "https://status.claude.com"), "openai" => ("OpenAI", "https://status.openai.com"), _ => return None };
                let indicator = p.get("indicator").and_then(Value::as_str).filter(|s| matches!(*s, "none" | "minor" | "major" | "critical" | "maintenance" | "unknown")).unwrap_or("unknown");
                Some(json!({"id":id,"name":name,"url":url,"indicator":indicator,"description":safe_text(p.get("description"),"Status unavailable",512)}))
            }).collect::<Vec<_>>()).unwrap_or_default();
            out.insert("status".into(), json!({"ts": status.get("ts").and_then(Value::as_i64).unwrap_or(0), "pages": pages}));
        }
    }
    Value::Object(out)
}
pub fn pricing_payload(v: &Value) -> Value {
    let p = &v["pricing"];
    let entries = p
        .get("entries")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    let mut r = pick_numbers(
                        row,
                        &[
                            "input",
                            "output",
                            "cache_write_5m",
                            "cache_write_1h",
                            "cache_read",
                            "long_ctx_threshold",
                            "long_input_mult",
                            "long_output_mult",
                        ],
                    );
                    r.insert("model".into(), safe_text(row.get("model"), "", 256));
                    Value::Object(r)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({"pricing":{"version":safe_text(p.get("version"),"",128),"entries":entries,"fast_mult":p.get("fast_mult").and_then(Value::as_f64).unwrap_or(1.0),"web_search_usd":p.get("web_search_usd").and_then(Value::as_f64).unwrap_or(0.0)},
        "custom":v.get("custom").and_then(Value::as_bool).unwrap_or(false),"defaultVersion":safe_text(v.get("defaultVersion"),"",128),"builtinVersion":safe_text(v.get("builtinVersion"),"",128),"remoteUrl":crate::remote::PRICING_URL})
}

/// The complete sanitized snapshot (schema v1, shared with the mobile reader).
#[allow(clippy::too_many_arguments)]
pub fn snapshot(
    device_id: &str,
    device_name: &str,
    captured_at: i64,
    dashboard: &Value,
    pricing: &Value,
    settings: &Value,
    live: &Value,
    hooked: bool,
) -> Value {
    json!({"schemaVersion":1,"device":{"id":device_id,"name":device_name},"capturedAt":captured_at,
        "timezone":iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into()),
        "dashboard":dashboard_payload(dashboard, device_id),"pricing":pricing_payload(pricing),
        "settings":shared_settings(settings),"live":live_payload(live),"claudeHooked":hooked})
}

/// Content identity without capture/query timestamps: equal fingerprints mean the
/// mobile view would be identical, so only a tiny "still checked" mark is needed.
pub fn fingerprint(payload: &Value) -> String {
    fn strip_ts(v: &mut Value) {
        match v {
            Value::Object(m) => {
                m.remove("ts");
                m.values_mut().for_each(strip_ts);
            }
            Value::Array(a) => a.iter_mut().for_each(strip_ts),
            _ => {}
        }
    }
    let mut v = payload.clone();
    if let Some(m) = v.as_object_mut() {
        m.remove("capturedAt");
    }
    if let Some(d) = v.get_mut("dashboard").and_then(Value::as_object_mut) {
        d.remove("now");
    }
    if let Some(live) = v.get_mut("live") {
        strip_ts(live);
    }
    hex_digest(&v.to_string())
}

pub fn gzip(payload: &Value) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    let _ = enc.write_all(payload.to_string().as_bytes());
    enc.finish().unwrap_or_default()
}
