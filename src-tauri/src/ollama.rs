use std::{net::IpAddr, time::Duration};

use futures_util::StreamExt;
use reqwest::{Client, Response, Url};
use serde::{Deserialize, Serialize};

const MODEL_LIST_TIMEOUT: Duration = Duration::from_secs(3);
const CHAT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OllamaErrorKind {
    Configuration,
    Connection,
    Timeout,
    ModelNotFound,
    Http,
    InvalidResponse,
    EmptyResponse,
    ChannelClosed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OllamaError {
    pub kind: OllamaErrorKind,
    pub message: String,
    pub status: Option<u16>,
}

impl OllamaError {
    fn new(kind: OllamaErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
        }
    }

    fn http(status: u16, message: impl Into<String>) -> Self {
        let kind = if status == 404 {
            OllamaErrorKind::ModelNotFound
        } else {
            OllamaErrorKind::Http
        };
        Self {
            kind,
            message: message.into(),
            status: Some(status),
        }
    }

    pub fn channel_closed() -> Self {
        Self::new(
            OllamaErrorKind::ChannelClosed,
            "A janela deixou de receber a resposta.",
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OllamaModel {
    pub name: String,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletion {
    pub model: String,
    pub content: String,
    pub total_duration: Option<u64>,
    pub load_duration: Option<u64>,
    pub prompt_eval_duration: Option<u64>,
    pub eval_duration: Option<u64>,
    pub prompt_eval_count: Option<u64>,
    pub eval_count: Option<u64>,
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Deserialize)]
struct ApiErrorResponse {
    error: Option<String>,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    think: Option<bool>,
}

#[derive(Deserialize)]
struct StreamChunk {
    model: Option<String>,
    message: Option<StreamMessage>,
    error: Option<String>,
    done: Option<bool>,
    total_duration: Option<u64>,
    load_duration: Option<u64>,
    prompt_eval_duration: Option<u64>,
    eval_duration: Option<u64>,
    prompt_eval_count: Option<u64>,
    eval_count: Option<u64>,
}

#[derive(Deserialize)]
struct StreamMessage {
    content: Option<String>,
}

fn base_url(value: &str) -> Result<Url, OllamaError> {
    let parsed = Url::parse(value.trim()).map_err(|_| {
        OllamaError::new(
            OllamaErrorKind::Configuration,
            "O endereço do Ollama é inválido.",
        )
    })?;
    let host = parsed.host_str().unwrap_or_default();
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false);
    if !matches!(parsed.scheme(), "http" | "https")
        || !loopback
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(OllamaError::new(
            OllamaErrorKind::Configuration,
            "O Ollama deve usar um endereço HTTP local (localhost ou loopback).",
        ));
    }
    Ok(parsed)
}

fn endpoint(base: &str, path: &str) -> Result<Url, OllamaError> {
    let mut url = base_url(base)?;
    let base_path = url.path().trim_end_matches('/');
    url.set_path(&format!("{base_path}{path}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn client(timeout: Duration) -> Result<Client, OllamaError> {
    Client::builder().timeout(timeout).build().map_err(|error| {
        OllamaError::new(
            OllamaErrorKind::Configuration,
            format!("Não foi possível preparar a conexão local: {error}"),
        )
    })
}

fn transport_error(error: reqwest::Error) -> OllamaError {
    if error.is_timeout() {
        OllamaError::new(
            OllamaErrorKind::Timeout,
            "O Ollama excedeu o tempo limite da solicitação.",
        )
    } else if error.is_connect() {
        OllamaError::new(
            OllamaErrorKind::Connection,
            "Não foi possível conectar ao Ollama local. Verifique se `ollama serve` está ativo.",
        )
    } else {
        OllamaError::new(
            OllamaErrorKind::InvalidResponse,
            format!("Falha ao ler a resposta do Ollama: {error}"),
        )
    }
}

async fn http_error(response: Response) -> OllamaError {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<ApiErrorResponse>(&body)
        .ok()
        .and_then(|error| error.error)
        .filter(|message| !message.trim().is_empty());
    let message = match (status, detail) {
        (404, Some(detail)) => format!("Modelo ou rota não encontrado (HTTP 404): {detail}"),
        (404, None) => {
            "Modelo ou rota não encontrado (HTTP 404). Confira a tag do modelo e o endpoint."
                .to_string()
        }
        (500, Some(detail)) => format!("Ollama retornou erro interno (HTTP 500): {detail}"),
        (500, None) => "Ollama retornou erro interno (HTTP 500).".to_string(),
        (_, Some(detail)) => format!("Ollama respondeu com erro HTTP {status}: {detail}"),
        (_, None) => format!("Ollama respondeu com erro HTTP {status}."),
    };
    OllamaError::http(status, message)
}

pub async fn list_models(base: &str) -> Result<Vec<OllamaModel>, OllamaError> {
    list_models_with_timeout(base, MODEL_LIST_TIMEOUT).await
}

async fn list_models_with_timeout(
    base: &str,
    timeout: Duration,
) -> Result<Vec<OllamaModel>, OllamaError> {
    let url = endpoint(base, "/api/tags")?;
    let response = client(timeout)?
        .get(url)
        .send()
        .await
        .map_err(transport_error)?;
    if !response.status().is_success() {
        return Err(http_error(response).await);
    }
    let parsed = response.json::<TagsResponse>().await.map_err(|_| {
        OllamaError::new(
            OllamaErrorKind::InvalidResponse,
            "Ollama retornou uma lista de modelos inválida.",
        )
    })?;
    Ok(parsed.models)
}

pub async fn chat<F>(
    base: &str,
    model: &str,
    messages: &[ChatMessage],
    think: Option<bool>,
    mut on_content: F,
) -> Result<ChatCompletion, OllamaError>
where
    F: FnMut(String) -> Result<(), OllamaError> + Send,
{
    let url = endpoint(base, "/api/chat")?;
    let response = client(CHAT_TIMEOUT)?
        .post(url)
        .json(&ChatRequest {
            model,
            messages,
            stream: true,
            think,
        })
        .send()
        .await
        .map_err(transport_error)?;
    if !response.status().is_success() {
        return Err(http_error(response).await);
    }

    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    let mut final_chunk: Option<StreamChunk> = None;
    let mut content = String::new();
    while let Some(next) = stream.next().await {
        let bytes = next.map_err(transport_error)?;
        for byte in bytes {
            if byte == b'\n' {
                process_stream_line(&pending, &mut on_content, &mut final_chunk, &mut content)?;
                pending.clear();
            } else {
                pending.push(byte);
            }
        }
    }
    if !pending.iter().all(u8::is_ascii_whitespace) {
        process_stream_line(&pending, &mut on_content, &mut final_chunk, &mut content)?;
    }

    let Some(final_chunk) = final_chunk else {
        return Err(OllamaError::new(
            OllamaErrorKind::InvalidResponse,
            "Ollama encerrou o fluxo sem indicar que a resposta terminou.",
        ));
    };
    if content.trim().is_empty() {
        return Err(OllamaError::new(
            OllamaErrorKind::EmptyResponse,
            "O modelo encerrou a geração sem retornar conteúdo.",
        ));
    }
    Ok(ChatCompletion {
        model: final_chunk.model.unwrap_or_else(|| model.to_string()),
        content,
        total_duration: final_chunk.total_duration,
        load_duration: final_chunk.load_duration,
        prompt_eval_duration: final_chunk.prompt_eval_duration,
        eval_duration: final_chunk.eval_duration,
        prompt_eval_count: final_chunk.prompt_eval_count,
        eval_count: final_chunk.eval_count,
    })
}

fn process_stream_line<F>(
    line: &[u8],
    on_content: &mut F,
    final_chunk: &mut Option<StreamChunk>,
    content: &mut String,
) -> Result<(), OllamaError>
where
    F: FnMut(String) -> Result<(), OllamaError>,
{
    if line.iter().all(u8::is_ascii_whitespace) {
        return Ok(());
    }
    let chunk = serde_json::from_slice::<StreamChunk>(line).map_err(|_| {
        OllamaError::new(
            OllamaErrorKind::InvalidResponse,
            "Ollama retornou um trecho de resposta inválido.",
        )
    })?;
    if let Some(error) = chunk
        .error
        .as_deref()
        .filter(|error| !error.trim().is_empty())
    {
        let kind = if error.to_ascii_lowercase().contains("model")
            && (error.to_ascii_lowercase().contains("not found")
                || error.to_ascii_lowercase().contains("does not exist"))
        {
            OllamaErrorKind::ModelNotFound
        } else {
            OllamaErrorKind::Http
        };
        return Err(OllamaError {
            kind,
            message: format!("Ollama falhou durante a geração: {error}"),
            status: None,
        });
    }
    if let Some(text) = chunk
        .message
        .as_ref()
        .and_then(|message| message.content.as_deref())
        .filter(|text| !text.is_empty())
    {
        content.push_str(text);
        on_content(text.to_string())?;
    }
    if chunk.done.unwrap_or(false) {
        *final_chunk = Some(chunk);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn mock_response(status: u16, body: &'static str) -> (String, thread::JoinHandle<Vec<u8>>) {
        mock_response_after(status, body, Duration::ZERO)
    }

    fn mock_response_after(
        status: u16,
        body: &'static str,
        delay: Duration,
    ) -> (String, thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback mock server");
        let address = listener.local_addr().expect("mock address");
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept request");
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set read timeout");
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let read = socket.read(&mut buffer).expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                let headers_end = request.windows(4).position(|part| part == b"\r\n\r\n");
                if let Some(index) = headers_end {
                    let headers = String::from_utf8_lossy(&request[..index]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= index + 4 + length {
                        break;
                    }
                }
            }
            let status_text = if status < 400 {
                "OK"
            } else if status == 404 {
                "Not Found"
            } else {
                "Internal Server Error"
            };
            let response = format!(
                "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            thread::sleep(delay);
            let _ = socket.write_all(response.as_bytes());
            request
        });
        (format!("http://{address}"), server)
    }

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn accepts_only_local_ollama_endpoints() {
        assert!(base_url("http://127.0.0.1:11434").is_ok());
        assert!(base_url("http://localhost:11434").is_ok());
        assert!(base_url("http://192.168.1.5:11434").is_err());
        assert!(base_url("https://ollama.com").is_err());
    }

    #[test]
    fn lists_models_from_a_simulated_service() {
        let (url, server) = mock_response(
            200,
            r#"{"models":[{"name":"qwen3.5:4b","model":"qwen3.5:4b"}]}"#,
        );
        let models = run(list_models(&url)).expect("model list");
        assert_eq!(models[0].name, "qwen3.5:4b");
        server.join().expect("mock server");
    }

    #[test]
    fn distinguishes_http_404_500_invalid_and_connection_errors() {
        for (status, kind) in [
            (404, OllamaErrorKind::ModelNotFound),
            (500, OllamaErrorKind::Http),
        ] {
            let (url, server) = mock_response(status, r#"{"error":"simulated failure"}"#);
            let result = run(list_models(&url)).expect_err("HTTP failure expected");
            assert_eq!(result.kind, kind);
            assert_eq!(result.status, Some(status));
            server.join().expect("mock server");
        }

        let (url, server) = mock_response(200, "not-json");
        let result = run(list_models(&url)).expect_err("invalid response expected");
        assert_eq!(result.kind, OllamaErrorKind::InvalidResponse);
        server.join().expect("mock server");

        let listener = TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let unused = format!("http://{}", listener.local_addr().expect("local address"));
        drop(listener);
        let result = run(list_models(&unused)).expect_err("connection error expected");
        assert_eq!(result.kind, OllamaErrorKind::Connection);
    }

    #[test]
    fn reports_timeout_and_recovers_after_a_model_error() {
        let (url, server) =
            mock_response_after(200, r#"{"models":[]}"#, Duration::from_millis(100));
        let result = run(list_models_with_timeout(&url, Duration::from_millis(10)))
            .expect_err("timeout expected");
        assert_eq!(result.kind, OllamaErrorKind::Timeout);
        server.join().expect("mock server");

        let (missing_url, missing_server) = mock_response(404, r#"{"error":"model not found"}"#);
        let failure = run(chat(&missing_url, "missing:latest", &[], None, |_| Ok(())))
            .expect_err("model missing expected");
        assert_eq!(failure.kind, OllamaErrorKind::ModelNotFound);
        missing_server.join().expect("mock server");

        let (success_url, success_server) = mock_response(
            200,
            concat!(
                r#"{"model":"qwen3.5:4b","message":{"content":"OK"},"done":true}"#,
                "\n"
            ),
        );
        let success = run(chat(&success_url, "qwen3.5:4b", &[], None, |_| Ok(())))
            .expect("success after failure");
        assert_eq!(success.content, "OK");
        success_server.join().expect("mock server");
    }

    #[test]
    fn streams_chat_and_preserves_model_history_and_metrics() {
        let body = concat!(
            r#"{"model":"qwen3.5:4b","message":{"content":"Olá"},"done":false}"#,
            "\n",
            r#"{"model":"qwen3.5:4b","message":{"content":"!"},"done":true,"total_duration":100,"load_duration":2,"prompt_eval_duration":3,"eval_duration":4,"prompt_eval_count":5,"eval_count":2}"#,
            "\n"
        );
        let (url, server) = mock_response(200, body);
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "Oi".into(),
        }];
        let mut fragments = Vec::new();
        let result = run(chat(&url, "qwen3.5:4b", &messages, Some(false), |part| {
            fragments.push(part);
            Ok(())
        }))
        .expect("chat response");
        assert_eq!(fragments, ["Olá", "!"]);
        assert_eq!(result.model, "qwen3.5:4b");
        assert_eq!(result.content, "Olá!");
        assert_eq!(result.eval_count, Some(2));
        let request_bytes = server.join().expect("mock server");
        let request = String::from_utf8_lossy(&request_bytes);
        assert!(request.contains("\"think\":false"));
        assert!(request.contains("\"content\":\"Oi\""));
    }

    #[test]
    fn reports_malformed_stream_and_empty_answer() {
        for (body, kind) in [
            ("not-json", OllamaErrorKind::InvalidResponse),
            (r#"{"done":true}"#, OllamaErrorKind::EmptyResponse),
        ] {
            let (url, server) = mock_response(200, body);
            let result = run(chat(&url, "qwen3.5:4b", &[], None, |_| Ok(())))
                .expect_err("chat error expected");
            assert_eq!(result.kind, kind);
            server.join().expect("mock server");
        }
    }

    #[test]
    fn identifies_model_missing_reported_inside_stream() {
        let (url, server) = mock_response(200, r#"{"error":"model 'missing:latest' not found"}"#);
        let result = run(chat(&url, "missing:latest", &[], None, |_| Ok(())))
            .expect_err("model missing expected");
        assert_eq!(result.kind, OllamaErrorKind::ModelNotFound);
        server.join().expect("mock server");
    }

    #[test]
    #[ignore = "requires JARVIS_OLLAMA_REAL_TEST=1 and a running local Ollama server"]
    fn talks_to_the_configured_local_ollama() {
        assert_eq!(std::env::var("JARVIS_OLLAMA_REAL_TEST").as_deref(), Ok("1"));
        let base = std::env::var("JARVIS_OLLAMA_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:11434".into());
        let model = std::env::var("JARVIS_OLLAMA_MODEL").unwrap_or_else(|_| "qwen3.5:4b".into());
        let available = run(list_models(&base)).expect("local Ollama model list");
        assert!(
            available
                .iter()
                .any(|item| item.name == model || item.model.as_deref() == Some(&model))
        );
        let messages = [ChatMessage {
            role: "user".into(),
            content: "Responda apenas com OK.".into(),
        }];
        let completion = run(chat(&base, &model, &messages, Some(false), |_| Ok(())))
            .expect("local Ollama response");
        assert!(!completion.content.trim().is_empty());
    }
}
