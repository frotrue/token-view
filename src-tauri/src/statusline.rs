//! Claude Code exposes plan usage (5h / weekly %) only to its status line command, so
//! Token View can install itself as that command. It records the `rate_limits` it is
//! given, then prints whatever the user's previous status line printed.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn tv_dir() -> PathBuf {
    crate::scan::home().join(".token-view")
}

fn saved_original_path() -> PathBuf {
    tv_dir().join("statusline-original.json")
}

pub fn claude_settings_path() -> PathBuf {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if let Some(first) = d.split([',', ';']).map(str::trim).find(|s| !s.is_empty()) {
            return PathBuf::from(first).join("settings.json");
        }
    }
    crate::scan::home().join(".claude").join("settings.json")
}

fn our_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Claude Code runs status line commands through a shell; forward slashes and quotes
    // keep paths with spaces working in both bash and cmd.
    Ok(format!("\"{}\" --statusline", exe.to_string_lossy().replace('\\', "/")))
}

fn is_ours(cmd: &str) -> bool {
    cmd.contains("--statusline") && cmd.to_lowercase().contains("token-view")
}

fn read_settings() -> Result<Value, String> {
    let p = claude_settings_path();
    match std::fs::read_to_string(&p) {
        Ok(s) if !s.trim().is_empty() => serde_json::from_str(&s).map_err(|e| format!("{}: {e}", p.display())),
        Ok(_) => Ok(json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.to_string()),
    }
}

fn write_settings(v: &Value) -> Result<(), String> {
    let p = claude_settings_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let backup = p.with_file_name("settings.json.bak-tokenview");
    if p.exists() && !backup.exists() {
        std::fs::copy(&p, &backup).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&p, text).map_err(|e| e.to_string())
}

pub fn status() -> Value {
    let settings = read_settings().unwrap_or_else(|_| json!({}));
    let cmd = settings
        .pointer("/statusLine/command")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let original = std::fs::read_to_string(saved_original_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    json!({
        "settingsPath": claude_settings_path().to_string_lossy(),
        "command": cmd,
        "connected": is_ours(&cmd),
        "original": original,
    })
}

pub fn connect() -> Result<Value, String> {
    let mut settings = read_settings()?;
    if !settings.is_object() {
        return Err("settings.json is not a JSON object".into());
    }
    let current = settings.get("statusLine").cloned().unwrap_or(Value::Null);
    let current_cmd = current.get("command").and_then(|c| c.as_str()).unwrap_or("");
    let mut line = if current.is_object() { current.clone() } else { json!({ "type": "command" }) };
    if !is_ours(current_cmd) {
        // Remember the previous status line so we can chain to it and restore it later.
        std::fs::create_dir_all(tv_dir()).map_err(|e| e.to_string())?;
        std::fs::write(saved_original_path(), serde_json::to_string_pretty(&current).unwrap())
            .map_err(|e| e.to_string())?;
    }
    line["type"] = json!("command");
    line["command"] = json!(our_command()?);
    settings["statusLine"] = line;
    write_settings(&settings)?;
    Ok(status())
}

pub fn disconnect() -> Result<Value, String> {
    let mut settings = read_settings()?;
    let original = std::fs::read_to_string(saved_original_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    if let Some(obj) = settings.as_object_mut() {
        if original.is_object() {
            obj.insert("statusLine".into(), original);
        } else {
            obj.remove("statusLine");
        }
    }
    write_settings(&settings)?;
    let _ = std::fs::remove_file(saved_original_path());
    Ok(status())
}

fn record(input: &Value) {
    let Some(rl) = input.get("rate_limits").filter(|r| r.is_object()) else { return };
    let dir = tv_dir();
    let sig = rl.to_string();
    let last_file = dir.join("claude-rate-limits.last");
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(prev) = std::fs::read_to_string(&last_file) {
        if let Some((ts, prev_sig)) = prev.split_once(' ') {
            let fresh = ts.parse::<i64>().map(|t| now - t < 10 * 60_000).unwrap_or(false);
            if fresh && prev_sig == sig {
                return;
            }
        }
    }
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("claude-rate-limits.jsonl"))
    {
        let _ = writeln!(f, "{}", json!({ "ts": now, "rate_limits": rl }));
    }
    let _ = std::fs::write(last_file, format!("{now} {sig}"));
}

fn run_original(cmd: &str, input: &[u8]) -> Option<String> {
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.raw_arg(format!("/D /S /C \"{cmd}\""));
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(windows))]
    let mut c = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(cmd);
        c
    };
    let mut child = c
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input);
    }
    let out = child.wait_with_output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Built-in line used when there was no previous status line: model | dir | usage.
fn builtin_line(d: &Value) -> String {
    let model = d
        .pointer("/model/display_name")
        .or_else(|| d.pointer("/model/id"))
        .and_then(|v| v.as_str())
        .unwrap_or("Claude");
    let mut dir = d
        .pointer("/workspace/current_dir")
        .or_else(|| d.get("cwd"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .replace('\\', "/");
    let home = crate::scan::home().to_string_lossy().replace('\\', "/");
    if !home.is_empty() && dir.to_lowercase().starts_with(&home.to_lowercase()) {
        dir = format!("~{}", &dir[home.len()..]);
    }
    let mut usage = vec![];
    for (key, label) in [("five_hour", "5h"), ("seven_day", "7d")] {
        if let Some(p) = d.pointer(&format!("/rate_limits/{key}/used_percentage")).and_then(|v| v.as_f64()) {
            usage.push(format!("{label} {}%", p.round()));
        }
    }
    [model.to_string(), dir, usage.join(" ")]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
}

/// Entry point for `token-view --statusline`.
pub fn run() {
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    let input: Value = serde_json::from_slice(&raw).unwrap_or(json!({}));
    record(&input);
    let original_cmd = std::fs::read_to_string(saved_original_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("command").and_then(|c| c.as_str()).map(String::from))
        .filter(|c| !c.trim().is_empty() && !is_ours(c));
    let text = original_cmd
        .and_then(|c| run_original(&c, &raw))
        .unwrap_or_else(|| builtin_line(&input));
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}
