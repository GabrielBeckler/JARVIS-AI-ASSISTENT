mod ollama;

use serde::Serialize;
use tauri::ipc::Channel;

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
    base_url: String,
    model: String,
    messages: Vec<ollama::ChatMessage>,
    think: Option<bool>,
    on_event: Channel<ChatStreamEvent>,
) -> Result<ollama::ChatCompletion, ollama::OllamaError> {
    ollama::chat(&base_url, &model, &messages, think, |content| {
        on_event
            .send(ChatStreamEvent { content })
            .map_err(|_| ollama::OllamaError::channel_closed())
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            ollama_list_models,
            ollama_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
