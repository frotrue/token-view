//! Sync through a private GitHub repository with a fine-grained token (Contents:
//! read & write on that one repository). Each record is a branch `tv-…` holding a
//! single parentless commit: properties in the commit message, the snapshot as
//! `snapshot.json.gz`. Every write force-moves the branch to a new orphan commit,
//! so the repository keeps no growing history.
use super::store::{read_json, RemoteFile, Store, StoreError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Mutex;

pub const API: &str = "https://api.github.com";
pub const SNAPSHOT_PATH: &str = "snapshot.json.gz";
const META_PATH: &str = "meta.json";

pub fn valid_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let ok = |s: &str, extra: &[u8]| {
        !s.is_empty()
            && s.len() <= 100
            && !s.starts_with('.')
            && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || extra.contains(&c))
    };
    ok(owner, b"") && ok(name, b"._")
}
pub fn valid_token(token: &str) -> bool {
    (token.starts_with("github_pat_") || token.starts_with("ghp_"))
        && (20..=255).contains(&token.len())
        && token.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Per-branch commit/tree/properties, so unchanged records cost no extra calls.
#[derive(Clone)]
pub struct Cached {
    commit: String,
    tree: String,
    file: RemoteFile,
}
pub type Cache = Mutex<HashMap<String, Cached>>;

pub struct Repo<'a> {
    pub agent: &'a ureq::Agent,
    pub api: &'a str,
    pub token: &'a str,
    pub repo: &'a str,
    pub cache: &'a Cache,
}

fn transport<T>(r: Result<T, ureq::Error>) -> Result<T, StoreError> {
    r.map_err(|_| StoreError::Other("GitHub에 연결하지 못했어요".into()))
}

impl Repo<'_> {
    fn send(&self, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value), StoreError> {
        let url = format!("{}/repos/{}{path}", self.api, self.repo);
        let auth = format!("Bearer {}", self.token);
        macro_rules! with_headers {
            ($b:expr) => {
                $b.header("Authorization", &auth)
                    .header("Accept", "application/vnd.github+json")
                    .header("X-GitHub-Api-Version", "2022-11-28")
                    .header("User-Agent", "token-view")
            };
        }
        let r = match (method, body) {
            ("GET", _) => with_headers!(self.agent.get(&url)).call(),
            ("DELETE", _) => with_headers!(self.agent.delete(&url)).call(),
            ("PATCH", Some(b)) => with_headers!(self.agent.patch(&url))
                .header("Content-Type", "application/json")
                .send(b.to_string()),
            (_, b) => with_headers!(self.agent.post(&url))
                .header("Content-Type", "application/json")
                .send(b.unwrap_or(Value::Null).to_string()),
        };
        read_json(transport(r)?).map_err(StoreError::Other)
    }
    fn ok(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value, StoreError> {
        let (status, value) = self.send(method, path, body)?;
        check(status, value)
    }
    fn commit_info(&self, name: &str, sha: &str) -> Result<Cached, StoreError> {
        let v = self.ok("GET", &format!("/git/commits/{sha}"), None)?;
        let tree = v.pointer("/tree/sha").and_then(Value::as_str).unwrap_or("").to_owned();
        let props = v
            .get("message")
            .and_then(Value::as_str)
            .and_then(|m| serde_json::from_str::<Value>(m.trim()).ok())
            .and_then(|m| m.as_object().cloned())
            .unwrap_or_default();
        let modified = v.pointer("/committer/date").and_then(Value::as_str).unwrap_or("").to_owned();
        Ok(Cached {
            commit: sha.into(),
            tree,
            file: RemoteFile { id: name.into(), name: name.into(), modified, props },
        })
    }
    fn set_ref(&self, name: &str, sha: &str) -> Result<(), StoreError> {
        let (status, value) = self.send(
            "PATCH",
            &format!("/git/refs/heads/{name}"),
            Some(json!({"sha": sha, "force": true})),
        )?;
        if matches!(status, 404 | 422) {
            self.ok("POST", "/git/refs", Some(json!({"ref": format!("refs/heads/{name}"), "sha": sha})))?;
            return Ok(());
        }
        check(status, value).map(|_| ())
    }
    fn commit(&self, name: &str, tree: String, props: &Map<String, Value>) -> Result<RemoteFile, StoreError> {
        let v = self.ok(
            "POST",
            "/git/commits",
            Some(json!({"message": Value::Object(props.clone()).to_string(), "tree": tree, "parents": []})),
        )?;
        let sha = v.get("sha").and_then(Value::as_str).ok_or_else(invalid)?.to_owned();
        self.set_ref(name, &sha)?;
        let file = RemoteFile {
            id: name.into(),
            name: name.into(),
            modified: chrono::Utc::now().to_rfc3339(),
            props: props.clone(),
        };
        self.cache.lock().unwrap().insert(name.into(), Cached { commit: sha, tree, file: file.clone() });
        Ok(file)
    }
}

fn invalid() -> StoreError {
    StoreError::Other("GitHub 응답이 올바르지 않아요".into())
}

