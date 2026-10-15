use super::payload::{dashboard_payload, fingerprint, project_label};
use super::*;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

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
        user_id: "1234567890".into(),
        email: Some("test@example.com".into()),
    }
}
fn fixture(url: &str) -> (CloudSync, Worker, Scratch, mpsc::Receiver<()>) {
    let config = Config {
        device_id: Uuid::new_v4().to_string(),
        device_name: "Test PC".into(),
        enabled: true,
        signed_out: false,
        client_id: "test.apps.googleusercontent.com".into(),
        client_secret: "test-secret".into(),
    };
    let path = std::env::temp_dir().join(format!("token-view-cloud-test-{}.db", Uuid::new_v4()));
    db::open(&path).unwrap();
    let shared = Arc::new(Shared::new(&config));
    let (scan_tx, scan_rx) = mpsc::channel();
    let (tx, _) = mpsc::channel();
    let handle = CloudSync {
        shared: shared.clone(),
        tx,
        db_path: path.clone(),
    };
    let mut worker = Worker::new(config, path.clone(), scan_tx, shared, Arc::new(|_| {}));
    worker.store = Box::new(TestStore {
        saved: Arc::new(Mutex::new(Vec::new())),
        fail: false,
    });
    worker.ep = Endpoints {
        auth: format!("{url}/auth"),
        token: format!("{url}/token"),
        revoke: format!("{url}/revoke"),
        drive: url.into(),
    };
    worker.session = Some(session());
    worker.update_status();
    worker.next_poll = Instant::now() + Duration::from_secs(3600);
    (handle, worker, Scratch(path), scan_rx)
}
fn envelope(generation: u64, capture: i64, content: &str) -> Envelope {
    let payload = json!({"schemaVersion":1,"capturedAt":capture,"content":content});
    Envelope {
        fingerprint: fingerprint(&payload),
        payload,
        captured_at: capture,
        generation,
        force: false,
        refresh: None,
    }
}

struct Req {
    line: String,
    auth: String,
    body: Vec<u8>,
}
impl Req {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}
/// Answers each connection in order with the next canned (status, body).
fn server(responses: Vec<(u16, Value)>) -> (String, std::thread::JoinHandle<Vec<Req>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let join = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let (mut auth, mut length) = (String::new(), 0usize);
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                if h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some((name, value)) = h.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                    if name.eq_ignore_ascii_case("authorization") {
                        auth = value.trim().into();
                    }
                }
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            requests.push(Req { line, auth, body: bytes });
            let body = if body.is_null() { String::new() } else { body.to_string() };
            write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    (url, join)
}
fn file(id: &str, name: &str, props: Value) -> Value {
    json!({"id":id,"name":name,"modifiedTime":"2026-10-15T00:00:00.000Z","appProperties":props})
}
fn gzip_part(body: &[u8]) -> Value {
    let marker = b"Content-Type: application/gzip\r\n\r\n";
    let start = body.windows(marker.len()).position(|w| w == marker).unwrap() + marker.len();
    let end = body.windows(4).rposition(|w| w == b"\r\n--").unwrap();
    let mut out = String::new();
    flate2::read::GzDecoder::new(&body[start..end]).read_to_string(&mut out).unwrap();
    serde_json::from_str(&out).unwrap()
}

#[test]
fn names_and_oauth_clients_are_validated() {
    assert!(validate_name("작업 PC").is_ok());
    for name in ["", "C:\\Users\\Alice", "/home/alice", "PC\nname", "sk-ant-secret"] {
        assert!(validate_name(name).is_err(), "accepted {name:?}");
    }
    assert!(validate_client("", "").is_ok());
    assert!(validate_client("123-abc.apps.googleusercontent.com", "GOCSPX-x").is_ok());
    assert!(validate_client("https://evil.example", "x").is_err());
    assert!(validate_client("a.apps.googleusercontent.com", "bad secret").is_err());
    // Clearing the override also clears its secret.
    assert_eq!(validate_client(" ", "GOCSPX-x").unwrap().1, "");
}

