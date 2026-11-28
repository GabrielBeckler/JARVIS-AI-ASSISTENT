import type { LocalIntent, LocalToolResult } from "./ollamaService";

export function localActionFor(input: string): LocalIntent | null;
export function localResultText(result: LocalToolResult): string;
