//! Google sign-in (installed-app OAuth with PKCE + loopback redirect) and the few
//! Drive REST calls the sync needs. Everything lives in the hidden appDataFolder of
//! the signed-in user's own Drive; the scope cannot see any of their other files.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

pub const SCOPE_DRIVE: &str = "https://www.googleapis.com/auth/drive.appdata";
const SCOPES: &str = "openid email https://www.googleapis.com/auth/drive.appdata";
const MAX_DOWNLOAD: u64 = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct Endpoints {
    pub auth: String,
    pub token: String,
    pub revoke: String,
    pub drive: String,
}
impl Default for Endpoints {
    fn default() -> Self {
        Self {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            drive: "https://www.googleapis.com".into(),
        }
    }
}

#[derive(Clone)]
pub struct Client {
    pub id: String,
    pub secret: String,
}

// Deliberately no Debug implementation: these values never belong in errors/logs/IPC.
#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    /// Google account id (`sub`), stable across email changes.
    pub user_id: String,
    pub email: Option<String>,
}
impl Session {
    pub fn needs_refresh(&self, now: i64) -> bool {
        self.expires_at <= now.saturating_add(60_000)
    }
}

pub fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
}

fn random_token() -> String {
    // Two v4 UUIDs = 244 random bits from the OS RNG.
    let bytes: Vec<u8> = [uuid::Uuid::new_v4(), uuid::Uuid::new_v4()]
        .iter()
        .flat_map(|u| u.as_bytes().to_vec())
        .collect();
    URL_SAFE_NO_PAD.encode(bytes)
}

fn read_json(mut response: ureq::http::Response<ureq::Body>) -> Result<(u16, Value), String> {
    let status = response.status().as_u16();
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD)
        .read_to_vec()
        .map_err(|_| "구글 응답을 읽지 못했어요")?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, value))
}