#[test]
fn shared_settings_only_carries_valid_display_fields() {
    let settings = shared_settings(
        &json!({"currency":"KRW","krwRate":1700,"monthlyBudget":200,"budgetClaude":null,"budgetCodex":75,"claudeApi":true,"refreshSecs":5,"token":"private"}),
    );
    assert_eq!(settings.as_object().unwrap().len(), 5);
    assert!(valid_shared(&settings));
    assert_eq!(settings["currency"], "KRW");
    assert!(!valid_shared(
        &json!({"currency":"USD","krwRate":0,"monthlyBudget":-1,"budgetClaude":null,"budgetCodex":null})
    ));
    // Round trip through Drive appProperties (strings; "" = null).
    let props = settings_props(&settings, "1");
    assert_eq!(props["budgetClaude"], "");
    assert_eq!(settings_from_props(&props).unwrap(), settings);
    let mut bad = props.clone();
    bad.insert("krwRate".into(), json!("-5"));
    assert!(settings_from_props(&bad).is_none());
}

#[test]
fn snapshots_strip_paths_credentials_unknown_fields_and_raw_errors() {
    let (handle, _, _scratch, _) = fixture("http://127.0.0.1:9");
    let source = json!({"now":1234,"totals":[{"source":"claude","input":42,"cost":1.25}],"dailyProject":[{"project":"C:\\Users\\Alice\\SecretProject","source":"claude","date":"2026-10-14","cost":1.25}],"sessions":[{"session":"private-session-id","project":"/home/alice/SecretProject","source":"codex","models":"gpt-5","lastTs":1234}],"rawLogs":"sk-ant-test-secret","path":"/home/alice/credentials"});
    let live = json!({"claude":{"ok":false,"ts":123,"error":"private C:\\Users\\Alice sk-ant-test-secret","info":{"access_token":"sk-ant-test-secret"}},"codex":{"ok":true,"ts":456,"info":{"planType":"plus","credits":{"hasCredits":true,"unlimited":false,"balance":"1.5","refreshToken":"private-refresh"},"accessToken":"private-access"}},"codexInfo":{"ts":123,"planType":"plus","raw":"private"},"status":{"ts":123,"pages":[{"id":"claude","url":"file:///home/alice","description":"All systems operational","indicator":"none"}]}});
    let settings = json!({"currency":"KRW","krwRate":1500,"claudeApi":true,"private":"private-access"});
    handle.publish(handle.snapshot_context().unwrap(), 1234, source, json!({"remoteUrl":"/home/alice"}), settings, live, true, None);
    let pending = handle.shared.latest.lock().unwrap();
    let payload = &pending.as_ref().unwrap().payload;
    let text = payload.to_string();
    for private in ["C:\\Users", "/home/alice", "sk-ant-test-secret", "private-session-id", "private-refresh", "private-access", "rawLogs", "accessToken", "claudeApi", "\"error\""] {
        assert!(!text.contains(private), "snapshot leaked {private}");
    }
    assert_eq!(payload["dashboard"]["totals"][0]["input"], 42);
    assert!(payload["dashboard"]["dailyProject"][0]["project"].as_str().unwrap().starts_with("SecretProject ["));
    assert_eq!(payload["live"]["codex"]["info"]["planType"], "plus");
    assert_eq!(payload["settings"]["currency"], "KRW");
}

#[test]
fn windowed_history_is_cut_at_a_day_boundary_for_stable_fingerprints() {
    let day = 86_400_000i64;
    let now = 100 * day + 5 * 3_600_000; // 05:00 UTC
    let fine: Vec<Value> = (0..36 * 24 * 6)
        .map(|i| json!({"t":now - i as i64 * 600_000,"source":"claude","cost":0.2}))
        .collect();
    let sessions: Vec<Value> = (0..500)
        .map(|i| json!({"session":format!("id-{i}"),"source":"codex","project":"/tmp/project","lastTs":now}))
        .collect();
    let a = dashboard_payload(&json!({"now":now,"fine":fine,"sessions":sessions}), "device");
    let cutoff = 66 * day;
    let fine_a = a["fine"].as_array().unwrap();
    assert!(fine_a.iter().all(|r| r["t"].as_i64().unwrap() >= cutoff));
    assert_eq!(fine_a.len() as i64, (now - cutoff) / 600_000 + 1);
    assert_eq!(a["sessions"].as_array().unwrap().len(), 500);
    assert_ne!(a["sessions"][0]["session"], a["sessions"][1]["session"]);
    // Ten minutes later (same day), nothing falls off the front.
    let b = dashboard_payload(&json!({"now":now + 600_000,"fine":a["fine"].clone()}), "device");
    assert_eq!(b["fine"], a["fine"]);
    assert_eq!(project_label(&json!("C:\\one\\project")), project_label(&json!("C:\\one\\project")));
    assert_ne!(project_label(&json!("C:\\one\\project")), project_label(&json!("C:\\two\\project")));
}

