//! Prints how large a cloud sync upload would be for a database.
fn main() {
    let db = std::env::args().nth(1).expect("db path");
    let (json, gz) = token_view_lib::cli_cloud_size(std::path::Path::new(&db));
    println!("json {json} bytes, gzip {gz} bytes");
}
