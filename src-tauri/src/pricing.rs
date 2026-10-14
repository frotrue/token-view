use crate::db::Event;
use serde::{Deserialize, Serialize};

/// USD per 1M tokens. Long-context multipliers apply to the whole request once its
/// total input exceeds `long_ctx_threshold` (OpenAI's 272K rule); 0 disables them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceEntry {
    pub model: String,
    pub input: f64,
    pub output: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
    #[serde(default)]
    pub long_ctx_threshold: i64,
    #[serde(default = "one")]
    pub long_input_mult: f64,
    #[serde(default = "one")]
    pub long_output_mult: f64,
}

fn one() -> f64 {
    1.0
}

/// Date of the built-in price table; a remote table only wins when it is newer.
pub const BUILTIN_VERSION: &str = "2026-10-15";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pricing {
    /// YYYY-MM-DD of the price table this came from.
    #[serde(default)]
    pub version: String,
    pub entries: Vec<PriceEntry>,
    /// Claude fast mode price multiplier (Opus 5.5 fast = 2x).
    pub fast_mult: f64,
    /// USD per web search request (Claude server tool).
    pub web_search_usd: f64,
}

fn claude(model: &str, input: f64, output: f64, cache_read: f64) -> PriceEntry {
    PriceEntry {
        model: model.into(),
        input,
        output,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 2.0,
        cache_read,
        long_ctx_threshold: 0,
        long_input_mult: 1.0,
        long_output_mult: 1.0,
    }
}

fn openai(model: &str, input: f64, output: f64, cache_read: f64) -> PriceEntry {
    PriceEntry {
        model: model.into(),
        input,
        output,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 1.25,
        cache_read,
        long_ctx_threshold: 272_000,
        long_input_mult: 2.0,
        long_output_mult: 1.5,
    }
}

impl Default for Pricing {
    fn default() -> Self {
        let entries = vec![
            claude("claude-fable-5-1", 10.0, 50.0, 0.25),
            claude("claude-mythos-5-1", 10.0, 50.0, 0.25),
            claude("claude-fable-5", 10.0, 50.0, 1.0),
            claude("claude-mythos-5", 10.0, 50.0, 1.0),
            claude("claude-opus-5-5", 4.0, 20.0, 0.20),
            claude("claude-opus-5", 5.0, 25.0, 0.50),
            claude("claude-opus-4-8", 5.0, 25.0, 0.50),
            claude("claude-opus-4-7", 5.0, 25.0, 0.50),
            claude("claude-opus-4-6", 5.0, 25.0, 0.50),
            claude("claude-opus-4-5", 5.0, 25.0, 0.50),
            claude("claude-opus-4", 15.0, 75.0, 1.50),
            claude("claude-sonnet-5-5", 2.0, 10.0, 0.20),
            claude("claude-sonnet-5", 2.0, 10.0, 0.20),
            claude("claude-sonnet-4", 3.0, 15.0, 0.30),
            claude("claude-haiku-5-5", 0.10, 0.50, 0.01),
            claude("claude-haiku-4-5", 1.0, 5.0, 0.10),
            // Model aliases that occasionally show up in Claude Code logs.
            claude("opus", 4.0, 20.0, 0.20),
            claude("sonnet", 2.0, 10.0, 0.20),
            claude("haiku", 0.10, 0.50, 0.01),
            // OpenAI standard tier, developers.openai.com/api/docs/pricing (2026-10-15).
            // Long context (>272K input) is 2x input/cache and 1.5x output on all of these.
            openai("gpt-6-astra", 10.0, 50.0, 1.0),
            openai("gpt-6.1-sol", 2.0, 10.0, 0.10),
            openai("gpt-6-sol", 2.0, 10.0, 0.20),
            openai("gpt-6-luna", 0.10, 0.50, 0.01),
            openai("gpt-5.6-sol", 4.0, 20.0, 0.40), // promotional rate through at least 2026-11-21
            openai("gpt-5.6-terra", 2.0, 12.0, 0.20),
            openai("gpt-5.6-luna", 0.20, 1.20, 0.02),
            openai("gpt-5.5", 5.0, 30.0, 0.50),
            openai("gpt-5.5-pro", 30.0, 180.0, 30.0), // no cached-input discount
            openai("gpt-5.3-codex", 1.75, 14.0, 0.175),
        ];
        Pricing { version: BUILTIN_VERSION.into(), entries, fast_mult: 2.0, web_search_usd: 0.01 }
    }
}

impl Pricing {
    /// Exact match first, then the longest entry that is a prefix of the model id.
    pub fn find(&self, model: &str) -> Option<&PriceEntry> {
        let m = model.to_ascii_lowercase();
        if let Some(e) = self.entries.iter().find(|e| e.model.eq_ignore_ascii_case(&m)) {
            return Some(e);
        }
        self.entries
            .iter()
            .filter(|e| !e.model.is_empty() && m.starts_with(&e.model.to_ascii_lowercase()))
            .max_by_key(|e| e.model.len())
    }

    pub fn cost(&self, e: &Event) -> (f64, bool) {
        let Some(p) = self.find(&e.model) else {
            return (0.0, false);
        };
        let total_in = e.input + e.cache_write_5m + e.cache_write_1h + e.cache_read;
        let (im, om) = if p.long_ctx_threshold > 0 && total_in > p.long_ctx_threshold {
            (p.long_input_mult, p.long_output_mult)
        } else {
            (1.0, 1.0)
        };
        let mut usd = (e.input as f64 * p.input
            + e.cache_write_5m as f64 * p.cache_write_5m
            + e.cache_write_1h as f64 * p.cache_write_1h
            + e.cache_read as f64 * p.cache_read)
            * im
            / 1e6
            + e.output as f64 * p.output * om / 1e6;
        if e.fast {
            usd *= self.fast_mult;
        }
        usd += e.web_search as f64 * self.web_search_usd;
        (usd, true)
    }
}