#[test]
fn fingerprint_ignores_capture_and_query_times_only() {
    let base = json!({"capturedAt":1,"dashboard":{"now":1,"daily":[{"cost":1}]},"live":{"codex":{"ok":true,"ts":1,"info":{"ts":1,"planType":"plus"}},"status":{"ts":1,"pages":[]}}});
    let mut later = base.clone();
    later["capturedAt"] = json!(2);
    later["dashboard"]["now"] = json!(2);
    later["live"]["codex"]["ts"] = json!(2);
    later["live"]["codex"]["info"]["ts"] = json!(2);
    later["live"]["status"]["ts"] = json!(2);
    assert_eq!(fingerprint(&base), fingerprint(&later));
    later["dashboard"]["daily"][0]["cost"] = json!(2);
    assert_ne!(fingerprint(&base), fingerprint(&later));
    let mut plan = base.clone();
    plan["live"]["codex"]["info"]["planType"] = json!("pro");
    assert_ne!(fingerprint(&base), fingerprint(&plan));
}

fn jwt(claims: Value) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(claims.to_string()))
}

#[test]
fn token_responses_require_drive_scope_and_keep_identity_on_refresh() {
    let now = 1_700_000_000_000;
    let full = json!({"access_token":"a1","refresh_token":"r1","expires_in":3599,"scope":"openid https://www.googleapis.com/auth/drive.appdata email","id_token":jwt(json!({"sub":"42","email":"me@example.com"}))});
    let s = google::session_from(&full, now, None).unwrap();
    assert_eq!((s.user_id.as_str(), s.email.as_deref()), ("42", Some("me@example.com")));
    assert_eq!(s.expires_at, now + 3_599_000);
    // Granular consent can drop Drive while keeping sign-in.
    let mut no_drive = full.clone();
    no_drive["scope"] = json!("openid email");
    assert!(google::session_from(&no_drive, now, None).is_err());
    // Refresh responses omit refresh_token and identity.
    let refreshed = google::session_from(&json!({"access_token":"a2","expires_in":3599}), now, Some(&s)).unwrap();
    assert_eq!((refreshed.refresh_token.as_str(), refreshed.user_id.as_str()), ("r1", "42"));
    let other = json!({"access_token":"a3","expires_in":3599,"id_token":jwt(json!({"sub":"99"}))});
    assert!(google::session_from(&other, now, Some(&s)).is_err());
    assert!(google::session_from(&json!({"access_token":"x","expires_in":3599}), now, None).is_err());
}

#[test]
fn failed_credential_persistence_drops_authenticated_session() {
    let config = Config::default();
    let mut slot = Some(session());
    let saved = Arc::new(Mutex::new(Vec::new()));
    let mut next = session();
    next.refresh_token = "test-rotated-refresh".into();
    assert!(install_session(&TestStore { saved: saved.clone(), fail: true }, &config, &mut slot, next.clone()).is_err());
    assert!(slot.is_none());
    install_session(&TestStore { saved: saved.clone(), fail: false }, &config, &mut slot, next).unwrap();
    assert_eq!(saved.lock().unwrap().as_slice(), ["test-rotated-refresh"]);
}

#[test]
fn native_status_never_serializes_session_tokens() {
    let (handle, _, _scratch, _) = fixture("http://127.0.0.1:9");
    let json = serde_json::to_string(&handle.status()).unwrap();
    assert!(!json.contains("test-access-old"));
    assert!(!json.contains("test-refresh-old"));
    assert!(!json.contains("test-secret"));
    assert!(json.contains("test@example.com"));
}

