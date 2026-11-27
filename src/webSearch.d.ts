export type WebSource = { title: string; url: string };
export function searchQueryFor(message: string, options?: { systemQuestion?: boolean; history?: readonly { role: string; content: string; delivery?: string }[] }): string | undefined;
export function appendWebSources(answer: string, sources?: WebSource[]): string;
export function withoutWebSources(answer: string): string;
export function webSourcesMarkdown(answer: string): string;
