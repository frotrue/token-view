fn main() {
    let db = std::env::args().nth(1).expect("db path");
    let v = token_view_lib::cli_live(std::path::Path::new(&db));
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}
