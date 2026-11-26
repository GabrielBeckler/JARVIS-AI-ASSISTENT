use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, sqlite::SqlitePool};
use std::collections::HashSet;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

const DATABASE_FILE: &str = "jarvis.db";
const IMPORT_KEY: &str = "legacy_conversations_v1";
const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT,
  updated_at INTEGER,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  model TEXT,
  created_at INTEGER,
  request_id TEXT,
  delivery TEXT CHECK (delivery IS NULL OR delivery IN ('pending', 'sent', 'failed')),
  first_content_ms REAL,
  total_elapsed_ms REAL,
  ollama_total_ms REAL,
  tokens_per_second REAL,
  PRIMARY KEY (conversation_id, id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS one_assistant_answer_per_request
  ON messages(conversation_id, request_id)
  WHERE role = 'assistant' AND request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

impl ChatRole {
    fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "system" => Some(Self::System),
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageMetrics {
    #[serde(default)]
    pub first_content_ms: Option<f64>,
    #[serde(default)]
    pub total_elapsed_ms: Option<f64>,
    #[serde(default)]
    pub ollama_total_ms: Option<f64>,
    #[serde(default)]
    pub tokens_per_second: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub content: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub delivery: Option<String>,
    #[serde(default)]
    pub metrics: Option<MessageMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversation {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub updated_at: Option<i64>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStoreInit {
    pub conversations: Vec<ChatConversation>,
    pub import_status: String,
    pub warning: Option<String>,
}

#[tauri::command]
pub fn chat_store_database_url(app: AppHandle) -> Result<String, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Diretório de dados Tauri indisponível: {error}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|error| {
        format!("Não foi possível preparar o diretório de dados do chat: {error}")
    })?;
    Ok(format!(
        "sqlite:{}",
        data_dir.join(DATABASE_FILE).to_string_lossy()
    ))
}

#[tauri::command]
pub async fn initialize_chat_store(
    app: AppHandle,
    database_url: String,
    legacy_json: Option<String>,
) -> Result<ChatStoreInit, String> {
    let pool = app_pool(app, database_url).await?;
    let runtime = tokio::runtime::Handle::current();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.block_on(initialize_pool(&pool, legacy_json.as_deref()))
    })
    .await
    .map_err(|error| format!("Falha na inicialização do SQLite: {error}"))?
}

#[tauri::command]
pub async fn save_chat_store(
    app: AppHandle,
    database_url: String,
    conversations: Vec<ChatConversation>,
) -> Result<(), String> {
    let pool = app_pool(app, database_url).await?;
    let runtime = tokio::runtime::Handle::current();
    tauri::async_runtime::spawn_blocking(move || runtime.block_on(save_pool(&pool, &conversations)))
        .await
        .map_err(|error| format!("Falha ao gravar no SQLite: {error}"))?
}

async fn app_pool(app: AppHandle, database_url: String) -> Result<SqlitePool, String> {
    let expected_path = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Diretório de dados Tauri indisponível: {error}"))?
        .join(DATABASE_FILE);
    let expected_url = format!("sqlite:{}", expected_path.to_string_lossy());
    if database_url != expected_url {
        return Err(
            "SQLite indisponível: caminho do banco fora do diretório de dados do app".into(),
        );
    }
    let instances = app.state::<DbInstances>();
    let databases = instances.0.read().await;
    match databases.get(&database_url) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        None => Err("SQLite indisponível: o banco do chat não foi carregado".into()),
    }
}

fn decode_legacy_conversations(raw: &str) -> Result<Vec<ChatConversation>, String> {
    let value: Value = serde_json::from_str(raw).map_err(|_| "JSON legado inválido".to_owned())?;
    let conversations = value
        .as_array()
        .ok_or_else(|| "O histórico legado deve ser uma lista de conversas".to_owned())?;
    let mut ids = HashSet::new();
    conversations
        .iter()
        .enumerate()
        .map(|(conversation_index, conversation)| {
            let object = conversation
                .as_object()
                .ok_or_else(|| format!("Conversa {conversation_index} inválida"))?;
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| format!("Conversa {conversation_index} sem ID válido"))?
                .to_owned();
            if !ids.insert(id.clone()) {
                return Err(format!("ID de conversa duplicado: {id}"));
            }
            let title = object
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let updated_at = object.get("updatedAt").and_then(json_i64);
            let messages_value = object.get("messages");
            let messages = match messages_value {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(items)) => items
                    .iter()
                    .enumerate()
                    .map(|(message_index, message)| {
                        decode_legacy_message(message, &id, message_index)
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => return Err(format!("Lista de mensagens inválida na conversa {id}")),
            };
            Ok(ChatConversation {
                id,
                title,
                updated_at,
                messages,
            })
        })
        .collect()
}

