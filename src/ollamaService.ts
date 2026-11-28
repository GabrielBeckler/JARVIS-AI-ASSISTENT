import { Channel, invoke } from "@tauri-apps/api/core";
import type { WebSource } from "./webSearch.js";

export type LocalAction = "search" | "list_directory" | "read_file" | "open_project";
export type LocalEntry = { path: string; kind: "file" | "directory" };
export type LocalToolResult = { action: LocalAction; status: "success" | "ambiguous" | "error"; message: string; results: LocalEntry[]; path: string | null; content: string | null; truncated: boolean };

export type OllamaErrorKind = "configuration" | "connection" | "timeout" | "model_not_found" | "http" | "invalid_response" | "empty_response" | "channel_closed" | "cancelled" | "web_search";
export type OllamaError = { kind: OllamaErrorKind; message: string; status: number | null };
export type OllamaModel = { name: string; model?: string | null };
export type OllamaMessage = { role: "system" | "user" | "assistant"; content: string };
export type OllamaChatCompletion = {
  model: string;
  content: string;
  totalDuration: number | null;
  loadDuration: number | null;
  promptEvalDuration: number | null;
  evalDuration: number | null;
  promptEvalCount: number | null;
  evalCount: number | null;
  sources?: WebSource[];
};

export type OllamaRequest = { completion: Promise<OllamaChatCompletion> };

export function normalizeOllamaError(error: unknown): OllamaError {
  if (error && typeof error === "object" && "kind" in error && "message" in error) {
    const value = error as Partial<OllamaError>;
    return {
      kind: value.kind && ["configuration", "connection", "timeout", "model_not_found", "http", "invalid_response", "empty_response", "channel_closed", "cancelled", "web_search"].includes(value.kind)
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

export function cancelOllamaChat(requestId: string): Promise<boolean> {
  return invoke<boolean>("ollama_cancel_chat", { requestId });
}

export function executeLocalTool(action: LocalAction, query: string, selectedPath?: string): Promise<LocalToolResult> {
  return invoke<LocalToolResult>("local_tool_execute", { request: { action, query, selectedPath: selectedPath ?? null } });
}

export function streamOllamaChat(
  baseUrl: string,
  model: string,
  messages: OllamaMessage[],
  think: boolean | undefined,
  requestId: string,
  keepAlive: string,
  onContent: (content: string) => void,
  webQuery?: string,
): OllamaRequest {
  const onEvent = new Channel<{ content: string }>((event) => onContent(event.content));
  return {
    completion: invoke<OllamaChatCompletion>("ollama_chat", { baseUrl, model, messages, think, requestId, keepAlive, onEvent, webQuery }),
  };
}
