//! Private, optional Supabase publication. Only the worker touches sessions/network.
//! Scanner handoff is a single latest-value slot: slow/offline cloud never blocks it.
use crate::db;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

const CONFIG_KEY: &str = "cloud_config";
const DIRTY_KEY: &str = "cloud_dirty_settings";
const MIN_UPLOAD: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_secs(30);
const MAX_PAYLOAD: usize = 4 * 1024 * 1024;
const SHARED_KEYS: [&str; 5] = [
    "currency",
    "krwRate",
    "monthlyBudget",
    "budgetClaude",
    "budgetCodex",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    url: String,
    anon_key: String,
    device_id: String,
    device_name: String,
    enabled: bool,
    // A nonsecret tombstone also prevents a failed credential deletion restoring login.
    #[serde(default = "yes")]
    signed_out: bool,
}
fn yes() -> bool {
    true
}
impl Default for Config {
    fn default() -> Self {
        Self {
            url: String::new(),
            anon_key: String::new(),
            device_id: Uuid::new_v4().to_string(),
            device_name: "My PC".into(),
            enabled: false,
            signed_out: true,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudStatus {
    configured: bool,
    enabled: bool,
    url: String,
    anon_key: String,
    device_id: String,
    device_name: String,
    email: Option<String>,
    authenticated: bool,
    last_upload_at: Option<i64>,
    last_error: Option<String>,
    persistent_session: bool,
}
impl DesktopCloudStatus {
    fn new(config: &Config) -> Self {
        Self {
            configured: !config.url.is_empty(),
            enabled: config.enabled,
            url: config.url.clone(),
            anon_key: config.anon_key.clone(),
            device_id: config.device_id.clone(),
            device_name: config.device_name.clone(),
            email: None,
            authenticated: false,
            last_upload_at: None,
            last_error: None,
            persistent_session: cfg!(windows),
        }
    }
}

// Deliberately no Debug implementation: these values never belong in errors/logs/IPC.
#[derive(Clone, Serialize, Deserialize)]
struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    user_id: String,
    email: Option<String>,
}
impl Session {
    fn from_response(v: &Value, now: i64) -> Result<Self, String> {
        let token = |key: &str| {
            v.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 16384 && !s.chars().any(char::is_control))
                .map(str::to_owned)
                .ok_or_else(|| "Invalid cloud sign-in response".to_string())
        };
        let user_id = v
            .pointer("/user/id")
            .and_then(Value::as_str)
            .filter(|s| Uuid::parse_str(s).is_ok())
            .ok_or("Invalid cloud sign-in response")?;
        let expires_at = match v.get("expires_at").and_then(Value::as_i64) {
            Some(sec) => sec.checked_mul(1000),
            None => v
                .get("expires_in")
                .and_then(Value::as_i64)
                .filter(|sec| *sec > 0 && *sec <= 31_536_000)
                .and_then(|sec| now.checked_add(sec * 1000)),
        }
        .filter(|ts| *ts > now)
        .ok_or("Invalid cloud session expiry")?;
        Ok(Self {
            access_token: token("access_token")?,
            refresh_token: token("refresh_token")?,
            expires_at,
            user_id: user_id.into(),
            email: v
                .pointer("/user/email")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 320 && !s.chars().any(char::is_control))
                .map(str::to_owned),
        })
    }
    fn needs_refresh(&self, now: i64) -> bool {
        self.expires_at <= now.saturating_add(60_000)
    }
}

trait SessionStore: Send {
    fn load(&self, config: &Config) -> Result<Option<Session>, String>;
    fn save(&self, config: &Config, session: &Session) -> Result<(), String>;
    fn clear(&self, config: &Config) -> Result<(), String>;
}
struct NativeStore;
#[cfg(windows)]
impl NativeStore {
    fn entry(config: &Config) -> Result<keyring::Entry, String> {
        let digest = hex_digest(&config.url);
        keyring::Entry::new(
            "com.tokenview.monitor.cloud",
            &format!("{}:{digest}", config.device_id),
        )
        .map_err(|_| "Windows credential storage is unavailable".into())
    }
}
#[cfg(windows)]
impl SessionStore for NativeStore {
    fn load(&self, config: &Config) -> Result<Option<Session>, String> {
        match Self::entry(config)?.get_password() {
            Ok(s) => serde_json::from_str(&s)
                .map(Some)
                .map_err(|_| "Saved cloud session is invalid; sign in again".into()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Could not read Windows cloud credentials".into()),
        }
    }
    fn save(&self, config: &Config, session: &Session) -> Result<(), String> {
        let s = serde_json::to_string(session).map_err(|_| "Could not encode cloud credentials")?;
        Self::entry(config)?
            .set_password(&s)
            .map_err(|_| "Could not save Windows cloud credentials".into())
    }
    fn clear(&self, config: &Config) -> Result<(), String> {
        match Self::entry(config)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove Windows cloud credentials".into()),
        }
    }
}
#[cfg(not(windows))]
impl SessionStore for NativeStore {
    fn load(&self, _: &Config) -> Result<Option<Session>, String> {
        Ok(None)
    }
    fn save(&self, _: &Config, _: &Session) -> Result<(), String> {
        Ok(())
    }
    fn clear(&self, _: &Config) -> Result<(), String> {
        Ok(())
    }
}

// Persist rotated refresh tokens before using them. Failure drops authentication,
// rather than continuing with credentials that cannot survive an app restart.
fn install_session(
    store: &dyn SessionStore,
    config: &Config,
    slot: &mut Option<Session>,
    next: Session,
) -> Result<(), String> {
    if let Err(e) = store.save(config, &next) {
        *slot = None;
        let _ = store.clear(config);
        return Err(e);
    }
    *slot = Some(next);
    Ok(())
}