#[test]
fn first_sync_uploads_gzip_then_only_marks_unchanged_content() {
    let (url, join) = server(vec![
        (200, json!({"files":[]})),                                          // poll
        (200, file("snap1", "x", json!({}))),                                // create snapshot
        (200, file("set1", SETTINGS_NAME, json!({}))),                       // seed settings
        (200, file("snap1", "x", json!({}))),                                // checkedAt mark
        (200, file("snap1", "x", json!({}))),                                // forced upload
    ]);
    let (_, mut worker, _scratch, _) = fixture(&url);
    worker.next_poll = Instant::now();
    worker.heartbeat = Duration::ZERO;
    let now = chrono::Utc::now().timestamp_millis();
    worker.pending = Some(envelope(1, now - 3000, "a"));
    worker.work().unwrap();
    assert!(worker.pending_settings.is_some(), "first device seeds shared settings");
    // Same content captured later: settings push, then a metadata-only mark.
    worker.pending = Some(envelope(1, now - 2000, "a"));
    worker.work().unwrap();
    // Changed content inside the 5-minute window waits...
    worker.pending = Some(envelope(1, now - 1000, "b"));
    worker.work().unwrap();
    assert!(worker.pending.is_some());
    // ...unless forced (sync now / phone request).
    worker.pending.as_mut().unwrap().force = true;
    worker.work().unwrap();
    let reqs = join.join().unwrap();
    assert!(reqs[0].line.starts_with("GET /drive/v3/files?spaces=appDataFolder"));
    assert_eq!(reqs[0].auth, "Bearer test-access-old");
    assert!(reqs[1].line.starts_with("POST /upload/drive/v3/files?uploadType=multipart"));
    let text = reqs[1].text();
    assert!(text.contains("\"parents\":[\"appDataFolder\"]"));
    assert!(text.contains(&format!("\"capturedAt\":\"{}\"", now - 3000)));
    assert_eq!(gzip_part(&reqs[1].body)["content"], "a");
    assert!(reqs[2].line.starts_with("POST /drive/v3/files?"));
    assert_eq!(reqs[2].json()["appProperties"]["tv"], "settings");
    assert!(reqs[3].line.starts_with("PATCH /drive/v3/files/snap1?"));
    assert_eq!(reqs[3].json()["appProperties"]["checkedAt"], (now - 2000).to_string());
    assert_eq!(reqs[3].json()["appProperties"]["capturedAt"], (now - 3000).to_string());
    assert!(reqs[4].line.starts_with("PATCH /upload/drive/v3/files/snap1?uploadType=multipart"));
    assert_eq!(gzip_part(&reqs[4].body)["content"], "b");
    assert_eq!(worker.last_capture, Some(now - 1000));
    assert!(worker.shared.status.lock().unwrap().last_upload_bytes.unwrap() < 200);
}

#[test]
fn phone_request_triggers_a_scan_and_the_upload_marks_it_handled() {
    let now = chrono::Utc::now().timestamp_millis();
    let settings = json!({"tv":"settings","currency":"USD","krwRate":"1400","monthlyBudget":"","budgetClaude":"","budgetCodex":"","rev":"7"});
    let (url, join) = server(vec![
        (200, json!({"files":[file("set1", SETTINGS_NAME, settings)]})),
        (200, file("snap1", "x", json!({}))),
    ]);
    let (handle, mut worker, _scratch, scan_rx) = fixture(&url);
    let req = |nonce: &str, at: i64| {
        let mut m = Map::new();
        m.insert("nonce".into(), json!(nonce));
        m.insert("at".into(), json!(at.to_string()));
        m
    };
    // Expired requests (the PC was off) are ignored.
    worker.handle_request(&req("old-request-1", now - 11 * 60_000));
    assert!(handle.take_refresh_request().is_none());
    worker.handle_request(&req("nonce-abc-123", now - 5000));
    assert!(scan_rx.try_recv().is_ok());
    // The same nonce is not served twice.
    worker.handle_request(&req("nonce-abc-123", now - 5000));
    let request = handle.take_refresh_request().unwrap();
    assert!(handle.take_refresh_request().is_none());
    // The scanner publishes with the request: a forced upload carrying `handled`.
    handle.publish(handle.snapshot_context().unwrap(), now, json!({"now":now}), json!({}), json!({}), json!({}), false, Some(request));
    worker.collect_latest();
    assert!(worker.pending.as_ref().unwrap().force);
    worker.settings_rev = Some("7".into());
    worker.next_poll = Instant::now();
    worker.work().unwrap();
    let reqs = join.join().unwrap();
    assert!(reqs[1].line.starts_with("POST /upload/"));
    assert!(reqs[1].text().contains("\"handled\":\"nonce-abc-123\""));
    assert_eq!(worker.handled.as_deref(), Some("nonce-abc-123"));
}

