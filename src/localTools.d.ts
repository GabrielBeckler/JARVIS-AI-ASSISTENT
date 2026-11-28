import type { LocalToolResult } from "./ollamaService";

export type LocalIntent = { action: "search" | "list_directory" | "read_file" | "open_project"; query: string };
export function localActionFor(input: string): LocalIntent | null;
export function localResultText(result: LocalToolResult): string;
