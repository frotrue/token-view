fn main() {
    let db = std::env::args().nth(1).expect("db path");
    let t = std::time::Instant::now();
    let v = token_view_lib::cli_scan(std::path::Path::new(&db));
    eprintln!("took {:?}", t.elapsed());
    println!("{}", serde_json::to_string_pretty(&v["status"]).unwrap());
    println!("totals {}", serde_json::to_string_pretty(&v["dashboard"]["totals"]).unwrap());
    println!("unpriced {}", v["dashboard"]["unpriced"]);
    let lim = v["dashboard"]["limits"].as_array().unwrap();
    println!("limits {} rows; last 3: {:?}", lim.len(), &lim[lim.len().saturating_sub(3)..]);
    println!("daily rows {}", v["dashboard"]["daily"].as_array().unwrap().len());
}
