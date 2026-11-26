export function copyResponseText(
  text: string,
  clipboard?: { writeText: (value: string) => Promise<void> },
  documentObject?: Document,
): Promise<void>;