fn decode_legacy_message(
    value: &Value,
    conversation_id: &str,
    index: usize,
) -> Result<ChatMessage, String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("Mensagem {index} inválida em {conversation_id}"))?;
    let role_value = object
        .get("role")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Mensagem {index} sem papel válido"))?;
    let role = ChatRole::parse(role_value)
        .ok_or_else(|| format!("Papel desconhecido na mensagem {index}"))?;
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Mensagem {index} sem conteúdo textual"))?
        .to_owned();
    let raw_id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty());
    let id = raw_id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{conversation_id}-legacy-{index}"));
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let created_at = object.get("createdAt").and_then(json_i64);
    let request_id = object
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let delivery = match object.get("delivery").and_then(Value::as_str) {
        Some("pending") => Some("failed".to_owned()),
        Some(value @ ("sent" | "failed")) => Some(value.to_owned()),
        None => None,
        Some(_) => return Err(format!("Estado de envio desconhecido na mensagem {index}")),
    };
    let metrics = object
        .get("metrics")
        .and_then(Value::as_object)
        .map(|metrics| MessageMetrics {
            first_content_ms: metrics.get("firstContentMs").and_then(Value::as_f64),
            total_elapsed_ms: metrics.get("totalElapsedMs").and_then(Value::as_f64),
            ollama_total_ms: metrics.get("ollamaTotalMs").and_then(Value::as_f64),
            tokens_per_second: metrics.get("tokensPerSecond").and_then(Value::as_f64),
        });
    Ok(ChatMessage {
        id,
        role,
        content,
        model,
        created_at,
        request_id,
        delivery,
        metrics,
    })
}

fn json_i64(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.is_finite() && number.fract() == 0.0)
            .map(|number| number as i64)
    })
}

async fn initialize_pool(
    pool: &SqlitePool,
    legacy_json: Option<&str>,
) -> Result<ChatStoreInit, String> {
    ensure_schema(pool).await?;
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let marker = sqlx::query("SELECT value FROM app_metadata WHERE key = ?1")
        .bind(IMPORT_KEY)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?;
    let (import_status, warning) = if marker.is_some() {
        ("alreadyImported".to_owned(), None)
    } else {
        match legacy_json {
            None => {
                set_import_marker(&mut transaction, "noLegacyKey").await?;
                ("empty".to_owned(), None)
            }
            Some(raw) => match decode_legacy_conversations(raw) {
                Ok(conversations) => {
                    insert_imported(&mut transaction, &conversations).await?;
                    set_import_marker(&mut transaction, "imported").await?;
                    ("imported".to_owned(), None)
                }
                Err(reason) => ("invalid".to_owned(), Some(reason)),
            },
        }
    };
    sqlx::query("UPDATE messages SET delivery = 'failed' WHERE delivery = 'pending'")
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    let conversations = load_pool(pool).await?;
    Ok(ChatStoreInit {
        conversations,
        import_status,
        warning,
    })
}

async fn ensure_schema(pool: &SqlitePool) -> Result<(), String> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    sqlx::query("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, description TEXT NOT NULL, applied_at INTEGER NOT NULL DEFAULT (unixepoch()))")
        .execute(&mut *transaction).await.map_err(database_error)?;
    let version: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM schema_migrations")
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
    if version.unwrap_or(0) < 1 {
        sqlx::raw_sql(MIGRATION_V1)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
        sqlx::query("INSERT INTO schema_migrations (version, description) VALUES (1, 'create_conversations_and_messages')")
            .execute(&mut *transaction).await.map_err(database_error)?;
    }
    transaction.commit().await.map_err(database_error)
}

