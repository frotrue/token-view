//! Private, optional sync to the user's own Google Drive (hidden appDataFolder) or,
//! alternatively, a private GitHub repository (see `github.rs` for its layout).
//! Only the worker touches sessions/network. Scanner handoff is a single
//! latest-value slot: a slow or offline network never blocks local collection.
//!
//! Drive layout (all in appDataFolder; the reader lists everything in one call):
//! - `tv-snapshot-<device>`: gzip'd snapshot JSON; appProperties carry device name,
//!   capture time, `checkedAt` (last time the PC confirmed the content unchanged)
//!   and `handled` (last refresh-request nonce served).
//! - `tv-request-<device>`: metadata-only; the phone writes `{nonce, at}`.
//! - `tv-settings`: metadata-only; shared display/budget settings + `rev`.
mod github;
mod google;
pub mod payload;
mod store;

use crate::db;
use google::{Client, Endpoints, RefreshError, Session};
use store::{RemoteFile, Store, StoreError};
pub use payload::shared_settings;
use payload::{suspicious_text, valid_shared, SHARED_KEYS};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

const CONFIG_KEY: &str = "cloud_config";
const DIRTY_KEY: &str = "cloud_dirty_settings";
/// Changed content is uploaded at most this often (a phone request bypasses it).
const MIN_UPLOAD: Duration = Duration::from_secs(300);
/// Unchanged content only refreshes its tiny `checkedAt` mark this often.
const HEARTBEAT: Duration = Duration::from_secs(300);
/// One Drive list call: requests from the phone + shared settings.
const POLL_INTERVAL: Duration = Duration::from_secs(60);
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_UPLOAD: usize = 4 * 1024 * 1024;
const REQUEST_TTL_MS: i64 = 10 * 60_000;
const SETTINGS_NAME: &str = "tv-settings";

