use crate::build_data;
use gethostname::gethostname;
use rust_socketio::{Client, ClientBuilder, Payload};
// use serde_json::json;
pub fn get_client(on_new_target: fn (Payload, Client)) -> Client {
    let url = format!(
        "{}?hostname={:?}&playerName={}&version={}&token={}&hasBF4=true&hasBF1=true",
        build_data::ROOT_URL,
        gethostname(),
        "",
        crate::VERSION,
        build_data::AUTH_TOKEN
    );
    return ClientBuilder::new(url)
    .namespace("/ws/seeder")
    .on("newTarget", on_new_target)
    .on("error", |err, _| eprintln!("Error: {:#?}", err))
    .connect()
    .expect("Socket.io connection failed catastrophically.");
}