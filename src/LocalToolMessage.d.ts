import type { ReactNode } from "react";
import type { LocalEntry, LocalToolResult } from "./ollamaService";

export function LocalToolMessage(props: {
  result: LocalToolResult;
  onOpen: (entry: LocalEntry) => void;
  onChoose?: (entry: LocalEntry) => void;
  choosingDisabled?: boolean;
}): ReactNode;