fn claims(id_token: &str) -> Option<Value> {
    let part = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn clean_token(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 16384 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}

/// Builds a session from a token response. `previous` supplies the refresh token
/// and identity when Google omits them (it does on refresh).
pub fn session_from(v: &Value, now: i64, previous: Option<&Session>) -> Result<Session, String> {
    let invalid = || "구글 로그인 응답이 올바르지 않아요".to_string();
    let access_token = clean_token(v, "access_token").ok_or_else(invalid)?;
    let refresh_token = clean_token(v, "refresh_token")
        .or_else(|| previous.map(|p| p.refresh_token.clone()))
        .ok_or_else(invalid)?;
    let expires_in = v
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|s| *s > 0 && *s <= 86_400)
        .ok_or_else(invalid)?;
    if let Some(scope) = v.get("scope").and_then(Value::as_str) {
        if !scope.split(' ').any(|s| s == SCOPE_DRIVE) {
            return Err("구글 드라이브 권한을 허용해야 연결할 수 있어요".into());
        }
    }
    let id = v.get("id_token").and_then(Value::as_str).and_then(claims);
    let user_id = id
        .as_ref()
        .and_then(|c| c.get("sub").and_then(Value::as_str))
        .filter(|s| !s.is_empty() && s.len() <= 255)
        .map(str::to_owned)
        .or_else(|| previous.map(|p| p.user_id.clone()))
        .ok_or_else(invalid)?;
    if previous.is_some_and(|p| p.user_id != user_id) {
        return Err("구글 계정이 바뀌었어요. 다시 연결해 주세요".into());
    }
    let email = id
        .as_ref()
        .and_then(|c| c.get("email").and_then(Value::as_str))
        .filter(|s| s.len() <= 320 && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .or_else(|| previous.and_then(|p| p.email.clone()));
    Ok(Session {
        access_token,
        refresh_token,
        expires_at: now + expires_in * 1000,
        user_id,
        email,
    })
}

pub fn open_browser(url: &str) {
    #[cfg(windows)]
    let _ = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Token View</title><body style=\"font-family:system-ui;padding:40px;text-align:center\"><h2>구글 드라이브 연결 완료</h2><p>이 창을 닫고 Token View로 돌아가세요.</p>";
const FAIL_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Token View</title><body style=\"font-family:system-ui;padding:40px;text-align:center\"><h2>연결하지 못했어요</h2><p>Token View에서 다시 시도해 주세요.</p>";

/// Runs the browser sign-in. `open` receives the consent URL; `cancelled` is polled
/// so a newer attempt (or the cancel button) ends this one.
pub fn sign_in(
    agent: &ureq::Agent,
    ep: &Endpoints,
    client: &Client,
    open: &dyn Fn(&str),
    cancelled: &dyn Fn() -> bool,
    timeout: Duration,
) -> Result<Session, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "로그인용 로컬 포트를 열지 못했어요")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "로그인용 로컬 포트를 열지 못했어요")?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let verifier = random_token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token();
    let mut url = url::Url::parse(&ep.auth).map_err(|_| "잘못된 로그인 주소")?;
    url.query_pairs_mut()
        .append_pair("client_id", &client.id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    open(url.as_str());

    let deadline = Instant::now() + timeout;
    let code = loop {
        if cancelled() {
            return Err("구글 연결을 취소했어요".into());
        }
        if Instant::now() > deadline {
            return Err("구글 연결 시간이 지났어요. 다시 시도해 주세요".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(_) => return Err("로그인 응답을 받지 못했어요".into()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let head = String::from_utf8_lossy(&buf[..n]);
        let target = head
            .lines()
            .next()
            .and_then(|l| l.split(' ').nth(1))
            .unwrap_or("");
        let parsed = url::Url::parse(&format!("http://127.0.0.1{target}")).ok();
        let params: Map<String, Value> = parsed
            .as_ref()
            .map(|u| {
                u.query_pairs()
                    .map(|(k, v)| (k.into_owned(), json!(v.into_owned())))
                    .collect()
            })
            .unwrap_or_default();
        let reply = |stream: &mut std::net::TcpStream, status: &str, body: &str| {
            let _ = write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        };
        // Browsers also probe /favicon.ico; only the redirect carries `state`.
        if params.get("state").and_then(Value::as_str) != Some(state.as_str()) {
            reply(&mut stream, "404 Not Found", "");
            continue;
        }
        if let Some(code) = params.get("code").and_then(Value::as_str) {
            reply(&mut stream, "200 OK", DONE_PAGE);
            break code.to_owned();
        }
        reply(&mut stream, "200 OK", FAIL_PAGE);
        return Err(if params.get("error").and_then(Value::as_str) == Some("access_denied") {
            "구글 연결을 허용하지 않았어요".into()
        } else {
            "구글 연결에 실패했어요".into()
        });
    };

    let response = agent
        .post(&ep.token)
        .send_form([
            ("code", code.as_str()),
            ("client_id", client.id.as_str()),
            ("client_secret", client.secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .map_err(|_| "구글에 연결하지 못했어요")?;
    let (status, value) = read_json(response)?;
    if !(200..300).contains(&status) {
        return Err(format!("구글 로그인 토큰을 받지 못했어요 (HTTP {status})"));
    }
    session_from(&value, chrono::Utc::now().timestamp_millis(), None)
}

pub enum RefreshError {
    /// The grant is gone (revoked, expired, password change): sign in again.
    Revoked,
    Other(String),
}

pub fn refresh(
    agent: &ureq::Agent,
    ep: &Endpoints,
    client: &Client,
    session: &Session,
) -> Result<Session, RefreshError> {
    let response = agent
        .post(&ep.token)
        .send_form([
            ("client_id", client.id.as_str()),
            ("client_secret", client.secret.as_str()),
            ("refresh_token", session.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .map_err(|_| RefreshError::Other("구글에 연결하지 못했어요".into()))?;
    let (status, value) = read_json(response).map_err(RefreshError::Other)?;
    if matches!(status, 400 | 401) {
        return Err(RefreshError::Revoked);
    }
    if !(200..300).contains(&status) {
        return Err(RefreshError::Other(format!(
            "구글 로그인 갱신 실패 (HTTP {status})"
        )));
    }
    session_from(&value, chrono::Utc::now().timestamp_millis(), Some(session))
        .map_err(RefreshError::Other)
}

pub fn revoke(agent: &ureq::Agent, ep: &Endpoints, token: &str) {
    let _ = agent.post(&ep.revoke).send_form([("token", token)]);
}

// ---------- Drive ----------

#[derive(Clone, Debug, PartialEq)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub modified: String,
    pub props: Map<String, Value>,
}
fn drive_file(v: &Value) -> Option<DriveFile> {
    Some(DriveFile {
        id: v.get("id")?.as_str()?.to_owned(),
        name: v.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
        modified: v
            .get("modifiedTime")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        props: v
            .get("appProperties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    })
}

pub enum DriveError {
    Unauthorized,
    NotFound,
    Other(String),
}

const FIELDS: &str = "id,name,modifiedTime,appProperties";

pub struct Drive<'a> {
    pub agent: &'a ureq::Agent,
    pub base: &'a str,
    pub token: &'a str,
}
impl Drive<'_> {
    fn check(&self, r: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Value, DriveError> {
        let r = r.map_err(|_| DriveError::Other("구글 드라이브에 연결하지 못했어요".into()))?;
        let (status, value) = read_json(r).map_err(DriveError::Other)?;
        match status {
            200..=299 => Ok(value),
            401 => Err(DriveError::Unauthorized),
            404 => Err(DriveError::NotFound),
            403 if value.pointer("/error/errors/0/reason").and_then(Value::as_str)
                == Some("storageQuotaExceeded") =>
            {
                Err(DriveError::Other("구글 드라이브 저장 공간이 가득 찼어요".into()))
            }
            _ => Err(DriveError::Other(format!("구글 드라이브 요청 실패 (HTTP {status})"))),
        }
    }
    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    pub fn list(&self) -> Result<Vec<DriveFile>, DriveError> {
        let url = format!(
            "{}/drive/v3/files?spaces=appDataFolder&pageSize=1000&fields=files({FIELDS})",
            self.base
        );
        let v = self.check(self.agent.get(&url).header("Authorization", &self.auth()).call())?;
        Ok(v.get("files")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(drive_file).collect())
            .unwrap_or_default())
    }

    /// Creates (`id` = None) or replaces a file's content and appProperties.
    pub fn upload(
        &self,
        id: Option<&str>,
        name: &str,
        props: &Map<String, Value>,
        mime: &str,
        bytes: &[u8],
    ) -> Result<DriveFile, DriveError> {
        let mut meta = json!({"appProperties": props, "mimeType": mime});
        if id.is_none() {
            meta["name"] = json!(name);
            meta["parents"] = json!(["appDataFolder"]);
        }
        let boundary = format!("tv-{}", uuid::Uuid::new_v4().simple());
        let mut body = format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: {mime}\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let ctype = format!("multipart/related; boundary={boundary}");
        let r = match id {
            None => self
                .agent
                .post(&format!("{}/upload/drive/v3/files?uploadType=multipart&fields={FIELDS}", self.base))
                .header("Authorization", &self.auth())
                .header("Content-Type", &ctype)
                .send(&body[..]),
            Some(id) => self
                .agent
                .patch(&format!("{}/upload/drive/v3/files/{id}?uploadType=multipart&fields={FIELDS}", self.base))
                .header("Authorization", &self.auth())
                .header("Content-Type", &ctype)
                .send(&body[..]),
        };
        drive_file(&self.check(r)?).ok_or_else(|| DriveError::Other("구글 드라이브 응답이 올바르지 않아요".into()))
    }

    /// Creates (`id` = None) or updates a metadata-only file.
    pub fn put_props(
        &self,
        id: Option<&str>,
        name: &str,
        props: &Map<String, Value>,
    ) -> Result<DriveFile, DriveError> {
        let r = match id {
            None => self
                .agent
                .post(&format!("{}/drive/v3/files?fields={FIELDS}", self.base))
                .header("Authorization", &self.auth())
                .header("Content-Type", "application/json; charset=UTF-8")
                .send(json!({"name":name,"parents":["appDataFolder"],"appProperties":props}).to_string()),
            Some(id) => self
                .agent
                .patch(&format!("{}/drive/v3/files/{id}?fields={FIELDS}", self.base))
                .header("Authorization", &self.auth())
                .header("Content-Type", "application/json; charset=UTF-8")
                .send(json!({"appProperties":props}).to_string()),
        };
        drive_file(&self.check(r)?).ok_or_else(|| DriveError::Other("구글 드라이브 응답이 올바르지 않아요".into()))
    }

    pub fn delete(&self, id: &str) -> Result<(), DriveError> {
        self.check(
            self.agent
                .delete(&format!("{}/drive/v3/files/{id}", self.base))
                .header("Authorization", &self.auth())
                .call(),
        )
        .map(|_| ())
    }
}

/// Drive limits each appProperties key+value to 124 bytes; trim on a char boundary.
pub fn prop_text(key: &str, value: &str) -> String {
    let max = 124usize.saturating_sub(key.len());
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}
