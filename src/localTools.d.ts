import type { LocalEntry, LocalIntent, LocalToolResult, TargetKind } from "./ollamaService";

export type LocalReference = { mode: "position"; index: number } | { mode: "name"; name: string } | { mode: "recent" };
export type LocalList = { entries: LocalEntry[]; truncated: boolean; intent: LocalIntent; selectedPath?: string };
export type LocalOutput = { result: LocalToolResult; list?: LocalList; recent?: LocalEntry };

export const LOCAL_TOOL_MODEL: string;
export function localActionFor(input: string): LocalIntent | null;
export function localRequestFor(input: string): { intent: LocalIntent; selectedPath?: string; reference?: LocalReference } | null;
export function localRequestFor(input: string, pendingChoice?: LocalIntent): { intent: LocalIntent; selectedPath?: string; reference?: LocalReference } | null;
export function localResultText(result: LocalToolResult, includePaths?: boolean): string;
export function resolveLocalReference(reference: LocalReference, kind: TargetKind | undefined, list: LocalList | undefined, recent?: LocalEntry):
  { entry: LocalEntry } | { choices: LocalEntry[] } | { message: string };
export function isSameLocalList(list: LocalList, result: LocalToolResult): boolean;
export function latestLocalContext(messages: readonly { id?: string }[], outputs: Record<string, LocalOutput>):
  { list?: LocalList; recent?: LocalEntry };
