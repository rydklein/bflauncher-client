use const_format::formatcp;
use env_logger::Env;
use log::*;
use rust_socketio::{Client, Payload};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{thread, time};
use winconsole::console::set_title;
mod build_data;
mod server_interface;
const VERSION: &str = env!("CARGO_PKG_VERSION");
const SPLASH_TEXT: &str = formatcp!("Seeder Control Client (v{})", VERSION);
fn main() {
    env_logger::Builder::from_env(Env::default().default_filter_or("info")).init();
    let _ = set_title(SPLASH_TEXT);
    info!("{}", SPLASH_TEXT);
    let client = server_interface::get_client(on_new_target);
    std::thread::spawn(|| {
        watchdog();
    })
    .join().expect("Error in thread!");
}
fn watchdog() {
    loop {
        thread::sleep(time::Duration::from_secs(30));
        info!("Test");
    }
}
fn on_new_target(payload: Payload, client: Client) {
    info!("Recieved new server!");
    match payload {
        Payload::String(str) => {
            info!("{}", str);
            let new_server: ServerData = serde_json::from_str(&str).unwrap();
            info!("{:?}", new_server)
        }
        Payload::Binary(bin_data) => println!("Received bytes: {:#?}", bin_data),
    }
}
#[derive(Serialize, Deserialize, Debug)]
#[allow(non_snake_case)]
struct ServerData {
    name: Option<String>,
    game: i8,
    guid: Option<String>,
    gameId: Option<String>,
    user: String,
    timestamp:u128
}