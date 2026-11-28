import type { LocalIntent, LocalToolResult } from "./ollamaService";

export const LOCAL_TOOL_MODEL: string;
export function localActionFor(input: string): LocalIntent | null;
export function localRequestFor(input: string, pendingChoice?: LocalIntent): { intent: LocalIntent; selectedPath?: string } | null;
export function localResultText(result: LocalToolResult): string;