async fn set_import_marker(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    value: &str,
) -> Result<(), String> {
    sqlx::query("INSERT INTO app_metadata (key, value) VALUES (?1, ?2)")
        .bind(IMPORT_KEY)
        .bind(value)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
    Ok(())
}

async fn insert_imported(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    conversations: &[ChatConversation],
) -> Result<(), String> {
    for (position, conversation) in conversations.iter().enumerate() {
        sqlx::query(
            "INSERT INTO conversations (id, title, updated_at, position) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(&conversation.id)
        .bind(&conversation.title)
        .bind(conversation.updated_at)
        .bind(position as i64)
        .execute(&mut **transaction)
        .await
        .map_err(database_error)?;
        for (message_position, message) in conversation.messages.iter().enumerate() {
            insert_message(transaction, &conversation.id, message_position, message).await?;
        }
    }
    Ok(())
}

async fn insert_message(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    conversation_id: &str,
    position: usize,
    message: &ChatMessage,
) -> Result<(), String> {
    let metrics = message.metrics.as_ref();
    sqlx::query("INSERT INTO messages (conversation_id, id, position, role, content, model, created_at, request_id, delivery, first_content_ms, total_elapsed_ms, ollama_total_ms, tokens_per_second) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)")
        .bind(conversation_id).bind(&message.id).bind(position as i64).bind(message.role.as_str()).bind(&message.content)
        .bind(&message.model).bind(message.created_at).bind(&message.request_id).bind(&message.delivery)
        .bind(metrics.and_then(|metrics| metrics.first_content_ms))
        .bind(metrics.and_then(|metrics| metrics.total_elapsed_ms))
        .bind(metrics.and_then(|metrics| metrics.ollama_total_ms))
        .bind(metrics.and_then(|metrics| metrics.tokens_per_second))
        .execute(&mut **transaction).await.map_err(database_error)?;
    Ok(())
}

async fn save_pool(pool: &SqlitePool, conversations: &[ChatConversation]) -> Result<(), String> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    for (position, conversation) in conversations.iter().enumerate() {
        sqlx::query("INSERT INTO conversations (id, title, updated_at, position) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, position=excluded.position")
            .bind(&conversation.id).bind(&conversation.title).bind(conversation.updated_at).bind(position as i64)
            .execute(&mut *transaction).await.map_err(database_error)?;
        for (message_position, message) in conversation.messages.iter().enumerate() {
            let metrics = message.metrics.as_ref();
            sqlx::query("INSERT INTO messages (conversation_id, id, position, role, content, model, created_at, request_id, delivery, first_content_ms, total_elapsed_ms, ollama_total_ms, tokens_per_second) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) ON CONFLICT(conversation_id, id) DO UPDATE SET position=excluded.position, role=excluded.role, content=excluded.content, model=excluded.model, created_at=excluded.created_at, request_id=excluded.request_id, delivery=excluded.delivery, first_content_ms=excluded.first_content_ms, total_elapsed_ms=excluded.total_elapsed_ms, ollama_total_ms=excluded.ollama_total_ms, tokens_per_second=excluded.tokens_per_second")
                .bind(&conversation.id).bind(&message.id).bind(message_position as i64).bind(message.role.as_str()).bind(&message.content)
                .bind(&message.model).bind(message.created_at).bind(&message.request_id).bind(&message.delivery)
                .bind(metrics.and_then(|metrics| metrics.first_content_ms))
                .bind(metrics.and_then(|metrics| metrics.total_elapsed_ms))
                .bind(metrics.and_then(|metrics| metrics.ollama_total_ms))
                .bind(metrics.and_then(|metrics| metrics.tokens_per_second))
                .execute(&mut *transaction).await.map_err(database_error)?;
        }
    }
    transaction.commit().await.map_err(database_error)
}

