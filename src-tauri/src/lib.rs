mod chat_store;
mod ollama;
mod system_metrics;
mod voice;

use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Mutex, OnceLock},
};
use tauri::ipc::Channel;
use tauri_plugin_dialog::DialogExt;
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

#[tauri::command]
async fn export_markdown_dialog(
    app: tauri::AppHandle,
    suggested_name: String,
    content: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_file_name(suggested_name)
            .add_filter("Markdown", &["md"])
            .blocking_save_file();
        let Some(path) = selected else {
            return Ok(false);
        };
        let path = path
            .into_path()
            .map_err(|error| format!("Caminho de exportação inválido: {error}"))?;
        write_markdown_file(&path, &content)?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("Falha ao abrir diálogo de exportação: {error}"))?
}

fn write_markdown_file(path: &Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content)
        .map_err(|error| format!("Falha ao gravar arquivo Markdown: {error}"))
}

#[cfg(test)]
mod export_tests {
    use super::write_markdown_file;

    #[test]
    fn reports_markdown_write_failures() {
        let directory = std::env::temp_dir();
        let error = write_markdown_file(&directory, "# teste").unwrap_err();
        assert!(error.starts_with("Falha ao gravar arquivo Markdown:"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(voice::VoiceState::default())
        .on_window_event(|window, event| {
            use tauri::Manager;
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<voice::VoiceState>().shutdown();
            }
        })
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            chat_store::chat_store_database_url,
            chat_store::initialize_chat_store,
            chat_store::save_chat_store,
            system_metrics::system_snapshot,
            ollama_list_models,
            ollama_chat,
            ollama_cancel_chat,
            export_markdown_dialog,
            voice::voice_reserve,
            voice::voice_capture,
            voice::voice_speak,
            voice::voice_control
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