#[test]
fn expired_access_token_refreshes_first_and_revoked_grant_signs_out() {
    let (url, join) = server(vec![
        (200, json!({"access_token":"test-access-new","expires_in":3599})),
        (200, json!({"files":[]})),
        (400, json!({"error":"invalid_grant"})),
    ]);
    let (_, mut worker, _scratch, _) = fixture(&url);
    let saved = Arc::new(Mutex::new(Vec::new()));
    worker.store = Box::new(TestStore { saved: saved.clone(), fail: false });
    worker.session.as_mut().unwrap().expires_at = 0;
    worker.poll().unwrap();
    assert_eq!(saved.lock().unwrap().as_slice(), ["test-refresh-old"]);
    worker.session.as_mut().unwrap().expires_at = 0;
    let err = worker.poll().unwrap_err();
    assert!(err.contains("다시 연결"));
    assert!(worker.session.is_none());
    assert!(worker.config.signed_out);
    let reqs = join.join().unwrap();
    assert!(reqs[0].line.starts_with("POST /token"));
    assert!(reqs[0].text().contains("grant_type=refresh_token"));
    assert!(reqs[0].text().contains("refresh_token=test-refresh-old"));
    assert_eq!(reqs[1].auth, "Bearer test-access-new");
}

#[test]
fn failed_upload_keeps_capture_for_retry() {
    let now = chrono::Utc::now().timestamp_millis();
    let (url, join) = server(vec![
        (503, json!({"error":{"message":"private backend details"}})),
        (200, file("snap1", "x", json!({}))),
    ]);
    let (_, mut worker, _scratch, _) = fixture(&url);
    worker.pending = Some(Envelope { force: true, ..envelope(1, now - 1000, "a") });
    let error = worker.work().unwrap_err();
    assert!(error.contains("HTTP 503") && !error.contains("private"));
    assert!(worker.last_capture.is_none());
    worker.work().unwrap();
    let reqs = join.join().unwrap();
    assert_eq!(gzip_part(&reqs[0].body), gzip_part(&reqs[1].body));
    assert_eq!(worker.last_capture, Some(now - 1000));
}

#[test]
fn remote_settings_apply_locally_but_unpushed_local_edits_win() {
    let props = json!({"tv":"settings","currency":"KRW","krwRate":"1500","monthlyBudget":"","budgetClaude":"200","budgetCodex":"","rev":"7"});
    let (url, join) = server(vec![
        (200, json!({"files":[file("set1", SETTINGS_NAME, props.clone())]})),
        (200, file("set1", SETTINGS_NAME, json!({}))),
    ]);
    let (handle, mut worker, _scratch, _) = fixture(&url);
    let conn = db::open(&worker.db_path).unwrap();
    db::set_setting(&conn, "ui", &json!({"currency":"USD","krwRate":1400,"closeToTray":false}).to_string()).unwrap();
    worker.poll().unwrap();
    let ui: Value = serde_json::from_str(&db::get_setting(&conn, "ui").unwrap()).unwrap();
    assert_eq!((ui["currency"].as_str(), ui["budgetClaude"].as_i64()), (Some("KRW"), Some(200)));
    assert_eq!(ui["closeToTray"], false, "desktop-only settings untouched");
    // A local edit is queued durably and pushed to the known settings file.
    handle.settings_changed(&json!({"currency":"USD","krwRate":1300,"monthlyBudget":50})).unwrap();
    worker.pending_settings = worker.read_dirty();
    worker.work().unwrap();
    assert!(worker.pending_settings.is_none());
    assert!(worker.read_dirty().is_none());
    let reqs = join.join().unwrap();
    assert!(reqs[1].line.starts_with("PATCH /drive/v3/files/set1?"));
    assert_eq!(reqs[1].json()["appProperties"]["krwRate"], "1300");
    assert_eq!(reqs[1].json()["appProperties"]["budgetCodex"], "");
}