async fn load_pool(pool: &SqlitePool) -> Result<Vec<ChatConversation>, String> {
    let mut transaction = pool.begin().await.map_err(database_error)?;
    let conversation_rows =
        sqlx::query("SELECT id, title, updated_at FROM conversations ORDER BY position, rowid")
            .fetch_all(&mut *transaction)
            .await
            .map_err(database_error)?;
    let mut conversations = Vec::with_capacity(conversation_rows.len());
    for row in conversation_rows {
        let id: String = row.try_get("id").map_err(database_error)?;
        let message_rows = sqlx::query("SELECT id, role, content, model, created_at, request_id, delivery, first_content_ms, total_elapsed_ms, ollama_total_ms, tokens_per_second FROM messages WHERE conversation_id = ?1 ORDER BY position, rowid")
            .bind(&id).fetch_all(&mut *transaction).await.map_err(database_error)?;
        let mut messages = Vec::with_capacity(message_rows.len());
        for message in message_rows {
            let role: String = message.try_get("role").map_err(database_error)?;
            let role = ChatRole::parse(&role)
                .ok_or_else(|| "Banco SQLite contém papel de mensagem inválido".to_owned())?;
            let first_content_ms: Option<f64> = message
                .try_get("first_content_ms")
                .map_err(database_error)?;
            let total_elapsed_ms: Option<f64> = message
                .try_get("total_elapsed_ms")
                .map_err(database_error)?;
            let ollama_total_ms: Option<f64> =
                message.try_get("ollama_total_ms").map_err(database_error)?;
            let tokens_per_second: Option<f64> = message
                .try_get("tokens_per_second")
                .map_err(database_error)?;
            let metrics = [
                first_content_ms,
                total_elapsed_ms,
                ollama_total_ms,
                tokens_per_second,
            ]
            .iter()
            .any(Option::is_some)
            .then_some(MessageMetrics {
                first_content_ms,
                total_elapsed_ms,
                ollama_total_ms,
                tokens_per_second,
            });
            messages.push(ChatMessage {
                id: message.try_get("id").map_err(database_error)?,
                role,
                content: message.try_get("content").map_err(database_error)?,
                model: message.try_get("model").map_err(database_error)?,
                created_at: message.try_get("created_at").map_err(database_error)?,
                request_id: message.try_get("request_id").map_err(database_error)?,
                delivery: message.try_get("delivery").map_err(database_error)?,
                metrics,
            });
        }
        conversations.push(ChatConversation {
            id,
            title: row.try_get("title").map_err(database_error)?,
            updated_at: row.try_get("updated_at").map_err(database_error)?,
            messages,
        });
    }
    transaction.commit().await.map_err(database_error)?;
    Ok(conversations)
}