fn validate_config(url: &str, key: &str, name: &str) -> Result<(String, String, String), String> {
    let mut parsed = url::Url::parse(url.trim()).map_err(|_| "Enter a valid Supabase URL")?;
    let local = parsed
        .host_str()
        .is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if parsed.scheme() != "https" && !(cfg!(debug_assertions) && local && parsed.scheme() == "http")
    {
        return Err("Cloud backend must use HTTPS".into());
    }
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err("Use a Supabase base URL without credentials, path, query, or fragment".into());
    }
    parsed.set_path("");
    let key = key.trim();
    if key.len() < 20
        || key.len() > 4096
        || !key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
    {
        return Err("Enter a public Supabase anon or publishable key".into());
    }
    let publishable = key.starts_with("sb_publishable_");
    let legacy_anon = key.split('.').count() == 3
        && key
            .split('.')
            .nth(1)
            .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("role").and_then(Value::as_str).map(|r| r == "anon"))
            .unwrap_or(false);
    if !publishable && !legacy_anon {
        return Err("Use a public anon or publishable key; secret keys are not allowed".into());
    }
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > 128
        || name.chars().any(char::is_control)
        || suspicious_text(name)
    {
        return Err("Device name must be 1–128 characters without paths or credentials".into());
    }
    Ok((
        parsed.as_str().trim_end_matches('/').into(),
        key.into(),
        name.into(),
    ))
}

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
fn valid_shared(v: &Value) -> bool {
    v.as_object().is_some_and(|m| {
        m.len() == SHARED_KEYS.len() && SHARED_KEYS.iter().all(|k| m.contains_key(*k))
    }) && shared_settings(v) == *v
}
fn hex_digest(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn suspicious_text(s: &str) -> bool {
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
fn project_label(v: &Value) -> String {
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
fn dashboard_payload(v: &Value, device: &str) -> Value {
    let mut out = Map::new();
    out.insert(
        "now".into(),
        json!(v.get("now").and_then(Value::as_i64).unwrap_or(0)),
    );
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
                rows.iter()
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
fn live_payload(v: &Value) -> Value {
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
fn pricing_payload(v: &Value) -> Value {
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

pub struct SnapshotContext {
    generation: u64,
    pub device_id: String,
    pub device_name: String,
}
#[derive(Clone)]
pub struct RefreshRequest {
    requested_at: String,
    generation: u64,
}
struct Envelope {
    payload: Value,
    captured_at: i64,
    generation: u64,
    force: bool,
    refresh: Option<RefreshRequest>,
}
struct Shared {
    status: Mutex<DesktopCloudStatus>,
    latest: Mutex<Option<Envelope>>,
    refresh: Mutex<Option<RefreshRequest>>,
    force_next: AtomicBool,
    generation: AtomicU64,
    settings_generation: AtomicU64,
    settings_write: Mutex<()>,
    identity: Mutex<Option<(String, String)>>,
}
#[derive(Clone)]
pub struct CloudSync {
    shared: Arc<Shared>,
    tx: mpsc::Sender<Command>,
    db_path: PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
struct DirtySettings {
    backend: String,
    user_id: String,
    settings: Value,
}
type Reply = mpsc::Sender<Result<DesktopCloudStatus, String>>;
enum Command {
    Wake,
    Configure {
        url: String,
        key: String,
        name: String,
        enabled: bool,
        reply: Reply,
    },
    SignIn {
        email: String,
        password: String,
        reply: Reply,
    },
    SignOut(Reply),
    Settings(DirtySettings),
}

impl CloudSync {
    pub fn start(
        db_path: PathBuf,
        scan_trigger: mpsc::Sender<()>,
        notify: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        let config = db::open(&db_path)
            .ok()
            .and_then(|c| db::get_setting(&c, CONFIG_KEY))
            .and_then(|s| serde_json::from_str::<Config>(&s).ok())
            .filter(|c| Uuid::parse_str(&c.device_id).is_ok())
            .unwrap_or_default();
        let config = if config.url.is_empty()
            || validate_config(&config.url, &config.anon_key, &config.device_name).is_ok()
        {
            config
        } else {
            Config::default()
        };
        // Persist the device UUID even before cloud setup; no credentials live here.
        if let Ok(c) = db::open(&db_path) {
            let _ = db::set_setting(&c, CONFIG_KEY, &serde_json::to_string(&config).unwrap());
        }
        let shared = Arc::new(Shared {
            status: Mutex::new(DesktopCloudStatus::new(&config)),
            latest: Mutex::new(None),
            refresh: Mutex::new(None),
            force_next: AtomicBool::new(false),
            generation: AtomicU64::new(1),
            settings_generation: AtomicU64::new(0),
            settings_write: Mutex::new(()),
            identity: Mutex::new(None),
        });
        let (tx, rx) = mpsc::channel();
        let handle = Self {
            shared: shared.clone(),
            tx,
            db_path: db_path.clone(),
        };
        std::thread::spawn(move || {
            Worker::new(config, db_path, scan_trigger, shared, notify).run(rx)
        });
        handle
    }
    pub fn status(&self) -> DesktopCloudStatus {
        self.shared.status.lock().unwrap().clone()
    }
    pub fn settings_lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.shared.settings_write.lock().unwrap()
    }
    pub fn snapshot_context(&self) -> Option<SnapshotContext> {
        let status = self.shared.status.lock().unwrap();
        (status.enabled && status.authenticated).then(|| SnapshotContext {
            generation: self.shared.generation.load(Ordering::SeqCst),
            device_id: status.device_id.clone(),
            device_name: status.device_name.clone(),
        })
    }
    pub fn take_refresh_request(&self) -> Option<RefreshRequest> {
        self.shared
            .refresh
            .lock()
            .unwrap()
            .take()
            .filter(|request| {
                chrono::DateTime::parse_from_rfc3339(&request.requested_at)
                    .ok()
                    .is_some_and(|ts| {
                        let now = chrono::Utc::now().timestamp_millis();
                        (now - 600_000..=now + 30_000).contains(&ts.timestamp_millis())
                    })
            })
    }
    pub fn return_refresh_request(&self, request: Option<RefreshRequest>) {
        if let Some(request) =
            request.filter(|r| r.generation == self.shared.generation.load(Ordering::SeqCst))
        {
            let mut slot = self.shared.refresh.lock().unwrap();
            if slot.is_none() {
                *slot = Some(request);
            }
        }
    }
    pub fn publish(
        &self,
        context: SnapshotContext,
        captured_at: i64,
        dashboard: Value,
        pricing: Value,
        settings: Value,
        live: Value,
        hooked: bool,
        refresh: Option<RefreshRequest>,
    ) {
        let payload = json!({"schemaVersion":1,"device":{"id":context.device_id,"name":context.device_name},"capturedAt":captured_at,
            "timezone":iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into()), "dashboard":dashboard_payload(&dashboard,&context.device_id),
            "pricing":pricing_payload(&pricing),"settings":shared_settings(&settings),"live":live_payload(&live),"claudeHooked":hooked});
        let mut latest = self.shared.latest.lock().unwrap();
        let previous = latest.take();
        let force = self.shared.force_next.swap(false, Ordering::SeqCst)
            || refresh.is_some()
            || previous
                .as_ref()
                .is_some_and(|p| p.generation == context.generation && p.force);
        let refresh = refresh
            .filter(|r| r.generation == context.generation)
            .or_else(|| {
                previous
                    .and_then(|p| p.refresh)
                    .filter(|r| r.generation == context.generation)
            });
        *latest = Some(Envelope {
            payload,
            captured_at,
            generation: context.generation,
            force,
            refresh,
        });
        drop(latest);
        let _ = self.tx.send(Command::Wake);
    }
    pub fn sync_now(&self, scan_trigger: &mpsc::Sender<()>) -> Result<DesktopCloudStatus, String> {
        let status = self.status();
        if !status.configured || !status.enabled || !status.authenticated {
            return Err("Configure, enable, and sign in to cloud sync first".into());
        }
        self.shared.force_next.store(true, Ordering::SeqCst);
        let _ = scan_trigger.send(());
        Ok(status)
    }
    pub fn settings_changed(&self, ui: &Value) -> Result<(), String> {
        self.shared
            .settings_generation
            .fetch_add(1, Ordering::SeqCst);
        let identity = self.shared.identity.lock().unwrap().clone();
        if let Some((backend, user_id)) = identity {
            let dirty = DirtySettings {
                backend,
                user_id,
                settings: shared_settings(ui),
            };
            let conn =
                db::open(&self.db_path).map_err(|_| "Could not queue cloud display settings")?;
            db::set_setting(&conn, DIRTY_KEY, &serde_json::to_string(&dirty).unwrap())
                .map_err(|_| "Could not queue cloud display settings")?;
            let _ = self.tx.send(Command::Settings(dirty));
        }
        Ok(())
    }
    fn request(
        &self,
        command: impl FnOnce(Reply) -> Command,
    ) -> Result<DesktopCloudStatus, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(command(tx))
            .map_err(|_| "Cloud worker is unavailable")?;
        rx.recv().map_err(|_| "Cloud worker is unavailable")?
    }
    pub fn configure(
        &self,
        url: String,
        key: String,
        name: String,
        enabled: bool,
    ) -> Result<DesktopCloudStatus, String> {
        // Validate before queueing too, keeping malformed requests off the worker.
        validate_config(&url, &key, &name)?;
        self.request(|reply| Command::Configure {
            url,
            key,
            name,
            enabled,
            reply,
        })
    }
    pub fn sign_in(&self, email: String, password: String) -> Result<DesktopCloudStatus, String> {
        if email.trim().is_empty()
            || email.len() > 320
            || email.chars().any(char::is_control)
            || password.is_empty()
            || password.len() > 4096
        {
            return Err("Enter an email address and password".into());
        }
        self.request(|reply| Command::SignIn {
            email,
            password,
            reply,
        })
    }
    pub fn sign_out(&self) -> Result<DesktopCloudStatus, String> {
        self.request(Command::SignOut)
    }
}

struct Worker {
    config: Config,
    session: Option<Session>,
    store: Box<dyn SessionStore>,
    db_path: PathBuf,
    scan_trigger: mpsc::Sender<()>,
    shared: Arc<Shared>,
    notify: Arc<dyn Fn(&str) + Send + Sync>,
    agent: ureq::Agent,
    pending: Option<Envelope>,
    pending_settings: Option<Value>,
    acknowledge: Option<RefreshRequest>,
    last_upload: Option<Instant>,
    last_capture: Option<i64>,
    next_poll: Instant,
    next_attempt: Instant,
    failures: u32,
    last_requested_at: Option<String>,
}
impl Worker {
    fn new(
        config: Config,
        db_path: PathBuf,
        scan_trigger: mpsc::Sender<()>,
        shared: Arc<Shared>,
        notify: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(12)))
            .max_redirects(0)
            .http_status_as_error(false)
            .build()
            .into();
        let mut w = Self {
            config,
            session: None,
            store: Box::new(NativeStore),
            db_path,
            scan_trigger,
            shared,
            notify,
            agent,
            pending: None,
            pending_settings: None,
            acknowledge: None,
            last_upload: None,
            last_capture: None,
            next_poll: Instant::now(),
            next_attempt: Instant::now(),
            failures: 0,
            last_requested_at: None,
        };
        if !w.config.signed_out {
            match w.store.load(&w.config) {
                Ok(Some(s))
                    if Uuid::parse_str(&s.user_id).is_ok()
                        && !s.access_token.is_empty()
                        && !s.refresh_token.is_empty() =>
                {
                    w.session = Some(s)
                }
                Ok(_) => {}
                Err(e) => w.error(&e),
            }
        }
        w.update_status();
        w.pending_settings = w.read_dirty();
        w
    }
    fn persist_config(&self) -> Result<(), String> {
        let conn = db::open(&self.db_path).map_err(|_| "Could not save cloud configuration")?;
        db::set_setting(
            &conn,
            CONFIG_KEY,
            &serde_json::to_string(&self.config).unwrap(),
        )
        .map_err(|_| "Could not save cloud configuration".into())
    }
    fn update_status(&self) {
        *self.shared.identity.lock().unwrap() = self
            .session
            .as_ref()
            .filter(|_| self.config.enabled)
            .map(|s| (hex_digest(&self.config.url), s.user_id.clone()));
        let mut s = self.shared.status.lock().unwrap();
        s.configured = !self.config.url.is_empty();
        s.enabled = self.config.enabled;
        s.url = self.config.url.clone();
        s.anon_key = self.config.anon_key.clone();
        s.device_id = self.config.device_id.clone();
        s.device_name = self.config.device_name.clone();
        s.authenticated = self.session.is_some();
        s.email = self.session.as_ref().and_then(|s| s.email.clone());
        drop(s);
        (self.notify)("cloud-status");
    }
    fn error(&self, message: &str) {
        self.shared.status.lock().unwrap().last_error = Some(message.into());
        (self.notify)("cloud-status");
    }
    fn reset_context(&mut self) {
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        self.shared.latest.lock().unwrap().take();
        self.shared.refresh.lock().unwrap().take();
        self.shared.force_next.store(false, Ordering::SeqCst);
        self.pending = None;
        self.pending_settings = None;
        self.acknowledge = None;
        self.last_upload = None;
        self.last_capture = None;
        self.last_requested_at = None;
        self.failures = 0;
        self.next_attempt = Instant::now();
        self.next_poll = Instant::now();
        let mut s = self.shared.status.lock().unwrap();
        s.last_upload_at = None;
        s.last_error = None;
    }
    fn read_dirty(&self) -> Option<Value> {
        let session = self.session.as_ref()?;
        let conn = db::open(&self.db_path).ok()?;
        let dirty: DirtySettings =
            serde_json::from_str(&db::get_setting(&conn, DIRTY_KEY)?).ok()?;
        (dirty.backend == hex_digest(&self.config.url)
            && dirty.user_id == session.user_id
            && valid_shared(&dirty.settings))
        .then_some(dirty.settings)
    }
    fn settings_saved(&mut self, saved: &Value) -> Result<(), String> {
        let _guard = self.shared.settings_write.lock().unwrap();
        let current = self.read_dirty();
        if current.as_ref() == Some(saved) {
            let conn = db::open(&self.db_path)
                .map_err(|_| "Could not mark cloud display settings saved")?;
            conn.execute("DELETE FROM settings WHERE key=?1", [DIRTY_KEY])
                .map_err(|_| "Could not mark cloud display settings saved")?;
            self.pending_settings = None;
        } else {
            self.pending_settings = current;
        }
        Ok(())
    }
    fn raw_request(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        token: Option<&str>,
    ) -> Result<(u16, Value), String> {
        let url = format!("{}{path}", self.config.url);
        let authorization = format!("Bearer {}", token.unwrap_or(&self.config.anon_key));
        let mut response = if method == "GET" {
            self.agent
                .get(&url)
                .header("apikey", &self.config.anon_key)
                .header("Authorization", &authorization)
                .call()
        } else {
            self.agent
                .post(&url)
                .header("apikey", &self.config.anon_key)
                .header("Authorization", &authorization)
                .header("Content-Type", "application/json")
                .send(
                    body.map(Value::to_string)
                        .unwrap_or_else(|| "{}".into())
                        .as_bytes(),
                )
        }
        .map_err(|_| "Cloud backend could not be reached")?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Ok((status, Value::Null));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit(MAX_PAYLOAD as u64 + 65536)
            .read_to_vec()
            .map_err(|_| "Cloud response could not be read")?;
        // No response body or underlying transport error is propagated to UI/logs.
        if bytes.is_empty() {
            return Ok((status, Value::Null));
        }
        let value = serde_json::from_slice(&bytes)
            .map_err(|_| "Cloud backend returned an invalid response")?;
        Ok((status, value))
    }
    fn refresh_session(&mut self) -> Result<(), String> {
        let refresh = self
            .session
            .as_ref()
            .ok_or("Sign in to cloud sync again")?
            .refresh_token
            .clone();
        let (status, value) = self.raw_request(
            "POST",
            "/auth/v1/token?grant_type=refresh_token",
            Some(&json!({"refresh_token":refresh})),
            None,
        )?;
        if !(200..300).contains(&status) {
            if matches!(status, 400 | 401 | 403) {
                self.session = None;
                self.config.signed_out = true;
                let _ = self.persist_config();
                let _ = self.store.clear(&self.config);
                self.update_status();
                return Err("Cloud session expired; sign in again".into());
            }
            return Err(format!("Cloud session refresh failed (HTTP {status})"));
        }
        let next = Session::from_response(&value, chrono::Utc::now().timestamp_millis())?;
        if self
            .session
            .as_ref()
            .is_some_and(|s| s.user_id != next.user_id)
        {
            return Err("Cloud session identity changed; sign in again".into());
        }
        if let Err(e) = install_session(self.store.as_ref(), &self.config, &mut self.session, next)
        {
            self.config.signed_out = true;
            let _ = self.persist_config();
            self.update_status();
            return Err(e);
        }
        self.update_status();
        Ok(())
    }
    fn request(&mut self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        if self
            .session
            .as_ref()
            .ok_or("Sign in to cloud sync first")?
            .needs_refresh(chrono::Utc::now().timestamp_millis())
        {
            self.refresh_session()?;
        }
        let access = self.session.as_ref().unwrap().access_token.clone();
        let (mut status, mut value) = self.raw_request(method, path, body, Some(&access))?;
        if status == 401 {
            self.refresh_session()?;
            let access = self.session.as_ref().unwrap().access_token.clone();
            (status, value) = self.raw_request(method, path, body, Some(&access))?;
        }
        if !(200..300).contains(&status) {
            return Err(format!("Cloud request failed (HTTP {status})"));
        }
        Ok(value)
    }
    fn configure(
        &mut self,
        url: String,
        key: String,
        name: String,
        enabled: bool,
    ) -> Result<(), String> {
        let (url, anon_key, device_name) = validate_config(&url, &key, &name)?;
        let changed_backend = self.config.url != url || self.config.anon_key != anon_key;
        let old = self.config.clone();
        if changed_backend {
            self.config.signed_out = true;
            // Remove old credentials before changing the credential-store account.
            self.store.clear(&old)?;
            self.session = None;
        }
        self.config.url = url;
        self.config.anon_key = anon_key;
        self.config.device_name = device_name;
        self.config.enabled = enabled;
        if let Err(e) = self.persist_config() {
            self.config = old;
            self.update_status();
            return Err(e);
        }
        self.reset_context();
        self.update_status();
        self.pending_settings = self.read_dirty();
        if enabled && self.session.is_some() {
            self.shared.force_next.store(true, Ordering::SeqCst);
            let _ = self.scan_trigger.send(());
        }
        Ok(())
    }
    fn sign_in(&mut self, email: String, password: String) -> Result<(), String> {
        if self.config.url.is_empty() {
            return Err("Configure a cloud backend first".into());
        }
        let (status, value) = self.raw_request(
            "POST",
            "/auth/v1/token?grant_type=password",
            Some(&json!({"email":email.trim(),"password":password})),
            None,
        )?;
        if !(200..300).contains(&status) {
            return Err(if matches!(status, 400 | 401 | 403 | 422) {
                "Cloud sign-in failed; check your email, password, and email confirmation".into()
            } else {
                format!("Cloud sign-in failed (HTTP {status})")
            });
        }
        let next = Session::from_response(&value, chrono::Utc::now().timestamp_millis())?;
        if let Err(e) = install_session(self.store.as_ref(), &self.config, &mut self.session, next)
        {
            self.config.signed_out = true;
            let _ = self.persist_config();
            self.update_status();
            return Err(e);
        }
        self.config.signed_out = false;
        if let Err(e) = self.persist_config() {
            self.session = None;
            let _ = self.store.clear(&self.config);
            self.update_status();
            return Err(e);
        }
        self.reset_context();
        self.update_status();
        self.pending_settings = self.read_dirty();
        if self.config.enabled {
            self.shared.force_next.store(true, Ordering::SeqCst);
            let _ = self.scan_trigger.send(());
        }
        Ok(())
    }
    fn sign_out(&mut self) -> Result<(), String> {
        self.config.signed_out = true;
        // Persist the tombstone first, so keyring deletion failures cannot restore login.
        self.persist_config()?;
        let token = self.session.take().map(|s| s.access_token);
        let cleared = self.store.clear(&self.config);
        self.reset_context();
        self.update_status();
        if let Some(token) = token {
            let _ = self.raw_request("POST", "/auth/v1/logout?scope=local", None, Some(&token));
        }
        cleared
    }
    fn command(&mut self, command: Command) {
        match command {
            Command::Wake => {}
            Command::Settings(v) => {
                if self.config.enabled
                    && self
                        .session
                        .as_ref()
                        .is_some_and(|s| s.user_id == v.user_id)
                    && v.backend == hex_digest(&self.config.url)
                {
                    self.pending_settings = Some(v.settings);
                }
            }
            Command::Configure {
                url,
                key,
                name,
                enabled,
                reply,
            } => {
                let r = self.configure(url, key, name, enabled);
                self.reply(r, reply);
            }
            Command::SignIn {
                email,
                password,
                reply,
            } => {
                let r = self.sign_in(email, password);
                self.reply(r, reply);
            }
            Command::SignOut(reply) => {
                let r = self.sign_out();
                self.reply(r, reply);
            }
        }
    }
    fn reply(&mut self, result: Result<(), String>, reply: Reply) {
        if let Err(ref e) = result {
            self.error(e);
        }
        let status = self.shared.status.lock().unwrap().clone();
        let _ = reply.send(result.map(|_| status));
    }
    fn pull_settings(&mut self) -> Result<(), String> {
        let generation = self.shared.settings_generation.load(Ordering::SeqCst);
        let rows = self.request(
            "GET",
            "/rest/v1/user_settings?select=settings,updated_at&limit=1",
            None,
        )?;
        let rows = rows
            .as_array()
            .ok_or("Cloud settings response is invalid")?;
        let _settings_lock = self.shared.settings_write.lock().unwrap();
        let conn = db::open(&self.db_path).map_err(|_| "Could not open local display settings")?;
        let mut ui = db::get_setting(&conn, "ui")
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        if self.shared.settings_generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        if let Some(row) = rows.first() {
            let remote = row
                .get("settings")
                .filter(|v| valid_shared(v))
                .ok_or("Cloud display settings are invalid")?;
            if shared_settings(&ui) != *remote {
                for key in SHARED_KEYS {
                    ui[key] = remote[key].clone();
                }
                db::set_setting(&conn, "ui", &ui.to_string())
                    .map_err(|_| "Could not save cloud display settings")?;
                (self.notify)("cloud-settings-updated");
            }
        } else {
            self.pending_settings = Some(shared_settings(&ui));
        }
        Ok(())
    }
    fn poll_refresh(&mut self) -> Result<(), String> {
        let path = format!("/rest/v1/refresh_requests?select=requested_at,handled_at&device_id=eq.{}&handled_at=is.null&limit=1", self.config.device_id);
        let rows = self.request("GET", &path, None)?;
        let row = rows
            .as_array()
            .ok_or("Cloud refresh response is invalid")?
            .first();
        let Some(text) = row
            .and_then(|r| r.get("requested_at"))
            .and_then(Value::as_str)
        else {
            return Ok(());
        };
        let ts = chrono::DateTime::parse_from_rfc3339(text)
            .map_err(|_| "Cloud refresh timestamp is invalid")?
            .timestamp_millis();
        let now = chrono::Utc::now().timestamp_millis();
        if ts < now - 600_000
            || ts > now + 30_000
            || self.last_requested_at.as_deref() == Some(text)
        {
            return Ok(());
        }
        let request = RefreshRequest {
            requested_at: text.into(),
            generation: self.shared.generation.load(Ordering::SeqCst),
        };
        self.last_requested_at = Some(text.into());
        *self.shared.refresh.lock().unwrap() = Some(request);
        let _ = self.scan_trigger.send(());
        Ok(())
    }
    fn collect_latest(&mut self) {
        let Some(mut next) = self.shared.latest.lock().unwrap().take() else {
            return;
        };
        if next.generation != self.shared.generation.load(Ordering::SeqCst) {
            return;
        }
        if self
            .last_capture
            .is_some_and(|last| next.captured_at <= last)
        {
            return;
        }
        if let Some(previous) = self.pending.take() {
            if previous.captured_at > next.captured_at {
                self.pending = Some(previous);
                return;
            }
            next.force |= previous.force;
            if next.refresh.is_none() {
                next.refresh = previous.refresh;
            }
        }
        self.pending = Some(next);
    }
    fn acknowledge_refresh(&mut self) -> Result<(), String> {
        let Some(request) = self.acknowledge.clone() else {
            return Ok(());
        };
        let acknowledged = self.request("POST", "/rest/v1/rpc/acknowledge_refresh", Some(&json!({"p_device_id":self.config.device_id,"p_requested_at":request.requested_at})))?
            .as_bool().ok_or("Cloud refresh acknowledgement is invalid")?;
        self.acknowledge = None;
        if !acknowledged {
            // Expired/replaced requests may return false. Poll the authoritative row
            // again instead of silently treating this timestamp as handled.
            self.last_requested_at = None;
            self.next_poll = Instant::now();
        }
        Ok(())
    }
    fn work(&mut self) -> Result<(), String> {
        if let Some(settings) = self.pending_settings.clone() {
            self.request(
                "POST",
                "/rest/v1/rpc/save_user_settings",
                Some(&json!({"p_settings":settings})),
            )?;
            self.settings_saved(&settings)?;
            if self.pending_settings.is_some() {
                return Ok(());
            }
        }
        if Instant::now() >= self.next_poll {
            // Settings first; a request is consumed by the scanner before a local scan.
            self.pull_settings()?;
            self.poll_refresh()?;
            self.next_poll = Instant::now() + POLL_INTERVAL;
        }
        self.acknowledge_refresh()?;
        let upload = self
            .pending
            .as_ref()
            .is_some_and(|p| p.force || self.last_upload.is_none_or(|t| t.elapsed() >= MIN_UPLOAD));
        if !upload {
            return Ok(());
        }
        let pending = self.pending.take().unwrap();
        let bytes =
            serde_json::to_vec(&pending.payload).map_err(|_| "Could not encode cloud snapshot")?;
        if bytes.len() > MAX_PAYLOAD {
            return Err("Cloud snapshot exceeds the 4 MiB beta limit".into());
        }
        let captured = chrono::DateTime::from_timestamp_millis(pending.captured_at)
            .ok_or("Cloud snapshot timestamp is invalid")?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let result = self.request("POST","/rest/v1/rpc/publish_snapshot",Some(&json!({"p_device_id":self.config.device_id,"p_device_name":self.config.device_name,"p_captured_at":captured,"p_payload":pending.payload})))
            .and_then(|v| v.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.timestamp_millis()).ok_or_else(|| "Cloud upload response is invalid".to_string()));
        let uploaded_at = match result {
            Ok(uploaded_at) => uploaded_at,
            Err(e) => {
                self.pending = Some(pending);
                return Err(e);
            }
        };
        self.last_capture = Some(pending.captured_at);
        self.last_upload = Some(Instant::now());
        self.acknowledge = pending.refresh;
        let mut s = self.shared.status.lock().unwrap();
        s.last_upload_at = Some(uploaded_at);
        s.last_error = None;
        drop(s);
        (self.notify)("cloud-status");
        self.acknowledge_refresh()?;
        Ok(())
    }
    fn run(mut self, rx: mpsc::Receiver<Command>) {
        loop {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(c) => self.command(c),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            while let Ok(c) = rx.try_recv() {
                self.command(c);
            }
            self.collect_latest();
            if !self.config.enabled || self.session.is_none() || Instant::now() < self.next_attempt
            {
                continue;
            }
            match self.work() {
                Ok(()) => {
                    self.failures = 0;
                    self.next_attempt = Instant::now();
                }
                Err(e) => {
                    self.error(&e);
                    self.failures = self.failures.saturating_add(1);
                    self.next_attempt = Instant::now()
                        + Duration::from_secs((5 * 2u64.pow(self.failures.min(7) - 1)).min(300));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    const USER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const KEY: &str = "sb_publishable_test_public_key_1234567890";
    struct TestStore {
        saved: Arc<Mutex<Vec<String>>>,
        fail: bool,
    }
    impl SessionStore for TestStore {
        fn load(&self, _: &Config) -> Result<Option<Session>, String> {
            Ok(None)
        }
        fn save(&self, _: &Config, session: &Session) -> Result<(), String> {
            if self.fail {
                return Err("Credential storage unavailable".into());
            }
            self.saved
                .lock()
                .unwrap()
                .push(session.refresh_token.clone());
            Ok(())
        }
        fn clear(&self, _: &Config) -> Result<(), String> {
            Ok(())
        }
    }
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
            }
        }
    }
    fn session() -> Session {
        Session {
            access_token: "test-access-old".into(),
            refresh_token: "test-refresh-old".into(),
            expires_at: chrono::Utc::now().timestamp_millis() + 3600_000,
            user_id: USER.into(),
            email: Some("test@example.com".into()),
        }
    }
    fn fixture(url: &str) -> (CloudSync, Worker, Scratch) {
        let config = Config {
            url: url.into(),
            anon_key: KEY.into(),
            device_id: Uuid::new_v4().to_string(),
            device_name: "Test PC".into(),
            enabled: true,
            signed_out: true,
        };
        let path =
            std::env::temp_dir().join(format!("token-view-cloud-test-{}.db", Uuid::new_v4()));
        let shared = Arc::new(Shared {
            status: Mutex::new(DesktopCloudStatus::new(&config)),
            latest: Mutex::new(None),
            refresh: Mutex::new(None),
            force_next: AtomicBool::new(false),
            generation: AtomicU64::new(1),
            settings_generation: AtomicU64::new(0),
            settings_write: Mutex::new(()),
            identity: Mutex::new(None),
        });
        let (scan_tx, _) = mpsc::channel();
        let (tx, _) = mpsc::channel();
        let handle = CloudSync {
            shared: shared.clone(),
            tx,
            db_path: path.clone(),
        };
        let mut worker = Worker::new(config, path.clone(), scan_tx, shared, Arc::new(|_| {}));
        worker.session = Some(session());
        worker.update_status();
        worker.next_poll = Instant::now() + Duration::from_secs(3600);
        (handle, worker, Scratch(path))
    }
    fn envelope(generation: u64, capture: i64) -> Envelope {
        Envelope {
            payload: json!({"schemaVersion":1,"capturedAt":capture}),
            captured_at: capture,
            generation,
            force: true,
            refresh: None,
        }
    }
    fn server(
        responses: Vec<(u16, Value)>,
    ) -> (
        String,
        std::thread::JoinHandle<Vec<(String, String, Value)>>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let join = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut authorization = String::new();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                        if name.eq_ignore_ascii_case("authorization") {
                            authorization = value.trim().into();
                        }
                    }
                }
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                requests.push((
                    first,
                    authorization,
                    serde_json::from_slice(&bytes).unwrap_or(Value::Null),
                ));
                let body = body.to_string();
                write!(stream,"HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (url, join)
    }

    #[test]
    fn configuration_requires_safe_base_url_and_public_key() {
        assert!(validate_config("https://example.supabase.co/", KEY, "Test PC").is_ok());
        for url in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/api",
            "https://example.com?token=secret",
            "https://example.com#fragment",
            "file:///tmp/backend",
        ] {
            assert!(
                validate_config(url, KEY, "PC").is_err(),
                "accepted unsafe URL {url}"
            );
        }
        assert_eq!(
            validate_config("http://localhost:54321", KEY, "PC").is_ok(),
            cfg!(debug_assertions)
        );
        assert!(validate_config(
            "https://example.com",
            "sb_secret_12345678901234567890",
            "PC"
        )
        .is_err());
        for name in ["", "C:\\Users\\Alice", "/home/alice", "PC\nname"] {
            assert!(validate_config("https://example.com", KEY, name).is_err());
        }
        let claims = URL_SAFE_NO_PAD.encode(br#"{"role":"anon"}"#);
        assert!(validate_config(
            "https://example.com",
            &format!("eyJhbGciOiJIUzI1NiJ9.{claims}.signature"),
            "PC"
        )
        .is_ok());
        let claims = URL_SAFE_NO_PAD.encode(br#"{"role":"service_role"}"#);
        assert!(validate_config(
            "https://example.com",
            &format!("eyJhbGciOiJIUzI1NiJ9.{claims}.signature"),
            "PC"
        )
        .is_err());
    }
    #[test]
    fn shared_settings_only_carries_valid_display_fields() {
        let settings = shared_settings(
            &json!({"currency":"KRW","krwRate":1700,"monthlyBudget":200,"budgetClaude":null,"budgetCodex":75,"claudeApi":true,"refreshSecs":5,"token":"private"}),
        );
        assert_eq!(settings.as_object().unwrap().len(), 5);
        assert!(valid_shared(&settings));
        assert_eq!(settings["currency"], "KRW");
        assert_eq!(settings["budgetCodex"], 75);
        assert!(!valid_shared(
            &json!({"currency":"USD","krwRate":0,"monthlyBudget":-1,"budgetClaude":null,"budgetCodex":null})
        ));
        assert_eq!(
            shared_settings(&json!({"krwRate":-100,"monthlyBudget":-1}))["krwRate"],
            1400
        );
    }
    #[test]
    fn snapshots_strip_paths_credentials_unknown_fields_and_raw_errors() {
        let (handle, _, _scratch) = fixture("https://example.supabase.co");
        let source = json!({"now":1234,"totals":[{"source":"claude","input":42,"cost":1.25}],"dailyProject":[{"project":"C:\\Users\\Alice\\SecretProject","source":"claude","date":"2026-10-14","cost":1.25}],"sessions":[{"session":"private-session-id","project":"/home/alice/SecretProject","source":"codex","models":"gpt-5"}],"rawLogs":"sk-ant-test-secret","path":"/home/alice/credentials"});
        let live = json!({"claude":{"ok":false,"ts":123,"error":"private C:\\Users\\Alice sk-ant-test-secret","info":{"access_token":"sk-ant-test-secret"}},"codex":{"ok":true,"ts":456,"info":{"planType":"plus","credits":{"hasCredits":true,"unlimited":false,"balance":"1.5","refreshToken":"private-refresh"},"accessToken":"private-access"}},"codexInfo":{"ts":123,"planType":"plus","raw":"private"},"status":{"ts":123,"pages":[{"id":"claude","url":"file:///home/alice","description":"All systems operational","indicator":"none"}]}});
        let settings =
            json!({"currency":"KRW","krwRate":1500,"claudeApi":true,"private":"private-access"});
        handle.publish(
            handle.snapshot_context().unwrap(),
            1234,
            source,
            json!({"remoteUrl":"/home/alice"}),
            settings,
            live,
            true,
            None,
        );
        let pending = handle.shared.latest.lock().unwrap();
        let payload = &pending.as_ref().unwrap().payload;
        let text = payload.to_string();
        for private in [
            "C:\\Users",
            "/home/alice",
            "sk-ant-test-secret",
            "private-session-id",
            "private-refresh",
            "private-access",
            "rawLogs",
            "accessToken",
            "claudeApi",
            "\"error\"",
        ] {
            assert!(!text.contains(private), "snapshot leaked {private}");
        }
        assert_eq!(payload["dashboard"]["totals"][0]["input"], 42);
        assert_eq!(payload["dashboard"]["totals"][0]["cost"], 1.25);
        assert!(payload["dashboard"]["dailyProject"][0]["project"]
            .as_str()
            .unwrap()
            .starts_with("SecretProject ["));
        assert_eq!(payload["live"]["codex"]["info"]["planType"], "plus");
        assert_eq!(payload["settings"]["currency"], "KRW");
        assert_eq!(payload["claudeHooked"], true);
    }
    #[test]
    fn snapshots_preserve_full_fine_history_and_recent_sessions() {
        let fine: Vec<Value> = (0..35 * 24 * 6)
            .map(|i| json!({"t":i as i64*600_000,"source":"claude","cost":0.2}))
            .collect();
        let sessions: Vec<Value> = (0..500)
            .map(|i| json!({"session":format!("id-{i}"),"source":"codex","project":"/tmp/project"}))
            .collect();
        let dashboard = dashboard_payload(&json!({"fine":fine,"sessions":sessions}), "device");
        assert_eq!(dashboard["fine"].as_array().unwrap().len(), 35 * 24 * 6);
        assert_eq!(dashboard["sessions"].as_array().unwrap().len(), 500);
        assert_ne!(
            dashboard["sessions"][0]["session"],
            dashboard["sessions"][1]["session"]
        );
        assert_eq!(
            project_label(&json!("C:\\one\\project")),
            project_label(&json!("C:\\one\\project"))
        );
        assert_ne!(
            project_label(&json!("C:\\one\\project")),
            project_label(&json!("C:\\two\\project"))
        );
    }
    #[test]
    fn refresh_response_uses_seconds_and_rejects_missing_rotation() {
        let now = 1_700_000_000_000;
        let value = json!({"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600,"user":{"id":USER,"email":"test@example.com"}});
        let session = Session::from_response(&value, now).unwrap();
        assert_eq!(session.expires_at, now + 3_600_000);
        assert!(!session.needs_refresh(now));
        assert!(session.needs_refresh(now + 3_540_000));
        assert!(Session::from_response(
            &json!({"access_token":"new","expires_in":3600,"user":{"id":USER}}),
            now
        )
        .is_err());
        assert!(Session::from_response(
            &json!({"access_token":"new","refresh_token":"new","expires_at":1,"user":{"id":USER}}),
            now
        )
        .is_err());
    }
    #[test]
    fn failed_rotation_persistence_drops_authenticated_session() {
        let config = Config::default();
        let mut slot = Some(session());
        let saved = Arc::new(Mutex::new(Vec::new()));
        let mut next = session();
        next.refresh_token = "test-rotated-refresh".into();
        assert!(install_session(
            &TestStore {
                saved: saved.clone(),
                fail: true
            },
            &config,
            &mut slot,
            next.clone()
        )
        .is_err());
        assert!(slot.is_none());
        install_session(
            &TestStore {
                saved: saved.clone(),
                fail: false,
            },
            &config,
            &mut slot,
            next,
        )
        .unwrap();
        assert_eq!(saved.lock().unwrap().as_slice(), ["test-rotated-refresh"]);
        assert_eq!(slot.unwrap().refresh_token, "test-rotated-refresh");
    }
    #[test]
    fn expired_session_rotates_before_upload_and_persists_new_refresh_token() {
        let now = chrono::Utc::now().timestamp_millis();
        let (url, join) = server(vec![
            (
                200,
                json!({"access_token":"test-access-new","refresh_token":"test-refresh-new","expires_in":3600,"user":{"id":USER}}),
            ),
            (200, json!(chrono::Utc::now().to_rfc3339())),
        ]);
        let (_, mut worker, _scratch) = fixture(&url);
        worker.session.as_mut().unwrap().expires_at = now - 1;
        let saved = Arc::new(Mutex::new(Vec::new()));
        worker.store = Box::new(TestStore {
            saved: saved.clone(),
            fail: false,
        });
        worker.pending = Some(envelope(1, now - 120_000));
        worker.work().unwrap();
        let requests = join.join().unwrap();
        assert!(requests[0].0.contains("grant_type=refresh_token"));
        assert_eq!(requests[0].2["refresh_token"], "test-refresh-old");
        assert!(requests[1].0.contains("publish_snapshot"));
        assert_eq!(requests[1].1, "Bearer test-access-new");
        assert_eq!(saved.lock().unwrap().as_slice(), ["test-refresh-new"]);
        assert_eq!(worker.last_capture, Some(now - 120_000));
    }
    #[test]
    fn upload_retry_keeps_capture_time_and_refresh_ack_waits_for_success() {
        let now = chrono::Utc::now().timestamp_millis();
        let (url, join) = server(vec![
            (503, json!({"message":"private backend details"})),
            (200, json!(chrono::Utc::now().to_rfc3339())),
            (200, json!(true)),
        ]);
        let (_, mut worker, _scratch) = fixture(&url);
        let mut pending = envelope(1, now - 120_000);
        pending.refresh = Some(RefreshRequest {
            requested_at: "2026-10-14T10:00:00Z".into(),
            generation: 1,
        });
        worker.pending = Some(pending);
        let error = worker.work().unwrap_err();
        assert_eq!(error, "Cloud request failed (HTTP 503)");
        assert!(worker.acknowledge.is_none());
        assert!(worker.last_capture.is_none());
        worker.work().unwrap();
        let requests = join.join().unwrap();
        assert_eq!(requests[0].2, requests[1].2);
        assert_eq!(requests[1].2["p_payload"]["capturedAt"], now - 120_000);
        assert!(requests[2].0.contains("acknowledge_refresh"));
        assert_eq!(worker.last_capture, Some(now - 120_000));
    }
    #[test]
    fn coalescing_preserves_refresh_intent_and_rejects_stale_context() {
        let (handle, mut worker, _scratch) = fixture("https://example.supabase.co");
        let mut old = envelope(1, 100);
        old.refresh = Some(RefreshRequest {
            requested_at: "stamp".into(),
            generation: 1,
        });
        worker.pending = Some(old);
        *handle.shared.latest.lock().unwrap() = Some(Envelope {
            force: false,
            ..envelope(1, 200)
        });
        worker.collect_latest();
        assert_eq!(worker.pending.as_ref().unwrap().captured_at, 200);
        assert!(worker.pending.as_ref().unwrap().force);
        assert_eq!(
            worker
                .pending
                .as_ref()
                .unwrap()
                .refresh
                .as_ref()
                .unwrap()
                .requested_at,
            "stamp"
        );
        *handle.shared.latest.lock().unwrap() = Some(envelope(2, 300));
        worker.collect_latest();
        assert_eq!(worker.pending.as_ref().unwrap().captured_at, 200);
        worker.pending = None;
        worker.last_capture = Some(400);
        *handle.shared.latest.lock().unwrap() = Some(envelope(1, 399));
        worker.collect_latest();
        assert!(worker.pending.is_none());
    }

    #[test]
    fn rejected_refresh_acknowledgement_repolls_authoritative_request() {
        let (url, join) = server(vec![(200, json!(false))]);
        let (_, mut worker, _scratch) = fixture(&url);
        worker.last_requested_at = Some("stamp".into());
        worker.acknowledge = Some(RefreshRequest {
            requested_at: "stamp".into(),
            generation: 1,
        });
        worker.acknowledge_refresh().unwrap();
        assert!(worker.last_requested_at.is_none());
        assert!(worker.acknowledge.is_none());
        assert!(worker.next_poll <= Instant::now());
        assert!(join.join().unwrap()[0].0.contains("acknowledge_refresh"));
    }

    #[test]
    fn expired_queued_refresh_never_forces_another_provider_query() {
        let (handle, _, _scratch) = fixture("https://example.supabase.co");
        let expired = (chrono::Utc::now() - chrono::Duration::minutes(11)).to_rfc3339();
        *handle.shared.refresh.lock().unwrap() = Some(RefreshRequest {
            requested_at: expired,
            generation: 1,
        });
        assert!(handle.take_refresh_request().is_none());
        *handle.shared.refresh.lock().unwrap() = Some(RefreshRequest {
            requested_at: chrono::Utc::now().to_rfc3339(),
            generation: 1,
        });
        assert!(handle.take_refresh_request().is_some());
    }
    #[test]
    fn local_shared_edits_are_durable_and_scoped_to_backend_account() {
        let (handle, worker, _scratch) = fixture("https://example.supabase.co");
        let ui = json!({"currency":"KRW","krwRate":1600,"closeToTray":false,"claudeApi":true,"monthlyBudget":100});
        handle.settings_changed(&ui).unwrap();
        let dirty = worker.read_dirty().unwrap();
        assert_eq!(dirty["currency"], "KRW");
        assert!(dirty.get("claudeApi").is_none());
        let conn = db::open(&worker.db_path).unwrap();
        let config = db::get_setting(&conn, CONFIG_KEY).unwrap_or_default();
        assert!(!config.contains("test-access-old"));
        let mut other = worker;
        other.session.as_mut().unwrap().user_id = Uuid::new_v4().to_string();
        assert!(other.read_dirty().is_none());
    }
    #[test]
    fn native_status_never_serializes_session_tokens() {
        let (handle, _, _scratch) = fixture("https://example.supabase.co");
        let json = serde_json::to_string(&handle.status()).unwrap();
        assert!(!json.contains("test-access-old"));
        assert!(!json.contains("test-refresh-old"));
        assert!(json.contains("test@example.com"));
        assert_eq!(handle.status().persistent_session, cfg!(windows));
    }

    #[test]
    fn native_snapshot_fixture_matches_public_contract() {
        let (handle, _, _scratch) = fixture("https://example.supabase.co");
        let now = chrono::Utc::now().timestamp_millis();
        let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let sums = json!({"input":100,"cacheWrite":20,"cacheRead":30,"output":40,"reasoning":5,"cost":0.25,"requests":1});
        let row = |extra: Value| {
            let mut value = sums.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            value
        };
        let dashboard = json!({"now":now,
            "totals":[row(json!({"source":"claude","firstTs":now-3600_000,"lastTs":now}))],
            "daily":[row(json!({"source":"claude","date":date}))],
            "dailyModel":[row(json!({"source":"claude","date":date,"model":"claude-sonnet-4"}))],
            "dailyProject":[row(json!({"source":"claude","date":date,"project":"C:\\Users\\Synthetic\\WorkProject"}))],
            "hourly":[row(json!({"source":"claude","hour":now/3600_000*3600_000}))],
            "fine":[row(json!({"source":"claude","t":now/600_000*600_000}))],
            "sessions":[row(json!({"source":"claude","session":"synthetic-session-id","project":"C:\\Users\\Synthetic\\WorkProject","firstTs":now-3600_000,"lastTs":now,"models":"claude-sonnet-4"}))],
            "limits":[{"source":"claude","limitId":"claude","win":"five_hour","ts":now,"usedPct":23.5,"windowMinutes":300,"resetsAt":now+3600_000,"plan":"pro"}],
            "unpriced":[{"source":"codex","model":"synthetic-model","requests":1,"tokens":10}]
        });
        let pricing = json!({"pricing":{"version":"fixture-v1","entries":[{"model":"claude-sonnet-4","input":3.0,"output":15.0,"cache_write_5m":3.75,"cache_write_1h":6.0,"cache_read":0.3,"long_ctx_threshold":200000,"long_input_mult":2.0,"long_output_mult":1.5}],"fast_mult":6.0,"web_search_usd":0.01},"custom":false,"defaultVersion":"fixture-v1","builtinVersion":"fixture-v1","remoteUrl":crate::remote::PRICING_URL});
        let live = json!({"claude":{"ok":true,"ts":now,"info":{"windows":2}},"codex":{"ok":false,"ts":now,"error":"synthetic private error"},
            "codexInfo":{"ts":now,"planType":"plus","credits":{"hasCredits":true,"unlimited":false,"balance":"2.5"},"resetCredits":null,"reached":null},
            "status":{"ts":now,"pages":[{"id":"claude","name":"Claude","url":"https://status.claude.com","indicator":"none","description":"All systems operational"},{"id":"openai","name":"OpenAI","url":"https://status.openai.com","indicator":"future-unrecognized-state","description":"Status available"}]}});
        let settings = json!({"currency":"KRW","krwRate":1400,"monthlyBudget":200,"budgetClaude":150,"budgetCodex":50,"closeToTray":true});
        handle.publish(
            handle.snapshot_context().unwrap(),
            now,
            dashboard,
            pricing,
            settings,
            live,
            true,
            None,
        );
        let pending = handle.shared.latest.lock().unwrap();
        let snapshot = &pending.as_ref().unwrap().payload;
        assert_eq!(snapshot["device"]["id"], handle.status().device_id);
        assert_eq!(
            snapshot["live"]["status"]["pages"][1]["indicator"],
            "unknown"
        );
        assert!(snapshot["live"]["codex"].get("error").is_none());
        assert_eq!(snapshot.as_object().unwrap().len(), 9);
        if let Some(path) = std::env::var_os("TOKEN_VIEW_TEST_SNAPSHOT_PATH") {
            std::fs::write(path, serde_json::to_vec_pretty(snapshot).unwrap()).unwrap();
        }
    }
}