#[test]
fn loopback_sign_in_exchanges_the_code_with_pkce() {
    let id_token = jwt(json!({"sub":"777","email":"new@example.com"}));
    let (url, join) = server(vec![(
        200,
        json!({"access_token":"fresh","refresh_token":"fresh-refresh","expires_in":3599,"scope":"openid email https://www.googleapis.com/auth/drive.appdata","id_token":id_token}),
    )]);
    let (handle, mut worker, _scratch, _) = fixture(&url);
    worker.session = None;
    let saved = Arc::new(Mutex::new(Vec::new()));
    worker.store = Box::new(TestStore { saved: saved.clone(), fail: false });
    // The "browser": follow the consent URL straight to the loopback redirect.
    worker.open = Arc::new(|consent: &str| {
        let u = url::Url::parse(consent).unwrap();
        let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(q["scope"].contains("drive.appdata"));
        let redirect = url::Url::parse(&q["redirect_uri"]).unwrap();
        let state = q["state"].clone();
        std::thread::spawn(move || {
            let addr = format!("127.0.0.1:{}", redirect.port().unwrap());
            // A favicon probe without state must not end the flow.
            let mut probe = std::net::TcpStream::connect(&addr).unwrap();
            write!(probe, "GET /favicon.ico HTTP/1.1\r\n\r\n").unwrap();
            let _ = probe.read(&mut [0u8; 256]);
            let mut s = std::net::TcpStream::connect(&addr).unwrap();
            write!(s, "GET /?state={state}&code=the-code&scope=x HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut page = String::new();
            let _ = s.read_to_string(&mut page);
            assert!(page.contains("연결 완료"));
        });
    });
    let attempt = handle.shared.attempt.fetch_add(1, Ordering::SeqCst) + 1;
    worker.sign_in(attempt).unwrap();
    let reqs = join.join().unwrap();
    let form = reqs[0].text();
    assert!(form.contains("code=the-code") && form.contains("code_verifier=") && form.contains("grant_type=authorization_code"));
    let s = worker.session.as_ref().unwrap();
    assert_eq!((s.user_id.as_str(), s.email.as_deref()), ("777", Some("new@example.com")));
    assert_eq!(saved.lock().unwrap().as_slice(), ["fresh-refresh"]);
    assert!(!worker.config.signed_out);
    assert!(handle.status().authenticated);
}

#[test]
fn cancelled_sign_in_stops_waiting() {
    let (handle, mut worker, _scratch, _) = fixture("http://127.0.0.1:9");
    worker.open = Arc::new(|_: &str| {});
    let attempt = handle.shared.attempt.load(Ordering::SeqCst) + 1;
    handle.shared.attempt.store(attempt, Ordering::SeqCst);
    let shared = handle.shared.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        shared.attempt.fetch_add(1, Ordering::SeqCst);
    });
    let err = worker.sign_in(attempt).unwrap_err();
    assert!(err.contains("취소"));
    assert!(!handle.status().signing_in);
}

#[test]
fn coalescing_preserves_refresh_intent_and_rejects_stale_context() {
    let (handle, mut worker, _scratch, _) = fixture("http://127.0.0.1:9");
    let mut old = envelope(1, 100, "a");
    old.force = true;
    old.refresh = Some(RefreshRequest { nonce: "stamp".into(), generation: 1 });
    worker.pending = Some(old);
    *handle.shared.latest.lock().unwrap() = Some(envelope(1, 200, "b"));
    worker.collect_latest();
    let p = worker.pending.as_ref().unwrap();
    assert_eq!(p.captured_at, 200);
    assert!(p.force);
    assert_eq!(p.refresh.as_ref().unwrap().nonce, "stamp");
    *handle.shared.latest.lock().unwrap() = Some(envelope(2, 300, "c"));
    worker.collect_latest();
    assert_eq!(worker.pending.as_ref().unwrap().captured_at, 200);
    worker.pending = None;
    worker.last_capture = Some(400);
    *handle.shared.latest.lock().unwrap() = Some(envelope(1, 399, "d"));
    worker.collect_latest();
    assert!(worker.pending.is_none());
}

#[test]
fn native_snapshot_fixture_matches_public_contract() {
    let (handle, _, _scratch, _) = fixture("http://127.0.0.1:9");
    let now = chrono::Utc::now().timestamp_millis();
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let sums = json!({"input":100,"cacheWrite":20,"cacheRead":30,"output":40,"reasoning":5,"cost":0.25,"requests":1});
    let row = |extra: Value| {
        let mut value = sums.clone();
        value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
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
    handle.publish(handle.snapshot_context().unwrap(), now, dashboard, pricing, settings, live, true, None);
    let pending = handle.shared.latest.lock().unwrap();
    let snapshot = &pending.as_ref().unwrap().payload;
    assert_eq!(snapshot["device"]["id"], handle.status().device_id);
    assert_eq!(snapshot["live"]["status"]["pages"][1]["indicator"], "unknown");
    assert!(snapshot["live"]["codex"].get("error").is_none());
    assert_eq!(snapshot.as_object().unwrap().len(), 9);
    if let Some(path) = std::env::var_os("TOKEN_VIEW_TEST_SNAPSHOT_PATH") {
        std::fs::write(path, serde_json::to_vec_pretty(snapshot).unwrap()).unwrap();
    }
}
