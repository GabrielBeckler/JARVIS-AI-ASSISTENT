import { Channel, invoke } from "@tauri-apps/api/core";

export type OllamaErrorKind = "configuration" | "connection" | "timeout" | "model_not_found" | "http" | "invalid_response" | "empty_response" | "channel_closed";
export type OllamaError = { kind: OllamaErrorKind; message: string; status: number | null };
export type OllamaModel = { name: string; model?: string | null };
export type OllamaMessage = { role: "user" | "assistant"; content: string };
export type OllamaChatCompletion = {
  model: string;
  content: string;
  totalDuration: number | null;
  loadDuration: number | null;
  promptEvalDuration: number | null;
  evalDuration: number | null;
  promptEvalCount: number | null;
  evalCount: number | null;
};

export function normalizeOllamaError(error: unknown): OllamaError {
  if (error && typeof error === "object" && "kind" in error && "message" in error) {
    const value = error as Partial<OllamaError>;
    return {
      kind: value.kind && ["configuration", "connection", "timeout", "model_not_found", "http", "invalid_response", "empty_response", "channel_closed"].includes(value.kind)
        ? value.kind : "invalid_response",
      message: typeof value.message === "string" ? value.message : "Falha inesperada na comunicação com o Ollama.",
      status: typeof value.status === "number" ? value.status : null,
    };
  }
  return { kind: "invalid_response", message: typeof error === "string" ? error : "Falha inesperada na comunicação com o Ollama.", status: null };
}

export function listOllamaModels(baseUrl: string): Promise<OllamaModel[]> {
  return invoke<OllamaModel[]>("ollama_list_models", { baseUrl });
}

export function streamOllamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  think: boolean | undefined,
  onContent: (content: string) => void,
): Promise<OllamaChatCompletion> {
  const onEvent = new Channel<{ content: string }>((event) => onContent(event.content));
  return invoke<OllamaChatCompletion>("ollama_chat", { baseUrl, model, messages, think, onEvent });
}