fn database_error(error: impl std::fmt::Display) -> String {
    format!("Erro SQLite: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::{
        path::PathBuf,
        str::FromStr,
        time::{SystemTime, UNIX_EPOCH},
    };

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        ensure_schema(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn imports_empty_history_once_and_rejects_invalid_json_without_erasing_it() {
        let empty_pool = test_pool().await;
        let empty = initialize_pool(&empty_pool, Some("[]")).await.unwrap();
        assert_eq!(empty.import_status, "imported");
        assert!(empty.conversations.is_empty());
        assert_eq!(
            initialize_pool(&empty_pool, Some("[]"))
                .await
                .unwrap()
                .import_status,
            "alreadyImported"
        );

        let invalid_pool = test_pool().await;
        let invalid = initialize_pool(&invalid_pool, Some("not-json"))
            .await
            .unwrap();
        assert_eq!(invalid.import_status, "invalid");
        assert!(invalid.warning.is_some());
        assert!(invalid.conversations.is_empty());
        let marker = sqlx::query("SELECT value FROM app_metadata WHERE key = ?1")
            .bind(IMPORT_KEY)
            .fetch_optional(&invalid_pool)
            .await
            .unwrap();
        assert!(marker.is_none());
    }

    #[tokio::test]
    async fn applies_the_schema_migration_once_with_foreign_keys() {
        let pool = test_pool().await;
        ensure_schema(&pool).await.unwrap();
        let versions: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(versions, vec![1]);
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(foreign_keys, 1);
        assert!(sqlx::query("INSERT INTO messages (conversation_id, id, position, role, content) VALUES ('missing', 'orphan', 0, 'user', 'x')")
            .execute(&pool).await.is_err());
    }

    #[tokio::test]
    async fn imports_legacy_messages_in_order_without_inventing_metadata_and_is_repeatable() {
        let pool = test_pool().await;
        let legacy = r#"[
          {"id":"conversation-1","title":"Histórico legado","updatedAt":1700000000000,"messages":[
            {"role":"user","content":"Pergunta antiga"},
            {"id":"answer-1","role":"assistant","content":"Resposta antiga","model":"qwen:latest","createdAt":1700000000100,"requestId":"request-1","delivery":"sent"},
            {"id":"pending-1","role":"user","content":"Interrompida","delivery":"pending"}
          ]},
          {"id":"conversation-2","messages":[]}
        ]"#;
        let first = initialize_pool(&pool, Some(legacy)).await.unwrap();
        assert_eq!(first.import_status, "imported");
        assert_eq!(first.conversations.len(), 2);
        assert_eq!(
            first.conversations[0].messages[0].id,
            "conversation-1-legacy-0"
        );
        assert_eq!(first.conversations[0].messages[0].model, None);
        assert_eq!(first.conversations[0].messages[0].created_at, None);
        assert_eq!(
            first.conversations[0].messages[1].content,
            "Resposta antiga"
        );
        assert_eq!(
            first.conversations[0].messages[1].created_at,
            Some(1700000000100)
        );
        assert_eq!(
            first.conversations[0].messages[2].delivery.as_deref(),
            Some("failed")
        );
        let second = initialize_pool(&pool, Some(legacy)).await.unwrap();
        assert_eq!(second.import_status, "alreadyImported");
        assert_eq!(second.conversations[0].messages.len(), 3);
    }

    #[tokio::test]
    async fn rejects_malformed_conversations_atomically() {
        let pool = test_pool().await;
        let invalid = r#"[{"id":"would-be-partial","messages":[{"role":"system","content":"ok"}]},{"id":"bad","messages":[{"role":"other","content":"bad"}]}]"#;
        let result = initialize_pool(&pool, Some(invalid)).await.unwrap();
        assert_eq!(result.import_status, "invalid");
        assert!(result.conversations.is_empty());
        let marker = sqlx::query("SELECT value FROM app_metadata WHERE key = ?1")
            .bind(IMPORT_KEY)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(marker.is_none());
    }

    #[tokio::test]
    async fn close_and_reopen_preserves_history_and_failed_writes_rollback() {
        let path: PathBuf = std::env::temp_dir().join(format!(
            "jarvis-chat-store-{}-{}.db",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let options = SqliteConnectOptions::from_str(&format!("sqlite:{}", path.display()))
            .unwrap()
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .unwrap();
        ensure_schema(&pool).await.unwrap();
        let conversation = ChatConversation {
            id: "atomic".into(),
            title: Some("Transação".into()),
            updated_at: Some(42),
            messages: vec![
                ChatMessage {
                    id: "answer-1".into(),
                    role: ChatRole::Assistant,
                    content: "Um".into(),
                    model: Some("m".into()),
                    created_at: Some(42),
                    request_id: Some("same-request".into()),
                    delivery: Some("sent".into()),
                    metrics: None,
                },
                ChatMessage {
                    id: "answer-2".into(),
                    role: ChatRole::Assistant,
                    content: "Duplicada".into(),
                    model: Some("m".into()),
                    created_at: Some(43),
                    request_id: Some("same-request".into()),
                    delivery: Some("sent".into()),
                    metrics: None,
                },
            ],
        };
        let error = save_pool(&pool, &[conversation]).await.unwrap_err();
        assert!(error.starts_with("Erro SQLite:"));
        assert!(
            load_pool(&pool).await.unwrap().is_empty(),
            "a transação falha não deve salvar metade do histórico"
        );
        pool.close().await;

        let reopened = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .unwrap();
        let saved = ChatConversation {
            id: "saved".into(),
            title: Some("Persistida".into()),
            updated_at: Some(99),
            messages: vec![ChatMessage {
                id: "q".into(),
                role: ChatRole::User,
                content: "Conteúdo preservado".into(),
                model: None,
                created_at: None,
                request_id: None,
                delivery: Some("sent".into()),
                metrics: None,
            }],
        };
        save_pool(&reopened, std::slice::from_ref(&saved))
            .await
            .unwrap();
        reopened.close().await;
        let reopened_again = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let loaded = load_pool(&reopened_again).await.unwrap();
        assert_eq!(loaded, vec![saved]);
        reopened_again.close().await;
        let _ = std::fs::remove_file(path);
    }
}
