//! Price table published in the GitHub repo, so prices can change without an app release.

use crate::db;
use crate::pricing::{Pricing, BUILTIN_VERSION};
use rusqlite::Connection;
use std::time::Duration;

pub const PRICING_URL: &str = "https://raw.githubusercontent.com/frotrue/token-view/main/pricing.json";
const CHECK_EVERY_MS: i64 = 6 * 3_600_000;

/// The table used when the user hasn't edited prices: the remote one if it is newer
/// than the table compiled into this build, otherwise the built-in one.
pub fn default_pricing(conn: &Connection) -> Pricing {
    db::get_setting(conn, "pricing_remote")
        .and_then(|s| serde_json::from_str::<Pricing>(&s).ok())
        .filter(|p| p.version.as_str() > BUILTIN_VERSION && !p.entries.is_empty())
        .unwrap_or_default()
}

fn fetch() -> Result<Pricing, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .build()
        .into();
    let body = agent
        .get(PRICING_URL)
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let p: Pricing = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if p.entries.is_empty() || p.version.len() != 10 {
        return Err("invalid pricing.json".into());
    }
    Ok(p)
}

/// Fetches the remote table at most every few hours (or always with `force`).
/// Returns the remote version that is now stored, if any.
pub fn refresh(conn: &Connection, force: bool) -> Result<Option<String>, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let last: i64 = db::get_setting(conn, "pricing_remote_checked")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if !force && now - last < CHECK_EVERY_MS {
        return Ok(None);
    }
    let _ = db::set_setting(conn, "pricing_remote_checked", &now.to_string());
    let p = fetch()?;
    let json = serde_json::to_string(&p).map_err(|e| e.to_string())?;
    db::set_setting(conn, "pricing_remote", &json).map_err(|e| e.to_string())?;
    Ok(Some(p.version))
}
