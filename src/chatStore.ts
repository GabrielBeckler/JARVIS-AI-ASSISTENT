import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import type { StoredConversation } from "./chat.js";

export type ChatStoreInit = {
  conversations: StoredConversation[];
  importStatus: "imported" | "alreadyImported" | "empty" | "invalid" | string;
  warning: string | null;
};

let writes = Promise.resolve();
let databaseUrl: Promise<string> | undefined;

async function ensureDatabase(): Promise<string> {
  if (!databaseUrl) {
    databaseUrl = invoke<string>("chat_store_database_url")
      .then(async (url) => {
        await Database.load(url);
        return url;
      })
      .catch((error) => {
        databaseUrl = undefined;
        throw error;
      });
  }
  return databaseUrl;
}

export async function initializeChatStore(legacyJson: string | null): Promise<ChatStoreInit> {
  const url = await ensureDatabase();
  return invoke<ChatStoreInit>("initialize_chat_store", { databaseUrl: url, legacyJson });
}

export function persistChatStore(conversations: StoredConversation[]): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(conversations)) as StoredConversation[];
  const save = async () => {
    const url = await ensureDatabase();
    await invoke<void>("save_chat_store", { databaseUrl: url, conversations: snapshot });
  };
  const pending = writes.then(save, save);
  writes = pending;
  return pending;
}
