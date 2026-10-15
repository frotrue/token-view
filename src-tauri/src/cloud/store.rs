//! The storage backends behind sync (the user's Google Drive or a private GitHub
//! repository) expose the same tiny file model: named records with string
//! properties, one of which (the snapshot) also carries gzip content.
use serde_json::{Map, Value};

pub const MAX_DOWNLOAD: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteFile {
    pub id: String,
    pub name: String,
    pub modified: String,
    pub props: Map<String, Value>,
}

pub enum StoreError {
    Unauthorized,
    NotFound,
    Other(String),
}

pub trait Store {
    fn list(&self) -> Result<Vec<RemoteFile>, StoreError>;
    /// Creates (`id` = None) or replaces a record's content and properties.
    fn upload(
        &self,
        id: Option<&str>,
        name: &str,
        props: &Map<String, Value>,
        mime: &str,
        bytes: &[u8],
    ) -> Result<RemoteFile, StoreError>;
    /// Creates (`id` = None) or updates a record's properties, keeping its content.
    fn put_props(
        &self,
        id: Option<&str>,
        name: &str,
        props: &Map<String, Value>,
    ) -> Result<RemoteFile, StoreError>;
    fn delete(&self, id: &str) -> Result<(), StoreError>;
}

pub fn read_json(mut response: ureq::http::Response<ureq::Body>) -> Result<(u16, Value), String> {
    let status = response.status().as_u16();
    let bytes = response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD)
        .read_to_vec()
        .map_err(|_| "응답을 읽지 못했어요")?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, value))
}
