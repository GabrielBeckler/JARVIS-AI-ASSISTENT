export type ConversationShortcutAction = "new_conversation" | "focus_search";
export function getConversationShortcut(
  event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; repeat: boolean; defaultPrevented: boolean; isComposing: boolean },
  overlayOpen?: boolean,
): ConversationShortcutAction | null;
