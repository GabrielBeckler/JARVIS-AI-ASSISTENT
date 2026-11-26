mod chat_store;
mod ollama;
mod system_metrics;

use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct ChatCancellationRegistry {
    active: HashMap<String, CancellationToken>,
    cancelled_before_start: HashSet<String>,
}

static CHAT_CANCELLATIONS: OnceLock<Mutex<ChatCancellationRegistry>> = OnceLock::new();

fn chat_cancellations() -> &'static Mutex<ChatCancellationRegistry> {
    CHAT_CANCELLATIONS.get_or_init(|| Mutex::new(ChatCancellationRegistry::default()))
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn ollama_list_models(
    base_url: String,
) -> Result<Vec<ollama::OllamaModel>, ollama::OllamaError> {
    ollama::list_models(&base_url).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamEvent {
    content: String,
}

#[tauri::command]
async fn ollama_chat(
    request_id: String,
    base_url: String,
    model: String,
    messages: Vec<ollama::ChatMessage>,
    think: Option<bool>,
    keep_alive: Option<String>,
    on_event: Channel<ChatStreamEvent>,
) -> Result<ollama::ChatCompletion, ollama::OllamaError> {
    let cancellation = CancellationToken::new();
    {
        let mut registry = chat_cancellations()
            .lock()
            .expect("chat cancellation registry poisoned");
        if registry.cancelled_before_start.remove(&request_id) {
            cancellation.cancel();
        }
        registry
            .active
            .insert(request_id.clone(), cancellation.clone());
    }
    let result = ollama::chat(
        &base_url,
        &model,
        &messages,
        think,
        keep_alive.as_deref(),
        cancellation,
        |content| {
            on_event
                .send(ChatStreamEvent { content })
                .map_err(|_| ollama::OllamaError::channel_closed())
        },
    )
    .await;
    chat_cancellations()
        .lock()
        .expect("chat cancellation registry poisoned")
        .active
        .remove(&request_id);
    result
}

#[tauri::command]
fn ollama_cancel_chat(request_id: String) -> bool {
    let mut registry = chat_cancellations()
        .lock()
        .expect("chat cancellation registry poisoned");
    if let Some(cancellation) = registry.active.get(&request_id).cloned() {
        cancellation.cancel();
        true
    } else {
        if registry.cancelled_before_start.len() >= 256 {
            registry.cancelled_before_start.clear();
        }
        registry.cancelled_before_start.insert(request_id);
        true
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            chat_store::chat_store_database_url,
            chat_store::initialize_chat_store,
            chat_store::save_chat_store,
            system_metrics::system_snapshot,
            ollama_list_models,
            ollama_chat,
            ollama_cancel_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
