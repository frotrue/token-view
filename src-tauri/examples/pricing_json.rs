//! Prints the built-in price table; `pricing.json` at the repo root is generated from it
//! and served to installed apps (edit the table in src/pricing.rs, then regenerate).
fn main() {
    println!("{}", token_view_lib::builtin_pricing_json());
}