// Release builds get the public OAuth client from CI; the desktop "secret" of an
// installed-app client is not confidential (Google documents this).
const BUILTIN_CLIENT_ID: Option<&str> = option_env!("TOKEN_VIEW_GOOGLE_CLIENT_ID");
const BUILTIN_CLIENT_SECRET: Option<&str> = option_env!("TOKEN_VIEW_GOOGLE_CLIENT_SECRET");

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    device_id: String,
    device_name: String,
    enabled: bool,
    // A nonsecret tombstone also prevents a failed credential deletion restoring login.
    #[serde(default = "yes")]
    signed_out: bool,
    /// Optional override of the built-in OAuth client (self-built copies).
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    /// "google" (default) or "github".
    #[serde(default)]
    provider: String,
    /// `owner/name` of the private repository when `provider` is "github".
    #[serde(default)]
    github_repo: String,
}
fn yes() -> bool {
    true
}
fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|n| validate_name(n).is_ok())
        .unwrap_or_else(|| "내 PC".into())
}
impl Default for Config {
    fn default() -> Self {
        Self {
            device_id: Uuid::new_v4().to_string(),
            device_name: default_device_name(),
            enabled: true,
            signed_out: true,
            client_id: String::new(),
            client_secret: String::new(),
            provider: String::new(),
            github_repo: String::new(),
        }
    }
}
impl Config {
    fn github(&self) -> bool {
        self.provider == "github"
    }
    fn client(&self) -> Option<Client> {
        if !self.client_id.is_empty() {
            return Some(Client {
                id: self.client_id.clone(),
                secret: self.client_secret.clone(),
            });
        }
        BUILTIN_CLIENT_ID
            .filter(|id| !id.is_empty())
            .map(|id| Client {
                id: id.into(),
                secret: BUILTIN_CLIENT_SECRET.unwrap_or("").into(),
            })
    }
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.chars().count() > 64
        || name.chars().any(char::is_control)
        || suspicious_text(name)
    {
        return Err("PC 이름은 1~64자로, 경로나 토큰 같은 문자열 없이 입력해 주세요".into());
    }
    Ok(name.into())
}
fn validate_client(id: &str, secret: &str) -> Result<(String, String), String> {
    let (id, secret) = (id.trim(), secret.trim());
    let printable = |s: &str| s.len() <= 256 && s.bytes().all(|c| c.is_ascii_graphic());
    if !id.is_empty() && (!id.ends_with(".apps.googleusercontent.com") || !printable(id)) {
        return Err("클라이언트 ID는 ….apps.googleusercontent.com 형식이어야 해요".into());
    }
    if !printable(secret) {
        return Err("클라이언트 보안 비밀번호 형식이 올바르지 않아요".into());
    }
    Ok((id.into(), if id.is_empty() { String::new() } else { secret.into() }))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCloudStatus {
    /// An OAuth client is available (built in or entered by the user).
    available: bool,
    custom_client: bool,
    client_id: String,
    /// "google" or "github" once connected; empty before.
    provider: String,
    github_repo: String,
    enabled: bool,
    device_id: String,
    device_name: String,
    email: Option<String>,
    authenticated: bool,
    signing_in: bool,
    last_upload_at: Option<i64>,
    last_check_at: Option<i64>,
    last_upload_bytes: Option<usize>,
    last_error: Option<String>,
    persistent_session: bool,
}
impl DesktopCloudStatus {
    fn new(config: &Config) -> Self {
        Self {
            available: config.client().is_some(),
            custom_client: !config.client_id.is_empty(),
            client_id: config.client_id.clone(),
            provider: String::new(),
            github_repo: config.github_repo.clone(),
            enabled: config.enabled,
            device_id: config.device_id.clone(),
            device_name: config.device_name.clone(),
            email: None,
            authenticated: false,
            signing_in: false,
            last_upload_at: None,
            last_check_at: None,
            last_upload_bytes: None,
            last_error: None,
            persistent_session: cfg!(windows),
        }
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
        keyring::Entry::new("com.tokenview.monitor.google", &config.device_id)
            .map_err(|_| "Windows 자격 증명 저장소를 사용할 수 없어요".into())
    }
}
#[cfg(windows)]
impl SessionStore for NativeStore {
    fn load(&self, config: &Config) -> Result<Option<Session>, String> {
        match Self::entry(config)?.get_password() {
            Ok(s) => serde_json::from_str(&s)
                .map(Some)
                .map_err(|_| "저장된 구글 로그인이 손상됐어요. 다시 연결해 주세요".into()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Windows 자격 증명을 읽지 못했어요".into()),
        }
    }
    fn save(&self, config: &Config, session: &Session) -> Result<(), String> {
        let s = serde_json::to_string(session).map_err(|_| "구글 로그인 정보를 저장하지 못했어요")?;
        Self::entry(config)?
            .set_password(&s)
            .map_err(|_| "Windows 자격 증명에 저장하지 못했어요".into())
    }
    fn clear(&self, config: &Config) -> Result<(), String> {
        match Self::entry(config)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Windows 자격 증명을 지우지 못했어요".into()),
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

// Persist new credentials before using them. Failure drops authentication rather
// than continuing with credentials that cannot survive an app restart.
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

pub struct SnapshotContext {
    generation: u64,
    pub device_id: String,
    pub device_name: String,
}
#[derive(Clone)]
pub struct RefreshRequest {
    nonce: String,
    generation: u64,
}
struct Envelope {
    payload: Value,
    fingerprint: String,
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
    /// Google account id while signed in and enabled.
    identity: Mutex<Option<String>>,
    /// Bumped to cancel a waiting browser sign-in.
    attempt: AtomicU64,
}
#[derive(Clone)]
pub struct CloudSync {
    shared: Arc<Shared>,
    tx: mpsc::Sender<Command>,
    db_path: PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
struct DirtySettings {
    user_id: String,
    settings: Value,
}
type Reply = mpsc::Sender<Result<DesktopCloudStatus, String>>;
enum Command {
    Wake,
    Configure {
        name: String,
        enabled: bool,
        client_id: String,
        client_secret: String,
        reply: Reply,
    },
    SignIn {
        attempt: u64,
        reply: Reply,
    },
    ConnectGithub {
        repo: String,
        token: String,
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
            .filter(|c| validate_name(&c.device_name).is_ok())
            .unwrap_or_default();
        // Persist the device UUID even before setup; no credentials live here.
        if let Ok(c) = db::open(&db_path) {
            let _ = db::set_setting(&c, CONFIG_KEY, &serde_json::to_string(&config).unwrap());
        }
        let shared = Arc::new(Shared::new(&config));
        let (tx, rx) = mpsc::channel();
        let handle = Self {
            shared: shared.clone(),
            tx,
            db_path: db_path.clone(),
        };
        std::thread::spawn(move || {
            let mut worker = Worker::new(config, db_path, scan_trigger, shared, notify);
            worker.load_session();
            worker.run(rx)
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
        self.shared.refresh.lock().unwrap().take()
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
    #[allow(clippy::too_many_arguments)]
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
        let payload = payload::snapshot(
            &context.device_id,
            &context.device_name,
            captured_at,
            &dashboard,
            &pricing,
            &settings,
            &live,
            hooked,
        );
        let fingerprint = payload::fingerprint(&payload);
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
            fingerprint,
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
        if !status.enabled || !status.authenticated {
            return Err("먼저 구글 드라이브를 연결하고 동기화를 켜 주세요".into());
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
        if let Some(user_id) = identity {
            let dirty = DirtySettings {
                user_id,
                settings: shared_settings(ui),
            };
            let conn = db::open(&self.db_path).map_err(|_| "공유 설정을 저장하지 못했어요")?;
            db::set_setting(&conn, DIRTY_KEY, &serde_json::to_string(&dirty).unwrap())
                .map_err(|_| "공유 설정을 저장하지 못했어요")?;
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
            .map_err(|_| "동기화 작업을 시작할 수 없어요")?;
        rx.recv().map_err(|_| "동기화 작업을 시작할 수 없어요")?
    }
    pub fn configure(
        &self,
        name: String,
        enabled: bool,
        client_id: String,
        client_secret: String,
    ) -> Result<DesktopCloudStatus, String> {
        validate_name(&name)?;
        validate_client(&client_id, &client_secret)?;
        self.request(|reply| Command::Configure {
            name,
            enabled,
            client_id,
            client_secret,
            reply,
        })
    }
    /// Opens the browser and waits (up to 3 minutes) for Google's redirect.
    pub fn sign_in(&self) -> Result<DesktopCloudStatus, String> {
        let attempt = self.shared.attempt.fetch_add(1, Ordering::SeqCst) + 1;
        self.request(|reply| Command::SignIn { attempt, reply })
    }
    /// Connects a private repository with a fine-grained token instead of Google.
    pub fn connect_github(&self, repo: String, token: String) -> Result<DesktopCloudStatus, String> {
        let (repo, token) = (repo.trim().to_owned(), token.trim().to_owned());
        if !github::valid_repo(&repo) {
            return Err("저장소는 owner/name 형식으로 입력해 주세요".into());
        }
        if !github::valid_token(&token) {
            return Err("GitHub 토큰(github_pat_… 또는 ghp_…)을 입력해 주세요".into());
        }
        self.cancel_sign_in();
        self.request(|reply| Command::ConnectGithub { repo, token, reply })
    }
    pub fn cancel_sign_in(&self) {
        self.shared.attempt.fetch_add(1, Ordering::SeqCst);
    }
    pub fn sign_out(&self) -> Result<DesktopCloudStatus, String> {
        self.cancel_sign_in();
        self.request(Command::SignOut)
    }
}
impl Shared {
    fn new(config: &Config) -> Self {
        Self {
            status: Mutex::new(DesktopCloudStatus::new(config)),
            latest: Mutex::new(None),
            refresh: Mutex::new(None),
            force_next: AtomicBool::new(false),
            generation: AtomicU64::new(1),
            settings_generation: AtomicU64::new(0),
            settings_write: Mutex::new(()),
            identity: Mutex::new(None),
            attempt: AtomicU64::new(0),
        }
    }
}

#[derive(Default)]
struct FileIds {
    snapshot: Option<String>,
    settings: Option<String>,
}

struct Worker {
    config: Config,
    session: Option<Session>,
    store: Box<dyn SessionStore>,
    db_path: PathBuf,
    scan_trigger: mpsc::Sender<()>,
    shared: Arc<Shared>,
    notify: Arc<dyn Fn(&str) + Send + Sync>,
    open: Arc<dyn Fn(&str) + Send + Sync>,
    agent: ureq::Agent,
    ep: Endpoints,
    github_api: String,
    github_cache: github::Cache,
    min_upload: Duration,
    heartbeat: Duration,
    pending: Option<Envelope>,
    pending_settings: Option<Value>,
    files: FileIds,
    /// Fingerprint and appProperties of the content currently on Drive.
    uploaded: Option<(String, Map<String, Value>)>,
    last_upload: Option<Instant>,
    last_mark: Option<Instant>,
    last_capture: Option<i64>,
    /// Last request nonce seen / served.
    seen_nonce: Option<String>,
    handled: Option<String>,
    settings_rev: Option<String>,
    next_poll: Instant,
    next_attempt: Instant,
    failures: u32,
}

fn drive_msg(e: StoreError) -> String {
    match e {
        StoreError::Unauthorized => "로그인이 만료됐어요. 다시 연결해 주세요".into(),
        StoreError::NotFound => "저장 공간에서 파일을 찾지 못했어요".into(),
        StoreError::Other(s) => s,
    }
}
fn snapshot_name(device: &str) -> String {
    format!("tv-snapshot-{device}")
}
fn request_name(device: &str) -> String {
    format!("tv-request-{device}")
}
/// Newest file with that name; older duplicates (concurrent creates) are returned
/// separately for cleanup.
fn pick<'a>(files: &'a [RemoteFile], name: &str) -> (Option<&'a RemoteFile>, Vec<&'a RemoteFile>) {
    let mut same: Vec<&RemoteFile> = files.iter().filter(|f| f.name == name).collect();
    same.sort_by(|a, b| b.modified.cmp(&a.modified));
    let first = same.first().copied();
    (first, same.into_iter().skip(1).collect())
}
fn prop<'a>(props: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    props.get(key).and_then(Value::as_str)
}
fn settings_props(settings: &Value, rev: &str) -> Map<String, Value> {
    let mut props = Map::new();
    props.insert("tv".into(), json!("settings"));
    for key in SHARED_KEYS {
        let v = &settings[key];
        let text = match v {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        props.insert(key.into(), json!(text));
    }
    props.insert("rev".into(), json!(rev));
    props
}
fn settings_from_props(props: &Map<String, Value>) -> Option<Value> {
    let mut out = Map::new();
    for key in SHARED_KEYS {
        let text = prop(props, key)?;
        let v = if key == "currency" {
            json!(text)
        } else if text.is_empty() {
            Value::Null
        } else {
            Value::Number(serde_json::from_str::<serde_json::Number>(text).ok()?)
        };
        out.insert(key.into(), v);
    }
    let v = Value::Object(out);
    valid_shared(&v).then_some(v)
}

impl Worker {
    fn new(
        config: Config,
        db_path: PathBuf,
        scan_trigger: mpsc::Sender<()>,
        shared: Arc<Shared>,
        notify: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self {
            config,
            session: None,
            store: Box::new(NativeStore),
            db_path,
            scan_trigger,
            shared,
            notify,
            open: Arc::new(google::open_browser),
            agent: google::agent(),
            ep: Endpoints::default(),
            github_api: github::API.into(),
            github_cache: Default::default(),
            min_upload: MIN_UPLOAD,
            heartbeat: HEARTBEAT,
            pending: None,
            pending_settings: None,
            files: FileIds::default(),
            uploaded: None,
            last_upload: None,
            last_mark: None,
            last_capture: None,
            seen_nonce: None,
            handled: None,
            settings_rev: None,
            next_poll: Instant::now(),
            next_attempt: Instant::now(),
            failures: 0,
        }
    }
    fn load_session(&mut self) {
        if !self.config.signed_out {
            match self.store.load(&self.config) {
                Ok(Some(s)) if !s.access_token.is_empty() && !s.refresh_token.is_empty() => {
                    self.session = Some(s)
                }
                Ok(_) => {}
                Err(e) => self.error(&e),
            }
        }
        self.update_status();
        self.pending_settings = self.read_dirty();
    }
    fn client(&self) -> Result<Client, String> {
        self.config
            .client()
            .ok_or_else(|| "이 빌드에는 구글 클라이언트 ID가 없어요. 고급 설정에서 입력해 주세요".into())
    }
    fn persist_config(&self) -> Result<(), String> {
        let conn = db::open(&self.db_path).map_err(|_| "동기화 설정을 저장하지 못했어요")?;
        db::set_setting(
            &conn,
            CONFIG_KEY,
            &serde_json::to_string(&self.config).unwrap(),
        )
        .map_err(|_| "동기화 설정을 저장하지 못했어요".into())
    }
    fn update_status(&self) {
        *self.shared.identity.lock().unwrap() = self
            .session
            .as_ref()
            .filter(|_| self.config.enabled)
            .map(|s| s.user_id.clone());
        let mut s = self.shared.status.lock().unwrap();
        s.available = self.config.client().is_some();
        s.custom_client = !self.config.client_id.is_empty();
        s.client_id = self.config.client_id.clone();
        s.provider = if self.session.is_none() {
            String::new()
        } else if self.config.github() {
            "github".into()
        } else {
            "google".into()
        };
        s.github_repo = self.config.github_repo.clone();
        s.enabled = self.config.enabled;
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
        self.github_cache.lock().unwrap().clear();
        self.shared.latest.lock().unwrap().take();
        self.shared.refresh.lock().unwrap().take();
        self.shared.force_next.store(false, Ordering::SeqCst);
        self.pending = None;
        self.pending_settings = None;
        self.files = FileIds::default();
        self.uploaded = None;
        self.last_upload = None;
        self.last_mark = None;
        self.last_capture = None;
        self.seen_nonce = None;
        self.handled = None;
        self.settings_rev = None;
        self.failures = 0;
        self.next_attempt = Instant::now();
        self.next_poll = Instant::now();
        let mut s = self.shared.status.lock().unwrap();
        s.last_upload_at = None;
        s.last_check_at = None;
        s.last_upload_bytes = None;
        s.last_error = None;
    }
    fn read_dirty(&self) -> Option<Value> {
        let session = self.session.as_ref()?;
        let conn = db::open(&self.db_path).ok()?;
        let dirty: DirtySettings =
            serde_json::from_str(&db::get_setting(&conn, DIRTY_KEY)?).ok()?;
        (dirty.user_id == session.user_id && valid_shared(&dirty.settings)).then_some(dirty.settings)
    }
    fn settings_saved(&mut self, saved: &Value) -> Result<(), String> {
        let _guard = self.shared.settings_write.lock().unwrap();
        let current = self.read_dirty();
        if current.as_ref() == Some(saved) {
            let conn = db::open(&self.db_path).map_err(|_| "공유 설정 상태를 저장하지 못했어요")?;
            conn.execute("DELETE FROM settings WHERE key=?1", [DIRTY_KEY])
                .map_err(|_| "공유 설정 상태를 저장하지 못했어요")?;
            self.pending_settings = None;
        } else {
            self.pending_settings = current;
        }
        Ok(())
    }

    // ---------- auth ----------

    fn drop_session(&mut self) {
        self.session = None;
        self.config.signed_out = true;
        let _ = self.persist_config();
        let _ = self.store.clear(&self.config);
        self.update_status();
    }
    fn refresh_session(&mut self) -> Result<(), String> {
        let client = self.client()?;
        let current = self.session.clone().ok_or("구글 드라이브를 다시 연결해 주세요")?;
        let next = match google::refresh(&self.agent, &self.ep, &client, &current) {
            Ok(next) => next,
            Err(RefreshError::Revoked) => {
                self.drop_session();
                return Err("구글 연결이 만료됐어요. 다시 연결해 주세요".into());
            }
            Err(RefreshError::Other(e)) => return Err(e),
        };
        if let Err(e) = install_session(self.store.as_ref(), &self.config, &mut self.session, next) {
            self.config.signed_out = true;
            let _ = self.persist_config();
            self.update_status();
            return Err(e);
        }
        Ok(())
    }
    /// Runs a storage call against the connected backend. Google tokens are kept
    /// fresh (refreshing once on 401); a rejected GitHub token signs out.
    fn drive<T>(&mut self, f: &dyn Fn(&dyn Store) -> Result<T, StoreError>) -> Result<T, StoreError> {
        if self.config.github() {
            let token = self
                .session
                .as_ref()
                .ok_or_else(|| StoreError::Other("GitHub 저장소를 먼저 연결해 주세요".into()))?
                .access_token
                .clone();
            let r = f(&github::Repo {
                agent: &self.agent,
                api: &self.github_api,
                token: &token,
                repo: &self.config.github_repo,
                cache: &self.github_cache,
            });
            if matches!(r, Err(StoreError::Unauthorized)) {
                self.drop_session();
                return Err(StoreError::Other(
                    "GitHub 토큰이 만료됐거나 취소됐어요. 새 토큰으로 다시 연결해 주세요".into(),
                ));
            }
            return r;
        }
        let expired = self
            .session
            .as_ref()
            .ok_or_else(|| StoreError::Other("구글 드라이브를 먼저 연결해 주세요".into()))?
            .needs_refresh(chrono::Utc::now().timestamp_millis());
        if expired {
            self.refresh_session().map_err(StoreError::Other)?;
        }
        let call = |w: &Self| {
            f(&google::Drive {
                agent: &w.agent,
                base: &w.ep.drive,
                token: &w.session.as_ref().unwrap().access_token,
            })
        };
        match call(self) {
            Err(StoreError::Unauthorized) => {
                self.refresh_session().map_err(StoreError::Other)?;
                call(self)
            }
            other => other,
        }
    }

    fn configure(
        &mut self,
        name: String,
        enabled: bool,
        client_id: String,
        client_secret: String,
    ) -> Result<(), String> {
        let name = validate_name(&name)?;
        let (client_id, client_secret) = validate_client(&client_id, &client_secret)?;
        let old = self.config.clone();
        // An empty secret for the same client means "unchanged".
        let client_secret = if client_id == old.client_id && client_secret.is_empty() {
            old.client_secret.clone()
        } else {
            client_secret
        };
        // Tokens belong to the OAuth client that issued them.
        if old.client_id != client_id && !old.github() {
            if let Some(s) = self.session.take() {
                google::revoke(&self.agent, &self.ep, &s.refresh_token);
            }
            self.config.signed_out = true;
            self.store.clear(&old)?;
        }
        self.config.device_name = name;
        self.config.enabled = enabled;
        self.config.client_id = client_id;
        self.config.client_secret = client_secret;
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
    fn sign_in(&mut self, attempt: u64) -> Result<(), String> {
        let client = self.client()?;
        self.shared.status.lock().unwrap().signing_in = true;
        self.shared.status.lock().unwrap().last_error = None;
        (self.notify)("cloud-status");
        let shared = self.shared.clone();
        let open = self.open.clone();
        let result = google::sign_in(
            &self.agent,
            &self.ep,
            &client,
            &|url| open(url),
            &|| shared.attempt.load(Ordering::SeqCst) != attempt,
            SIGN_IN_TIMEOUT,
        );
        self.shared.status.lock().unwrap().signing_in = false;
        (self.notify)("cloud-status");
        let next = result?;
        if let Some(old) = self.session.take() {
            if !self.config.github() && old.user_id != next.user_id {
                google::revoke(&self.agent, &self.ep, &old.refresh_token);
            }
        }
        self.config.provider = "google".into();
        if let Err(e) = install_session(self.store.as_ref(), &self.config, &mut self.session, next) {
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
    fn connect_github(&mut self, repo: String, token: String) -> Result<(), String> {
        github::check_repo(&self.agent, &self.github_api, &token, &repo, &self.github_cache)?;
        if let Some(old) = self.session.take() {
            if !self.config.github() {
                google::revoke(&self.agent, &self.ep, &old.refresh_token);
            }
        }
        let next = Session {
            access_token: token,
            refresh_token: String::new(),
            expires_at: i64::MAX,
            user_id: format!("github:{}", repo.to_ascii_lowercase()),
            email: Some(repo.clone()),
        };
        if let Err(e) = install_session(self.store.as_ref(), &self.config, &mut self.session, next) {
            self.config.signed_out = true;
            let _ = self.persist_config();
            self.update_status();
            return Err(e);
        }
        self.config.provider = "github".into();
        self.config.github_repo = repo;
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
        let token = self.session.take().map(|s| s.refresh_token);
        let cleared = self.store.clear(&self.config);
        self.reset_context();
        self.update_status();
        // GitHub tokens are revoked by the user on GitHub; we only forget it.
        if let Some(token) = token.filter(|_| !self.config.github()) {
            google::revoke(&self.agent, &self.ep, &token);
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
                {
                    self.pending_settings = Some(v.settings);
                }
            }
            Command::Configure {
                name,
                enabled,
                client_id,
                client_secret,
                reply,
            } => {
                let r = self.configure(name, enabled, client_id, client_secret);
                self.reply(r, reply);
            }
            Command::SignIn { attempt, reply } => {
                let r = self.sign_in(attempt);
                self.reply(r, reply);
            }
            Command::ConnectGithub { repo, token, reply } => {
                let r = self.connect_github(repo, token);
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

    // ---------- sync ----------

    fn poll(&mut self) -> Result<(), String> {
        let files = self.drive(&|d| d.list()).map_err(drive_msg)?;
        let device = self.config.device_id.clone();
        let (snapshot, extra) = pick(&files, &snapshot_name(&device));
        let (settings, extra_settings) = pick(&files, SETTINGS_NAME);
        let (request, _) = pick(&files, &request_name(&device));
        let stale: Vec<String> = extra
            .iter()
            .chain(extra_settings.iter())
            .map(|f| f.id.clone())
            .collect();
        self.files.snapshot = snapshot.map(|f| f.id.clone());
        self.files.settings = settings.map(|f| f.id.clone());
        if self.seen_nonce.is_none() {
            self.seen_nonce = snapshot.and_then(|f| prop(&f.props, "handled")).map(str::to_owned);
            self.handled = self.seen_nonce.clone();
        }
        let settings = settings.map(|f| f.props.clone());
        let request = request.map(|f| f.props.clone());
        for id in stale {
            let _ = self.drive(&|d| d.delete(&id));
        }
        self.apply_remote_settings(settings)?;
        if let Some(props) = request {
            self.handle_request(&props);
        }
        Ok(())
    }
    fn handle_request(&mut self, props: &Map<String, Value>) {
        let Some(nonce) = prop(props, "nonce")
            .filter(|n| (8..=64).contains(&n.len()) && n.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
        else {
            return;
        };
        if self.seen_nonce.as_deref() == Some(nonce) {
            return;
        }
        self.seen_nonce = Some(nonce.to_owned());
        let at = prop(props, "at").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        let now = chrono::Utc::now().timestamp_millis();
        // Requests expire: a PC that was off for hours should not act on them.
        if (now - at).abs() > REQUEST_TTL_MS {
            return;
        }
        *self.shared.refresh.lock().unwrap() = Some(RefreshRequest {
            nonce: nonce.to_owned(),
            generation: self.shared.generation.load(Ordering::SeqCst),
        });
        let _ = self.scan_trigger.send(());
    }
    fn apply_remote_settings(&mut self, props: Option<Map<String, Value>>) -> Result<(), String> {
        let generation = self.shared.settings_generation.load(Ordering::SeqCst);
        let _settings_lock = self.shared.settings_write.lock().unwrap();
        let conn = db::open(&self.db_path).map_err(|_| "로컬 설정을 열지 못했어요")?;
        let mut ui = db::get_setting(&conn, "ui")
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let Some(props) = props else {
            // First device on this account: seed the shared settings from here.
            if self.pending_settings.is_none() {
                self.pending_settings = Some(shared_settings(&ui));
            }
            return Ok(());
        };
        let rev = prop(&props, "rev").unwrap_or("").to_owned();
        // Local edits not yet pushed win; a racing local save also wins.
        if self.pending_settings.is_some()
            || self.settings_rev.as_deref() == Some(rev.as_str())
            || self.shared.settings_generation.load(Ordering::SeqCst) != generation
        {
            return Ok(());
        }
        let remote = settings_from_props(&props).ok_or("드라이브의 공유 설정이 올바르지 않아요")?;
        if shared_settings(&ui) != remote {
            for key in SHARED_KEYS {
                ui[key] = remote[key].clone();
            }
            db::set_setting(&conn, "ui", &ui.to_string())
                .map_err(|_| "공유 설정을 저장하지 못했어요")?;
            (self.notify)("cloud-settings-updated");
        }
        self.settings_rev = Some(rev);
        Ok(())
    }
    fn push_settings(&mut self, settings: Value) -> Result<(), String> {
        let rev = chrono::Utc::now().timestamp_millis().to_string();
        let props = settings_props(&settings, &rev);
        let id = self.files.settings.clone();
        let mut r = self.drive(&|d| d.put_props(id.as_deref(), SETTINGS_NAME, &props));
        if matches!(r, Err(StoreError::NotFound)) {
            r = self.drive(&|d| d.put_props(None, SETTINGS_NAME, &props));
        }
        let file = r.map_err(drive_msg)?;
        self.files.settings = Some(file.id);
        self.settings_rev = Some(rev);
        self.settings_saved(&settings)
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
    fn upload(&mut self, pending: Envelope) -> Result<(), String> {
        let bytes = payload::gzip(&pending.payload);
        if bytes.len() > MAX_UPLOAD {
            return Err("업로드할 데이터가 4MB를 넘어요".into());
        }
        let handled = pending
            .refresh
            .as_ref()
            .map(|r| r.nonce.clone())
            .or_else(|| self.handled.clone());
        let mut props = Map::new();
        props.insert("tv".into(), json!("snapshot"));
        props.insert("schema".into(), json!("1"));
        props.insert("enc".into(), json!("gzip"));
        props.insert("deviceId".into(), json!(self.config.device_id));
        props.insert(
            "deviceName".into(),
            json!(google::prop_text("deviceName", &self.config.device_name)),
        );
        props.insert("capturedAt".into(), json!(pending.captured_at.to_string()));
        props.insert("checkedAt".into(), json!(pending.captured_at.to_string()));
        if let Some(h) = &handled {
            props.insert("handled".into(), json!(h));
        }
        let name = snapshot_name(&self.config.device_id);
        let id = self.files.snapshot.clone();
        let mut r = self.drive(&|d| d.upload(id.as_deref(), &name, &props, "application/gzip", &bytes));
        if matches!(r, Err(StoreError::NotFound)) {
            // Deleted from Drive settings ("앱 데이터 삭제"): create it again.
            r = self.drive(&|d| d.upload(None, &name, &props, "application/gzip", &bytes));
        }
        let file = match r {
            Ok(f) => f,
            Err(e) => {
                self.pending = Some(pending);
                return Err(drive_msg(e));
            }
        };
        self.files.snapshot = Some(file.id);
        self.uploaded = Some((pending.fingerprint, props));
        self.last_upload = Some(Instant::now());
        self.last_mark = self.last_upload;
        self.last_capture = Some(pending.captured_at);
        self.handled = handled;
        let mut s = self.shared.status.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        s.last_upload_at = Some(now);
        s.last_check_at = Some(now);
        s.last_upload_bytes = Some(bytes.len());
        s.last_error = None;
        drop(s);
        (self.notify)("cloud-status");
        Ok(())
    }
    /// Content unchanged: only move `checkedAt` so the phone knows it is current.
    fn mark_checked(&mut self, pending: Envelope) -> Result<(), String> {
        let (Some(id), Some((_, props))) = (self.files.snapshot.clone(), self.uploaded.as_ref()) else {
            return Ok(());
        };
        let mut props = props.clone();
        props.insert("checkedAt".into(), json!(pending.captured_at.to_string()));
        let name = snapshot_name(&self.config.device_id);
        match self.drive(&|d| d.put_props(Some(&id), &name, &props)) {
            Ok(_) => {}
            Err(StoreError::NotFound) => {
                self.files.snapshot = None;
                self.uploaded = None;
                self.pending = Some(pending);
                return Ok(());
            }
            Err(e) => {
                self.pending = Some(pending);
                return Err(drive_msg(e));
            }
        }
        if let Some(u) = self.uploaded.as_mut() {
            u.1 = props;
        }
        self.last_mark = Some(Instant::now());
        self.last_capture = Some(pending.captured_at);
        self.shared.status.lock().unwrap().last_check_at = Some(chrono::Utc::now().timestamp_millis());
        (self.notify)("cloud-status");
        Ok(())
    }
    fn work(&mut self) -> Result<(), String> {
        if self.pending_settings.is_some() {
            // Learn the existing settings file first so we update instead of duplicating.
            if self.files.settings.is_none() && Instant::now() >= self.next_poll {
                self.poll()?;
                self.next_poll = Instant::now() + POLL_INTERVAL;
            }
            if let Some(settings) = self.pending_settings.clone() {
                self.push_settings(settings)?;
            }
        }
        if Instant::now() >= self.next_poll {
            self.poll()?;
            self.next_poll = Instant::now() + POLL_INTERVAL;
        }
        let Some(p) = self.pending.as_ref() else {
            return Ok(());
        };
        let changed = self.uploaded.as_ref().map(|u| u.0.as_str()) != Some(p.fingerprint.as_str());
        if p.force || (changed && self.last_upload.is_none_or(|t| t.elapsed() >= self.min_upload)) {
            let p = self.pending.take().unwrap();
            return self.upload(p);
        }
        if !changed {
            let p = self.pending.take().unwrap();
            if self.last_mark.is_none_or(|t| t.elapsed() >= self.heartbeat) {
                return self.mark_checked(p);
            }
        }
        // Changed but throttled: keep the newest capture for the next window.
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
mod tests;