fn check(status: u16, value: Value) -> Result<Value, StoreError> {
    let message = value.get("message").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    match status {
        200..=299 => Ok(value),
        401 => Err(StoreError::Unauthorized),
        404 => Err(StoreError::NotFound),
        409 => Err(StoreError::Other(
            "GitHub 저장소가 비어 있어요. README 파일을 하나 만든 뒤 다시 시도해 주세요".into(),
        )),
        403 | 429 if message.contains("rate limit") => Err(StoreError::Other(
            "GitHub 요청 한도를 넘었어요. 잠시 후 다시 시도해요".into(),
        )),
        403 => Err(StoreError::Other(
            "토큰에 이 저장소의 Contents 읽기·쓰기 권한이 없어요".into(),
        )),
        _ => Err(StoreError::Other(format!("GitHub 요청 실패 (HTTP {status})"))),
    }
}

impl Store for Repo<'_> {
    fn list(&self) -> Result<Vec<RemoteFile>, StoreError> {
        let refs = self.ok("GET", "/git/matching-refs/heads/tv-", None)?;
        let mut seen = HashMap::new();
        for r in refs.as_array().into_iter().flatten() {
            let (Some(name), Some(sha)) = (
                r.get("ref").and_then(Value::as_str).and_then(|s| s.strip_prefix("refs/heads/")),
                r.pointer("/object/sha").and_then(Value::as_str),
            ) else {
                continue;
            };
            let cached = self.cache.lock().unwrap().get(name).filter(|c| c.commit == sha).cloned();
            let entry = match cached {
                Some(c) => c,
                None => self.commit_info(name, sha)?,
            };
            seen.insert(name.to_owned(), entry);
        }
        let files = seen.values().map(|c| c.file.clone()).collect();
        *self.cache.lock().unwrap() = seen;
        Ok(files)
    }

    fn upload(
        &self,
        _id: Option<&str>,
        name: &str,
        props: &Map<String, Value>,
        _mime: &str,
        bytes: &[u8],
    ) -> Result<RemoteFile, StoreError> {
        let blob = self.ok("POST", "/git/blobs", Some(json!({"content": STANDARD.encode(bytes), "encoding": "base64"})))?;
        let blob = blob.get("sha").and_then(Value::as_str).ok_or_else(invalid)?;
        let tree = self.ok(
            "POST",
            "/git/trees",
            Some(json!({"tree": [{"path": SNAPSHOT_PATH, "mode": "100644", "type": "blob", "sha": blob}]})),
        )?;
        let tree = tree.get("sha").and_then(Value::as_str).ok_or_else(invalid)?.to_owned();
        self.commit(name, tree, props)
    }

    fn put_props(
        &self,
        id: Option<&str>,
        name: &str,
        props: &Map<String, Value>,
    ) -> Result<RemoteFile, StoreError> {
        let tree = match id {
            // Keep the existing content (e.g. the snapshot) and only replace the message.
            Some(id) => {
                let cached = self.cache.lock().unwrap().get(id).map(|c| c.tree.clone());
                match cached {
                    Some(t) => t,
                    None => {
                        let r = self.ok("GET", &format!("/git/ref/heads/{id}"), None)?;
                        let sha = r.pointer("/object/sha").and_then(Value::as_str).ok_or_else(invalid)?;
                        self.commit_info(id, sha)?.tree
                    }
                }
            }
            None => {
                let meta = Value::Object(props.clone()).to_string();
                let t = self.ok(
                    "POST",
                    "/git/trees",
                    Some(json!({"tree": [{"path": META_PATH, "mode": "100644", "type": "blob", "content": meta}]})),
                )?;
                t.get("sha").and_then(Value::as_str).ok_or_else(invalid)?.to_owned()
            }
        };
        self.commit(name, tree, props)
    }

    fn delete(&self, id: &str) -> Result<(), StoreError> {
        self.ok("DELETE", &format!("/git/refs/heads/{id}"), None)?;
        self.cache.lock().unwrap().remove(id);
        Ok(())
    }
}

/// Connection check: the token works, the repository is private and readable.
pub fn check_repo(agent: &ureq::Agent, api: &str, token: &str, repo: &str, cache: &Cache) -> Result<(), String> {
    let r = Repo { agent, api, token, repo, cache };
    let info = match r.ok("GET", "", None) {
        Ok(v) => v,
        Err(StoreError::Unauthorized) => return Err("GitHub 토큰이 올바르지 않거나 만료됐어요".into()),
        Err(StoreError::NotFound) => {
            return Err("저장소를 찾을 수 없어요. 이름과 토큰의 저장소 접근 범위를 확인해 주세요".into())
        }
        Err(StoreError::Other(e)) => return Err(e),
    };
    if info.get("private").and_then(Value::as_bool) != Some(true) {
        return Err("공개 저장소에는 올릴 수 없어요. 비공개(Private) 저장소를 사용해 주세요".into());
    }
    match r.list() {
        Ok(_) => Ok(()),
        Err(StoreError::Other(e)) => Err(e),
        Err(_) => Err("저장소 내용을 읽지 못했어요. 토큰의 Contents 권한을 확인해 주세요".into()),
    }
}
