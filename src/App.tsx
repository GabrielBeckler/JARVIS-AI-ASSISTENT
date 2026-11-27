import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { appendAssistantOnce, captureScrollPosition, createRequestContext, exportConversationMarkdown, getConversationDraft, isCurrentRequest, removeConversation, renameConversationTitle, restoreConversations, restoreScrollTop, setConversationDraft, updateConversationFlags, updateMessage, type StoredConversation } from "./chat.js";
import { isModelInstalled, limitChatContext, resolveChatThinking, toChatContext, type StoredMessage } from "./ollama.js";
import { cancelOllamaChat, listOllamaModels, normalizeOllamaError, streamOllamaChat } from "./ollamaService";
import { ConversationDialog } from "./ConversationDialog";
import { ConversationMenu } from "./ConversationMenu";
import { ThemedSelect } from "./ThemedSelect";
import { useLocalVoice } from "./useLocalVoice";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { SystemDashboard } from "./SystemDashboard";
import { exportMarkdownFile, initializeChatStore, persistChatStore } from "./chatStore";
import { dashboardTabs, nextDashboardTab } from "./dashboardTabs.js";
import { getSystemSnapshot } from "./systemMonitor";
import { createSystemContextPrompt, isSystemQuestion } from "./systemContext.js";
import { calculateComposerSize } from "./composerSizing.js";
import { copyResponseText } from "./clipboard.js";
import { sanitizeExportFilename } from "./exportFilename.js";
import { resolveConversationTitle, validateConversationTitle } from "./conversationTitle.js";
import { getConversationShortcut } from "./conversationShortcuts.js";
import { dropWithinSection, moveWithinSection, orderConversations, restoreSidebarPreferences, SIDEBAR_PREFERENCES_KEY, type SidebarFilter, type SidebarPreferences, type SidebarSorting } from "./sidebarPreferences.js";
import { clampLayoutWidths, getLayoutLimits, LAYOUT_STORAGE_KEY, resizeLayoutArea, restoreLayoutWidths, type LayoutWidths, type ResizableArea } from "./layoutSizing.js";
import "./App.css";

type Message = StoredMessage;
type Conversation = StoredConversation;
type Panel = "system" | "ai" | "project";
type ServiceStatus = "checking" | "available" | "unavailable";
type ModelStatus = "checking" | "missing" | "ready" | "unknown";
type ChatStoreStatus = "checking" | "ready" | "failed";
type StreamState = { requestId: string; content: string; model: string; createdAt: number; startedAt: number; firstContentMs: number | null };
type CopyFeedback = { label: string; failed: boolean };
type RenameDialogState = { conversationId: string; value: string };

function durationLabel(milliseconds: number | null | undefined): string {
  return milliseconds == null || !Number.isFinite(milliseconds) ? "N/D" : `${(milliseconds / 1000).toFixed(1)} s`;
}

const ollamaBaseUrl = (import.meta.env.VITE_OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const defaultModel = import.meta.env.VITE_OLLAMA_MODEL || "qwen3.5:4b";

const starter: Conversation = {
  id: "welcome",
  title: "Nova conversa",
  updatedAt: Date.now(),
  messages: [],
};

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    plus: <><path d="M12 5v14M5 12h14" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5 8 8 0 0 1-3.5-.8L4 20l1.4-4.2a7.5 7.5 0 1 1 14.6-4.3Z" /></>,
    folder: <><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.7-1.4-2.4L7.5 15a8 8 0 0 1 0-1.9l-1.4-1.2 1.4-2.4 1.7.7a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.7 1.4 2.4-1.4 1.2a8 8 0 0 1-.1 1.9Z" /></>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" /></>,
    speaker: <><path d="M11 5 6 9H3v6h3l5 4zM15 9a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    cpu: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9zM9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4" /></>,
    memory: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10v4m4-4v4m4-4v4m4-4v4" /></>,
    gpu: <><rect x="3" y="4" width="18" height="15" rx="2" /><circle cx="12" cy="11.5" r="3.5" /><path d="M7 19v2m10-2v2" /></>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2L12 3Z" /><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    edit: <><path d="m14 5 5 5" /><path d="m4 20 4.5-.9L19.2 8.4a2.1 2.1 0 0 0-3-3L5.5 16.1 4 20Z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.spark}</svg>;
}

function loadConversations(): Conversation[] {
  try {
    const saved = localStorage.getItem("jarvis.conversations");
    return restoreConversations(saved, [starter]);
  } catch {
    return [starter];
  }
}

function messageTime(createdAt?: number): string {
  if (!createdAt || !Number.isFinite(createdAt)) return "Horário desconhecido";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(createdAt));
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [chatStoreStatus, setChatStoreStatus] = useState<ChatStoreStatus>("checking");
  const [chatStoreError, setChatStoreError] = useState("");
  const [chatStoreWarning, setChatStoreWarning] = useState("");
  const [activeId, setActiveId] = useState(conversations[0]?.id ?? starter.id);
  const [draftsByConversation, setDraftsByConversation] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null);
  const [conversationMenu, setConversationMenu] = useState<{ id: string; anchor: HTMLButtonElement } | null>(null);
  const conversationMenuId = conversationMenu?.id;
  const [deleteDialogId, setDeleteDialogId] = useState<string | null>(null);
  const [conversationNotice, setConversationNotice] = useState("");
  const [sidebarPreferences, setSidebarPreferences] = useState<SidebarPreferences>(() => {
    try { return restoreSidebarPreferences(localStorage.getItem(SIDEBAR_PREFERENCES_KEY)); } catch { return restoreSidebarPreferences(null); }
  });
  const [sidebarSettingsOpen, setSidebarSettingsOpen] = useState(false);
  const [preferredWidths, setPreferredWidths] = useState<LayoutWidths>(() => {
    try { return restoreLayoutWidths(localStorage.getItem(LAYOUT_STORAGE_KEY)); } catch { return restoreLayoutWidths(null); }
  });
  const [shellWidth, setShellWidth] = useState(() => window.innerWidth);
  const [panel, setPanel] = useState<Panel>("system");
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>("checking");
  const [modelStatus, setModelStatus] = useState<ModelStatus>("checking");
  const [model, setModel] = useState(defaultModel);
  const [keepAlive, setKeepAlive] = useState(() => {
    const saved = localStorage.getItem("jarvis.ollama.keepAlive");
    return saved && ["0", "5m", "10m"].includes(saved) ? saved : "5m";
  });
  const modelRef = useRef(model);
  const [activeRequests, setActiveRequests] = useState<Record<string, string>>({});
  const [streamingByConversation, setStreamingByConversation] = useState<Record<string, StreamState>>({});
  const [errorsByConversation, setErrorsByConversation] = useState<Record<string, string>>({});
  const [copyFeedbackByKey, setCopyFeedbackByKey] = useState<Record<string, CopyFeedback>>({});
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [clockNow, setClockNow] = useState(0);
  const [statusError, setStatusError] = useState("");
  const activeRequestsRef = useRef(new Map<string, string>());
  const firstContentVisibleRef = useRef(new Map<string, number>());
  const preserveLegacyCopyRef = useRef(false);
  const statusCheckRef = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const resizeStart = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const focusNewConversationRef = useRef(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef(new Map<string, { scrollTop: number; followBottom: boolean }>());
  const copyFeedbackTimersRef = useRef(new Map<string, number>());
  const draggedConversationRef = useRef<string | null>(null);
  const suppressSelectionAfterDragRef = useRef(false);
  const active = conversations.find((conversation) => conversation.id === activeId) ?? conversations[0] ?? starter;
  const draft = getConversationDraft(draftsByConversation, active.id);
  const dictatedDrafts = useRef(new Set<string>());
  const dictatedQuestions = useRef(new Set<string>());
  const voice = useLocalVoice(active.id, (id, text) => {
    dictatedDrafts.current.add(id);
    setDraftsByConversation((drafts) => {
      const previous = getConversationDraft(drafts, id).trimEnd();
      return setConversationDraft(drafts, id, previous ? `${previous}\n${text}` : text);
    });
    textarea.current?.focus({ preventScroll: true });
  });
  const voiceStage = voice.state.stage;
  const voiceBusy = voiceStage !== "idle" && voiceStage !== "error";
  const voiceNote = voice.state.stage === "error" ? voice.state.error : ({
    idle: "",
    waiting: "Aguardando o próximo trecho da resposta…",
    starting: "Abrindo microfone…",
    recording: "Gravando · pode falar",
    transcribing: "Transcrevendo em português…",
    synthesizing: "Preparando a voz…",
    playing: "Reproduzindo a resposta…",
    stopping: "Interrompendo áudio…",
  })[voiceStage as Exclude<typeof voiceStage, "error">];
  const renameValidation = renameDialog ? validateConversationTitle(renameDialog.value) : null;
  const matching = conversations.filter((conversation) => conversation.messages.length > 0 && (conversation.title ?? "Conversa sem título").toLowerCase().includes(search.toLowerCase()));
  const orderedMatching = orderConversations(matching, sidebarPreferences.sorting, sidebarPreferences.manualOrder);
  const pinnedConversations = orderedMatching.filter((conversation) => conversation.pinned && !conversation.archived);
  const archivedConversations = orderedMatching.filter((conversation) => conversation.archived);
  const recent = orderedMatching.filter((conversation) => !conversation.pinned && !conversation.archived);
  const filterCategories: Record<SidebarFilter, Conversation[]> = {
    all: orderedMatching,
    pinned: pinnedConversations,
    archived: archivedConversations,
    locked: [],
  };
  const filtered = filterCategories[sidebarPreferences.filter];
  const sections: Array<[string, Conversation[]]> = sidebarPreferences.filter === "locked"
    ? [["TRANCADAS", []]]
    : sidebarPreferences.filter === "pinned" ? [["FIXADAS", filtered]]
      : sidebarPreferences.filter === "archived" ? [["ARQUIVADAS", filtered]]
        : sidebarPreferences.organization === "project"
          ? [["FIXADAS", pinnedConversations], ["SEM PROJETO", recent], ["ARQUIVADAS", archivedConversations]]
          : [["FIXADAS", pinnedConversations], ["RECENTES", recent], ["ARQUIVADAS", archivedConversations]];
  const activeRequestId = activeRequests[active.id];
  const activeStream = streamingByConversation[active.id];
  const syncScrollPosition = useCallback((conversationId: string, list: HTMLDivElement) => {
    const position = captureScrollPosition(list);
    scrollPositionsRef.current.set(conversationId, position);
    if (conversationId === activeId) setShowJumpToLatest(!position.followBottom);
  }, [activeId]);
  const overallStatusLabel = serviceStatus === "checking" || (serviceStatus === "available" && modelStatus === "checking")
    ? "Verificando"
    : serviceStatus === "unavailable" ? "Serviço indisponível"
      : modelStatus === "missing" ? "Modelo ausente"
        : modelStatus === "ready" ? "Pronto" : "Modelo desconhecido";
  const statusClass = serviceStatus === "checking" || modelStatus === "checking" ? "checking"
    : serviceStatus === "unavailable" ? "offline"
      : modelStatus === "missing" ? "missing"
        : modelStatus === "ready" ? "ready" : "unknown";

  useEffect(() => {
    let mounted = true;
    let legacyJson: string | null = null;
    try { legacyJson = localStorage.getItem("jarvis.conversations"); } catch { /* SQLite remains the source of truth if browser storage is unavailable. */ }
    void initializeChatStore(legacyJson).then((result) => {
      if (!mounted) return;
      if (result.importStatus === "invalid" && result.conversations.length === 0) {
        preserveLegacyCopyRef.current = true;
        setChatStoreWarning(`Histórico antigo mantido no navegador; importação ignorada: ${result.warning ?? "formato inválido"}.`);
      } else {
        setConversations(result.conversations);
        setActiveId((currentId) => result.conversations.some((conversation) => conversation.id === currentId)
          ? currentId : result.conversations[0]?.id ?? starter.id);
        if (result.importStatus === "invalid") {
          preserveLegacyCopyRef.current = true;
          setChatStoreWarning(`Histórico do banco carregado; cópia antiga mantida sem alteração: ${result.warning ?? "formato inválido"}.`);
        }
      }
      setChatStoreStatus("ready");
    }).catch((error) => {
      if (!mounted) return;
      setChatStoreStatus("failed");
      setChatStoreError(error instanceof Error ? error.message : String(error));
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (chatStoreStatus === "checking") return;
    if (chatStoreStatus === "failed") {
      try {
        localStorage.setItem("jarvis.conversations", JSON.stringify(conversations));
      } catch {
        setChatStoreWarning("O histórico SQLite está indisponível e o armazenamento local do navegador não pôde ser atualizado.");
      }
      return;
    }
    void persistChatStore(conversations).then(() => {
      setChatStoreError("");
      if (!preserveLegacyCopyRef.current) {
        try {
          localStorage.setItem("jarvis.conversations", JSON.stringify(conversations));
        } catch {
          setChatStoreWarning("O banco SQLite foi atualizado, mas a cópia de compatibilidade do navegador não pôde ser atualizada.");
        }
      }
    }).catch((error) => {
      setChatStoreError(error instanceof Error ? error.message : String(error));
    });
  }, [conversations, chatStoreStatus]);

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify(sidebarPreferences)); }
    catch { setConversationNotice("Não foi possível salvar as preferências da barra lateral neste dispositivo."); }
  }, [sidebarPreferences]);

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(preferredWidths)); } catch { /* Keep the current session usable if local storage is unavailable. */ }
  }, [preferredWidths]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const resizeToFit = () => setShellWidth(shell.clientWidth);
    const observer = new ResizeObserver(resizeToFit);
    observer.observe(shell);
    resizeToFit();
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!sidebarSettingsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".sidebar-settings-panel, .sidebar-settings-trigger, #sidebar-filter-options")) {
        setSidebarSettingsOpen(false);
      }
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSidebarSettingsOpen(false); document.querySelector<HTMLButtonElement>(".sidebar-settings-trigger")?.focus(); }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [sidebarSettingsOpen]);

  useEffect(() => {
    localStorage.setItem("jarvis.ollama.keepAlive", keepAlive);
  }, [keepAlive]);

  useEffect(() => {
    if (!Object.keys(activeRequests).length) return;
    const timer = window.setInterval(() => setClockNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, [activeRequests]);

  useEffect(() => () => {
    for (const timer of copyFeedbackTimersRef.current.values()) window.clearTimeout(timer);
    copyFeedbackTimersRef.current.clear();
  }, []);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTop = restoreScrollTop(list, scrollPositionsRef.current.get(active.id));
    syncScrollPosition(active.id, list);
  }, [activeId, active.messages.length, activeStream?.content, syncScrollPosition]);

  useLayoutEffect(() => {
    if (!focusNewConversationRef.current) return;
    focusNewConversationRef.current = false;
    textarea.current?.focus({ preventScroll: true });
  }, [activeId]);

  const dismissConversationMenu = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) conversationMenu?.anchor.focus({ preventScroll: true });
    setConversationMenu(null);
  }, [conversationMenu]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list || !active.messages.length || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      list.scrollTop = restoreScrollTop(list, scrollPositionsRef.current.get(active.id));
      syncScrollPosition(active.id, list);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [active.id, active.messages.length > 0, syncScrollPosition]);

  const rememberMessageScroll = () => {
    const list = messageListRef.current;
    if (list) syncScrollPosition(active.id, list);
  };

  const jumpToLatest = () => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    syncScrollPosition(active.id, list);
    list.focus({ preventScroll: true });
  };

  const resizeComposerTextarea = useCallback(() => {
    const field = textarea.current;
    if (!field) return;
    const computed = window.getComputedStyle(field);
    const fontSize = Number.parseFloat(computed.fontSize) || 12;
    const lineHeight = Number.parseFloat(computed.lineHeight) || fontSize * 1.55;
    const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
    field.style.height = "auto";
    const size = calculateComposerSize(field.scrollHeight, lineHeight, paddingTop, paddingBottom);
    field.style.maxHeight = `${size.maxHeight}px`;
    field.style.height = `${size.height}px`;
    field.style.overflowY = size.overflowY;
  }, []);

  useLayoutEffect(() => {
    resizeComposerTextarea();
  }, [draft, resizeComposerTextarea]);

  useEffect(() => {
    const field = textarea.current;
    if (!field || typeof ResizeObserver === "undefined") return;
    let observedWidth = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === observedWidth) return;
      observedWidth = field.clientWidth;
      resizeComposerTextarea();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [resizeComposerTextarea]);

  useLayoutEffect(() => {
    for (const [conversationId, stream] of Object.entries(streamingByConversation)) {
      if (conversationId !== activeId) continue;
      if (!stream.content || stream.firstContentMs != null) continue;
      const firstContentMs = Math.round(performance.now() - stream.startedAt);
      firstContentVisibleRef.current.set(stream.requestId, firstContentMs);
      setStreamingByConversation((items) => {
        const current = items[conversationId];
        if (!current || current.requestId !== stream.requestId || current.firstContentMs != null) return items;
        return { ...items, [conversationId]: { ...current, firstContentMs } };
      });
    }
  }, [activeId, streamingByConversation]);

  const checkOllama = useCallback(async () => {
    const checkId = ++statusCheckRef.current;
    const selectedModel = model;
    setServiceStatus("checking");
    setModelStatus("checking");
    setStatusError("");
    try {
      const models = await listOllamaModels(ollamaBaseUrl);
      if (checkId !== statusCheckRef.current) return;
      setServiceStatus("available");
      setModelStatus(isModelInstalled(models, selectedModel) ? "ready" : "missing");
    } catch (error) {
      if (checkId !== statusCheckRef.current) return;
      const result = normalizeOllamaError(error);
      const serviceReachable = !["connection", "timeout", "configuration"].includes(result.kind);
      setServiceStatus(serviceReachable ? "available" : "unavailable");
      setModelStatus("unknown");
      setStatusError(result.message);
    }
  }, [model]);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (!alive) return;
      await checkOllama();
    };
    void check();
    const timer = window.setInterval(check, 15000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [checkOllama]);

  const newConversation = useCallback(() => {
    if (chatStoreStatus === "checking") return;
    const conversation = { ...starter, id: crypto.randomUUID(), updatedAt: Date.now() };
    focusNewConversationRef.current = true;
    setConversations((items) => [conversation, ...items]);
    setSidebarPreferences((prefs) => ({ ...prefs, manualOrder: [conversation.id, ...prefs.manualOrder.filter((id) => id !== conversation.id)] }));
    setActiveId(conversation.id);
  }, [chatStoreStatus]);

  const setSidebarPreference = <K extends keyof SidebarPreferences>(key: K, value: SidebarPreferences[K]) => {
    setSidebarPreferences((current) => ({ ...current, [key]: value }));
  };

  const setSidebarSorting = (sorting: SidebarSorting) => {
    setSidebarPreferences((current) => ({
      ...current,
      sorting,
      manualOrder: sorting === "manual"
        ? [...orderConversations(conversations, "updated", current.manualOrder).map((conversation) => conversation.id)]
        : current.manualOrder,
    }));
  };

  const reorderSidebarConversation = (conversationId: string, sectionItems: Conversation[], direction: -1 | 1) => {
    const sectionIds = sectionItems.map((conversation) => conversation.id);
    setSidebarPreferences((current) => ({ ...current, manualOrder: moveWithinSection(current.manualOrder, sectionIds, conversationId, direction) }));
  };

  const dropSidebarConversation = (sourceId: string, targetId: string, sectionItems: Conversation[]) => {
    const sectionIds = sectionItems.map((conversation) => conversation.id);
    setSidebarPreferences((current) => ({ ...current, manualOrder: dropWithinSection(current.manualOrder, sectionIds, sourceId, targetId) }));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLocaleLowerCase("en-US");
      const localShortcutChord = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && (key === "k" || key === "f");
      if (!localShortcutChord) return;
      const overlayOpen = Boolean(document.querySelector('dialog[open], [role="dialog"]:not([hidden]), [role="menu"]:not([hidden]), [aria-modal="true"]'));
      const action = getConversationShortcut(event, overlayOpen);
      // Ctrl+F must never reach the WebView's built-in page finder, including repeats.
      if (key === "f" && !event.isComposing && !event.defaultPrevented) event.preventDefault();
      if (!action) {
        if (event.repeat) event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (action === "new_conversation") newConversation();
      else searchInput.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [newConversation]);

  const startRenameConversation = (conversation: Conversation) => {
    setRenameDialog({ conversationId: conversation.id, value: conversation.title ?? "" });
  };

  const restoreConversationFocus = (id: string, fallback = searchInput.current) => {
    requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLButtonElement>(`[data-conversation-menu-trigger="${CSS.escape(id)}"]`);
      (trigger ?? fallback)?.focus({ preventScroll: true });
    });
  };

  const closeRenameDialog = () => {
    if (renameDialog) restoreConversationFocus(renameDialog.conversationId);
    setRenameDialog(null);
  };

  const closeDeleteDialog = () => {
    if (deleteDialogId) restoreConversationFocus(deleteDialogId);
    setDeleteDialogId(null);
  };

  const saveConversationTitle = (event: FormEvent) => {
    event.preventDefault();
    if (!renameDialog) return;
    const validation = validateConversationTitle(renameDialog.value);
    if (!validation.valid) return;
    const updatedAt = Date.now();
    setConversations((items) => renameConversationTitle(items, renameDialog.conversationId, validation.value, updatedAt));
    closeRenameDialog();
  };

  const updateFlags = (conversation: Conversation, changes: { pinned?: boolean; archived?: boolean }) => {
    setConversations((items) => updateConversationFlags(items, conversation.id, changes));
    if (changes.pinned) setSidebarPreferences((current) => ({ ...current, manualOrder: [conversation.id, ...current.manualOrder.filter((id) => id !== conversation.id)] }));
    setConversationMenu(null);
    restoreConversationFocus(conversation.id);
    if (changes.archived && conversation.id === activeId) {
      const next = conversations.find((item) => item.id !== conversation.id && !item.archived);
      if (next) setActiveId(next.id);
      else newConversation();
    }
  };

  const confirmDeleteConversation = () => {
    if (!deleteDialogId) return;
    const id = deleteDialogId;
    dictatedDrafts.current.delete(id);
    for (const message of conversations.find((item) => item.id === id)?.messages ?? []) {
      if (message.id) dictatedQuestions.current.delete(message.id);
    }
    const next = conversations.find((item) => item.id !== id && !item.archived);
    setConversations((items) => removeConversation(items, id));
    if (activeId === id) {
      if (next) setActiveId(next.id);
      else newConversation();
    }
    if (activeId !== id || next) restoreConversationFocus(id);
    setDeleteDialogId(null);
  };

  const shareConversation = async (conversation: Conversation, mode: "copy" | "export") => {
    setConversationMenu(null);
    restoreConversationFocus(conversation.id);
    const markdown = exportConversationMarkdown(conversation);
    try {
      if (mode === "copy") {
        await copyResponseText(markdown);
        setConversationNotice("Conversa copiada para a área de transferência.");
      } else {
        const safeName = sanitizeExportFilename(conversation.title);
        const saved = await exportMarkdownFile(`${safeName || "conversa"}.md`, markdown);
        setConversationNotice(saved ? "Conversa exportada em Markdown." : "Exportação cancelada.");
      }
    } catch {
      setConversationNotice(mode === "copy" ? "Não foi possível copiar a conversa." : "Não foi possível exportar a conversa.");
    }
  };

  const updateActiveDraft = (value: string) => {
    if (!value.trim()) dictatedDrafts.current.delete(active.id);
    setDraftsByConversation((drafts) => setConversationDraft(drafts, active.id, value));
  };

  const copyResponse = async (key: string, content: string) => {
    const previousTimer = copyFeedbackTimersRef.current.get(key);
    if (previousTimer != null) window.clearTimeout(previousTimer);
    setCopyFeedbackByKey((items) => ({ ...items, [key]: { label: "Copiando…", failed: false } }));
    let feedback: CopyFeedback;
    try {
      await copyResponseText(content);
      feedback = { label: "Copiado!", failed: false };
    } catch {
      feedback = { label: "Falha ao copiar", failed: true };
    }
    setCopyFeedbackByKey((items) => ({ ...items, [key]: feedback }));
    const timer = window.setTimeout(() => {
      copyFeedbackTimersRef.current.delete(key);
      setCopyFeedbackByKey((items) => { const next = { ...items }; delete next[key]; return next; });
    }, 2_000);
    copyFeedbackTimersRef.current.set(key, timer);
  };

  const setRequestState = (conversationId: string, requestId: string | null) => {
    if (requestId) activeRequestsRef.current.set(conversationId, requestId);
    else activeRequestsRef.current.delete(conversationId);
    setActiveRequests((current) => {
      const next = { ...current };
      if (requestId) next[conversationId] = requestId;
      else delete next[conversationId];
      return next;
    });
  };

  const sendMessage = async (event?: FormEvent, retryMessageId?: string) => {
    event?.preventDefault();
    if (chatStoreStatus === "checking") return;
    const conversation = active;
    if (activeRequestsRef.current.has(conversation.id)) return;
    const retrying = retryMessageId
      ? conversation.messages.find((message) => message.id === retryMessageId && message.role === "user" && message.delivery === "failed")
      : undefined;
    if (retryMessageId && !retrying) return;
    const content = retrying?.content ?? draft.trim();
    if (!content) return;
    const readAnswer = retrying
      ? Boolean(retrying.id && dictatedQuestions.current.has(retrying.id))
      : dictatedDrafts.current.delete(conversation.id);
    if (activeId !== conversation.id) setActiveId(conversation.id);

    const requestContext = createRequestContext(conversation.id, crypto.randomUUID(), model);
    const { conversationId, requestId, model: requestedModel } = requestContext;
    const history = toChatContext(conversation.messages.filter((message) => message.id !== retrying?.id));
    const currentQuestion: StoredMessage = { role: "user", content };
    const needsSystemContext = isSystemQuestion(content, history);
    const now = Date.now();
    const startedAt = performance.now();
    if (readAnswer) voice.startReply(conversationId, requestId);
    scrollPositionsRef.current.set(conversationId, { scrollTop: 0, followBottom: true });
    const userMessage: Message = {
      ...(retrying ?? {}),
      id: retrying?.id ?? crypto.randomUUID(),
      role: "user",
      content,
      model: requestedModel,
      createdAt: now,
      requestId,
      delivery: "pending",
    };
    if (readAnswer) dictatedQuestions.current.add(userMessage.id!);
    let answer = "";

    statusCheckRef.current += 1;
    setRequestState(conversationId, requestId);
    setStreamingByConversation((items) => ({ ...items, [conversationId]: { requestId, content: "", model: requestedModel, createdAt: now, startedAt, firstContentMs: null } }));
    setErrorsByConversation((items) => { const next = { ...items }; delete next[conversationId]; return next; });
    if (!retrying) setDraftsByConversation((drafts) => setConversationDraft(drafts, conversationId, ""));
    setConversations((items) => (items.length ? items : [conversation]).map((item) => {
      if (item.id !== conversationId) return item;
      const messages = retrying
        ? item.messages.map((message) => message.id === retrying.id ? userMessage : message)
        : [...item.messages, userMessage];
      return {
        ...item,
        title: resolveConversationTitle(item.messages.length === 0 && item.title === "Nova conversa" ? undefined : item.title, item.messages, content),
        updatedAt: now,
        messages,
      };
    }));

    try {
      let systemContext: StoredMessage[] = [];
      if (needsSystemContext) {
        try {
          const snapshot = await getSystemSnapshot();
          systemContext = [{ role: "system", content: createSystemContextPrompt(content, snapshot) }];
        } catch {
          systemContext = [{ role: "system", content: createSystemContextPrompt(content, null, { collectionFailed: true }) }];
        }
      }
      if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
      const requestMessages = limitChatContext([...systemContext, ...history, currentQuestion]);
      const request = streamOllamaChat(
        ollamaBaseUrl,
        requestedModel,
        requestMessages,
        resolveChatThinking(content, readAnswer),
        requestId,
        keepAlive,
        (fragment) => {
          if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
          answer += fragment;
          if (readAnswer) voice.appendReply(requestId, fragment);
          setStreamingByConversation((items) => {
            const previous = items[conversationId];
            if (previous && previous.requestId !== requestId) return items;
            return { ...items, [conversationId]: { requestId, content: `${previous?.content ?? ""}${fragment}`, model: requestedModel, createdAt: now, startedAt, firstContentMs: previous?.firstContentMs ?? null } };
          });
        },
      );
      const completion = await request.completion;
      if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
      const completedAt = performance.now();
      if (answer) await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
      statusCheckRef.current += 1;
      setServiceStatus("available");
      if (modelRef.current === requestedModel) setModelStatus("ready");
      const totalElapsedMs = Math.round(completedAt - startedAt);
      const firstContentMs = firstContentVisibleRef.current.get(requestId) ?? null;
      const ollamaTotalMs = completion.totalDuration == null ? null : completion.totalDuration / 1_000_000;
      const tokensPerSecond = completion.evalCount != null && completion.evalDuration && completion.evalDuration > 0
        ? completion.evalCount * 1_000_000_000 / completion.evalDuration : null;
      setConversations((items) => {
        const sent = updateMessage(items, conversationId, userMessage.id!, { delivery: "sent" });
        return appendAssistantOnce(sent, conversationId, requestId, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: completion.content || answer,
          model: completion.model || requestedModel,
          createdAt: Date.now(),
          requestId,
          delivery: "sent",
          metrics: { firstContentMs, totalElapsedMs, ollamaTotalMs, tokensPerSecond },
        }).map((item) => item.id === conversationId ? { ...item, updatedAt: Date.now() } : item);
      });
      firstContentVisibleRef.current.delete(requestId);
      if (readAnswer) {
        dictatedQuestions.current.delete(userMessage.id!);
        const tail = completion.content?.startsWith(answer) ? completion.content.slice(answer.length) : "";
        voice.finishReply(requestId, tail);
      }
    } catch (error) {
      if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
      if (readAnswer) voice.stopReply(requestId);
      const result = normalizeOllamaError(error);
      statusCheckRef.current += 1;
      if (["connection", "timeout", "configuration"].includes(result.kind)) {
        setServiceStatus("unavailable");
        setModelStatus("unknown");
      } else {
        setServiceStatus("available");
        if (result.kind === "model_not_found" && modelRef.current === requestedModel) setModelStatus("missing");
      }
      const partial = answer;
      const firstVisibleMs = firstContentVisibleRef.current.get(requestId) ?? null;
      setErrorsByConversation((items) => ({ ...items, [conversationId]: result.message }));
      setConversations((items) => {
        let next = updateMessage(items, conversationId, userMessage.id!, { delivery: "failed" });
        if (partial) {
          next = appendAssistantOnce(next, conversationId, `${requestId}:partial`, {
            id: crypto.randomUUID(), role: "assistant", content: partial,
            model: requestedModel, createdAt: Date.now(), requestId: `${requestId}:partial`, delivery: "failed",
            metrics: { firstContentMs: firstVisibleMs, totalElapsedMs: null, ollamaTotalMs: null, tokensPerSecond: null },
          });
        }
        return next;
      });
    } finally {
      if (isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) {
        setRequestState(conversationId, null);
        setStreamingByConversation((items) => { const next = { ...items }; delete next[conversationId]; return next; });
        firstContentVisibleRef.current.delete(requestId);
      }
    }
  };

  const cancelGeneration = (conversationId: string, requestId: string) => {
    if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
    voice.stopReply(requestId);
    const stream = streamingByConversation[conversationId];
    void cancelOllamaChat(requestId).catch(() => undefined);
    setRequestState(conversationId, null);
    firstContentVisibleRef.current.delete(requestId);
    setStreamingByConversation((items) => { const next = { ...items }; delete next[conversationId]; return next; });
    setErrorsByConversation((items) => ({ ...items, [conversationId]: stream?.content
      ? "Geração cancelada. O trecho parcial foi preservado como incompleto e não será enviado ao modelo."
      : "Geração cancelada antes do primeiro trecho de texto." }));
    setConversations((items) => {
      let next = updateMessage(items, conversationId, items.find((item) => item.id === conversationId)?.messages.find((message) => message.requestId === requestId && message.role === "user")?.id ?? "", { delivery: "failed" });
      if (stream?.content) {
        next = appendAssistantOnce(next, conversationId, `${requestId}:partial`, {
          id: crypto.randomUUID(), role: "assistant", content: stream.content, model: stream.model,
          createdAt: Date.now(), requestId: `${requestId}:partial`, delivery: "failed",
          metrics: { firstContentMs: stream.firstContentMs, totalElapsedMs: null, ollamaTotalMs: null, tokensPerSecond: null },
        });
      }
      return next;
    });
  };

  const layoutWidths = clampLayoutWidths(preferredWidths, shellWidth);

  const adjustRail = (area: ResizableArea, delta: number, start = layoutWidths) => {
    const key = area === "sidebar" ? "sidebarWidth" : "dashboardWidth";
    const resized = resizeLayoutArea(start, area, delta, shellWidth);
    setPreferredWidths((current) => current[key] === resized[key] ? current : { ...current, [key]: resized[key] });
  };

  const startResize = (area: ResizableArea, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: area === "sidebar" ? layoutWidths.sidebarWidth : layoutWidths.dashboardWidth,
    };
  };

  const resizeFromPointer = (area: ResizableArea, event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const delta = (event.clientX - start.x) * (area === "sidebar" ? 1 : -1);
    adjustRail(area, delta, { ...layoutWidths, [area === "sidebar" ? "sidebarWidth" : "dashboardWidth"]: start.width });
  };

  const resizeFromKeyboard = (area: ResizableArea, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const direction = area === "sidebar" ? 1 : -1;
    if (event.key === "ArrowLeft") adjustRail(area, -step * direction);
    else if (event.key === "ArrowRight") adjustRail(area, step * direction);
    else if (event.key === "Home" || event.key === "End") {
      const limits = getLayoutLimits(layoutWidths, shellWidth)[area];
      const width = area === "sidebar" ? layoutWidths.sidebarWidth : layoutWidths.dashboardWidth;
      adjustRail(area, (event.key === "Home" ? limits.min : limits.max) - width);
    } else return;
    event.preventDefault();
  };

  const layoutLimits = getLayoutLimits(layoutWidths, shellWidth);
  const layoutStyle = {
    "--sidebar-width": `${layoutWidths.sidebarWidth}px`,
    "--dashboard-width": `${layoutWidths.dashboardWidth}px`,
  } as CSSProperties;

  return (
    <div className="app-shell" ref={appShellRef} style={layoutStyle}>
      <aside id="left-rail" className="left-rail" aria-label="Navegação e conversas" tabIndex={0}>
        <div className="brand-lockup">
          <div className="brand-mark"><Icon name="spark" size={19} /></div>
          <div><strong>AURION</strong><span>Assistente local</span></div>
        </div>
        <button className="new-chat" onClick={newConversation} disabled={chatStoreStatus === "checking"}><Icon name="plus" size={17} /><span>{chatStoreStatus === "checking" ? "Restaurando histórico…" : "Nova conversa"}</span><kbd>Ctrl K</kbd></button>
        <label className="search-box"><Icon name="search" size={16} /><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar conversas" aria-label="Buscar conversas" /><kbd>Ctrl F</kbd></label>
        <div className="sidebar-section">
          <div className="section-label">Workspace</div>
          <button className="nav-item" onClick={() => setPanel("project")}><Icon name="folder" size={16} />Projetos</button>
        </div>
        <div className="sidebar-section recent-section">
          <div className="section-label recent-heading"><span>Recentes</span><button type="button" className="sidebar-settings-trigger" aria-label="Configurar barra lateral" title="Configurar barra lateral" aria-controls="sidebar-settings" aria-expanded={sidebarSettingsOpen} onClick={() => setSidebarSettingsOpen((open) => !open)}><Icon name="more" size={16} /></button></div>
          {sidebarSettingsOpen && <div id="sidebar-settings" className="sidebar-settings-panel" role="region" aria-label="Configurações da barra lateral">
            <fieldset><legend>Organização</legend>
              <label><input type="radio" name="sidebar-organization" checked={sidebarPreferences.organization === "list"} onChange={() => setSidebarPreference("organization", "list")} /> Lista</label>
              <label><input type="radio" name="sidebar-organization" checked={sidebarPreferences.organization === "project"} onChange={() => setSidebarPreference("organization", "project")} /> Por projeto</label>
            </fieldset>
            <fieldset><legend>Ordenação</legend>
              <label><input type="radio" name="sidebar-sorting" checked={sidebarPreferences.sorting === "updated"} onChange={() => setSidebarSorting("updated")} /> Última atualização</label>
              <label><input type="radio" name="sidebar-sorting" checked={sidebarPreferences.sorting === "manual"} onChange={() => setSidebarSorting("manual")} /> Manual</label>
            </fieldset>
            <span className="sidebar-filter-label" id="sidebar-filter-label">Exibir</span>
            <ThemedSelect<SidebarFilter> id="sidebar-filter" labelId="sidebar-filter-label"
              value={sidebarPreferences.filter} onChange={(value) => setSidebarPreference("filter", value)}
              options={[
                { value: "all", label: "Todos" },
                { value: "pinned", label: "Fixadas" },
                { value: "archived", label: "Arquivadas" },
                { value: "locked", label: "Trancadas" },
              ]}
            />
            {sidebarPreferences.filter === "locked" && <p className="sidebar-settings-note">Trancar conversas ainda não está disponível: o app não tem criptografia local em repouso.</p>}
            {sidebarPreferences.organization === "project" && <p className="sidebar-settings-note">O vínculo e o cadastro de projetos ainda não existem. Conversas sem vínculo aparecem em “Sem projeto” até essa integração ser implementada.</p>}
          </div>}
          {conversationNotice && <p className="conversation-notice" role="status" aria-live="polite">{conversationNotice}</p>}
          {sections.map(([section, sectionItems]) => <section className="conversation-group" key={section}>
          <div className="section-label">{section[0] + section.slice(1).toLocaleLowerCase("pt-BR")}</div>
          {sectionItems.length ? orderConversations(sectionItems, sidebarPreferences.sorting, sidebarPreferences.manualOrder).slice(0, section === "RECENTES" && !search && sidebarPreferences.sorting === "updated" ? 8 : sectionItems.length).map((conversation, sectionIndex, visibleSection) => {
            const title = conversation.title ?? "Conversa sem título";
            const sectionIds = visibleSection.map((item) => item.id);
            return <div key={conversation.id} className="conversation-entry" draggable={sidebarPreferences.sorting === "manual"} onDragStart={(event) => { draggedConversationRef.current = conversation.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", conversation.id); }} onDragOver={(event) => { if (sidebarPreferences.sorting === "manual") event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const sourceId = draggedConversationRef.current ?? event.dataTransfer.getData("text/plain"); if (sourceId) { dropSidebarConversation(sourceId, conversation.id, sectionItems); suppressSelectionAfterDragRef.current = true; window.setTimeout(() => { suppressSelectionAfterDragRef.current = false; }, 0); } draggedConversationRef.current = null; }} onDragEnd={() => { draggedConversationRef.current = null; }}>
              <button type="button" onClick={() => { if (suppressSelectionAfterDragRef.current) return; setActiveId(conversation.id); }} className={`conversation-link ${conversation.id === activeId ? "selected" : ""}`} title={title} aria-current={conversation.id === activeId ? "true" : undefined} aria-label={`Abrir conversa: ${title}`}>
                <Icon name="chat" size={15} /><span>{title}</span>
              </button>
              <button type="button" data-conversation-menu-trigger={conversation.id} className="conversation-rename" aria-haspopup="menu"
                aria-expanded={conversationMenuId === conversation.id}
                onClick={(event) => setConversationMenu(conversationMenuId === conversation.id ? null : { id: conversation.id, anchor: event.currentTarget })}
                disabled={chatStoreStatus === "checking"} aria-label={`Ações da conversa: ${title}`} title={`Ações: ${title}`}>
                <Icon name="more" size={16} />
              </button>
              {conversationMenu?.id === conversation.id && <ConversationMenu anchor={conversationMenu.anchor} label={`Ações para ${title}`} onDismiss={dismissConversationMenu}>
                <button role="menuitem" tabIndex={-1} onClick={() => { setConversationMenu(null); startRenameConversation(conversation); }}>Renomear</button>
                <button role="menuitem" tabIndex={-1} onClick={() => updateFlags(conversation, { pinned: !conversation.pinned })}>{conversation.pinned ? "Desafixar" : "Fixar"}</button>
                <button role="menuitem" tabIndex={-1} onClick={() => updateFlags(conversation, { archived: !conversation.archived })}>{conversation.archived ? "Desarquivar" : "Arquivar"}</button>
                {sidebarPreferences.sorting === "manual" && <>
                  <button role="menuitem" tabIndex={-1} disabled={sectionIndex === 0} onClick={() => reorderSidebarConversation(conversation.id, sectionItems, -1)}>Mover para cima</button>
                  <button role="menuitem" tabIndex={-1} disabled={sectionIndex === sectionIds.length - 1} onClick={() => reorderSidebarConversation(conversation.id, sectionItems, 1)}>Mover para baixo</button>
                </>}
                <button role="menuitem" tabIndex={-1} onClick={() => void shareConversation(conversation, "copy")}>Copiar conversa</button>
                <button role="menuitem" tabIndex={-1} onClick={() => void shareConversation(conversation, "export")}>Exportar Markdown</button>
                <button role="menuitem" tabIndex={-1} disabled title="Indisponível: o app ainda não dispõe de criptografia local para proteger dados em repouso.">Trancar · indisponível</button>
                <button role="menuitem" tabIndex={-1} className="destructive" onClick={() => { setDeleteDialogId(conversation.id); setConversationMenu(null); }}>Excluir…</button>
              </ConversationMenu>}
            </div>;
          }) : <p className="empty-recent">{section === "TRANCADAS" ? "Nenhuma conversa trancada. A proteção ainda não está disponível." : section === "ARQUIVADAS" ? "Nenhuma conversa arquivada corresponde ao filtro." : section === "FIXADAS" ? "Nenhuma conversa fixada corresponde ao filtro." : "Nenhuma conversa corresponde ao filtro."}</p>}
          </section>)}
        </div>
        <div className="sidebar-bottom">
          <div className="local-badge"><span className="pulse-dot" /> Seus dados ficam neste dispositivo</div>
          <button className="profile-button" onClick={() => setPanel("ai")}><div className="profile-copy"><strong>Workspace local</strong><span>Configurações</span></div><Icon name="settings" size={16} /></button>
        </div>
      </aside>

      <div
        className="resize-divider sidebar-divider"
        role="separator"
        aria-label="Redimensionar barra lateral esquerda"
        aria-orientation="vertical"
        aria-controls="left-rail main-area"
        aria-valuemin={layoutLimits.sidebar.min}
        aria-valuemax={layoutLimits.sidebar.max}
        aria-valuenow={layoutWidths.sidebarWidth}
        aria-valuetext={`${layoutWidths.sidebarWidth} pixels`}
        tabIndex={0}
        onPointerDown={(event) => startResize("sidebar", event)}
        onPointerMove={(event) => resizeFromPointer("sidebar", event)}
        onLostPointerCapture={(event) => { if (resizeStart.current?.pointerId === event.pointerId) resizeStart.current = null; }}
        onKeyDown={(event) => resizeFromKeyboard("sidebar", event)}
      />

      <main id="main-area" className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><Icon name="chevron" size={14} /><strong tabIndex={0} title={active?.messages.length ? active.title ?? "Conversa sem título" : "Nova conversa"} aria-label={active?.messages.length ? active.title ?? "Conversa sem título" : "Nova conversa"}>{active?.messages.length ? active.title ?? "Conversa sem título" : "Nova conversa"}</strong></div>
          <div className="topbar-actions"><button type="button" className="model-chip" onClick={() => setPanel("ai")} title={model + " · " + overallStatusLabel} aria-label={"Configurar Ollama: " + overallStatusLabel}><span className={`status-dot ${serviceStatus === "checking" ? "checking" : serviceStatus === "available" ? "online" : "offline"}`} /><span className="model-chip-name">{model}</span><Icon name="settings" size={14} /></button></div>
        </header>

        <section className={`chat-view ${active?.messages.length ? "has-messages" : ""}`}>
          {!active?.messages.length ? (
            <div className="welcome-wrap">
              <div className="welcome-mark"><Icon name="spark" size={32} /></div>
              <h1>Bom dia, Gabriel<span>.</span></h1>
              <p className="welcome-subtitle">No que vamos trabalhar hoje?</p>
              <div className="suggestion-grid">
                <button className="suggestion-card" onClick={() => { textarea.current?.focus(); updateActiveDraft("Como está o desempenho do meu computador?"); }}><span className="suggestion-icon violet"><Icon name="cpu" /></span><span><strong>Verificar meu sistema</strong><small>Acompanhe o desempenho do computador</small></span><Icon name="chevron" size={15} /></button>
                <button className="suggestion-card" onClick={() => { textarea.current?.focus(); updateActiveDraft("Me ajude a planejar meu próximo projeto."); }}><span className="suggestion-icon blue"><Icon name="folder" /></span><span><strong>Começar um projeto</strong><small>Organize ideias e próximos passos</small></span><Icon name="chevron" size={15} /></button>
                <button className="suggestion-card" onClick={() => { textarea.current?.focus(); updateActiveDraft("Explique como posso usar modelos locais com Ollama."); }}><span className="suggestion-icon amber"><Icon name="spark" /></span><span><strong>Explorar IA local</strong><small>Converse com seu modelo no Ollama</small></span><Icon name="chevron" size={15} /></button>
              </div>
            </div>
          ) : (
            <div className="message-list" ref={messageListRef} onScroll={rememberMessageScroll} role="region" aria-label="Mensagens da conversa" tabIndex={0}>
              <div className="conversation-date">MENSAGENS DA CONVERSA</div>
              {active.messages.map((message, index) => <article className={`message-row ${message.role} ${message.delivery === "failed" ? "failed" : ""}`} key={`${active.id}-${index}`}>
                <div className={`message-avatar ${message.role}`}>{message.role === "user" ? "G" : <Icon name="spark" size={15} />}</div>
                <div className="message-content">
                  <div className="message-author"><span className="message-author-name">{message.role === "user" ? "Você" : "Aurion"}</span><span>{message.model ?? "Modelo desconhecido"} · {messageTime(message.createdAt)}</span></div>
                  {message.role === "assistant" ? <div className="assistant-markdown"><MarkdownMessage content={message.content} /></div> : <p>{message.content}</p>}
                  {message.role === "assistant" && <div className="message-actions">
                    <button type="button" className="copy-response" aria-label="Copiar resposta" title="Copiar resposta" onClick={() => void copyResponse(message.requestId ?? message.id ?? `${active.id}-${index}`, message.content)}><Icon name="copy" size={14} /><span>Copiar resposta</span></button>
                    {message.delivery !== "failed" && message.content.trim() && <button type="button" className="copy-response" disabled={voiceBusy} onClick={() => voice.speak(message.content)}><Icon name="speaker" size={15} /> Ouvir resposta</button>}
                    {copyFeedbackByKey[message.requestId ?? message.id ?? `${active.id}-${index}`] && <span className={`copy-feedback ${copyFeedbackByKey[message.requestId ?? message.id ?? `${active.id}-${index}`].failed ? "failed" : ""}`} role={copyFeedbackByKey[message.requestId ?? message.id ?? `${active.id}-${index}`].failed ? "alert" : "status"} aria-live="polite">{copyFeedbackByKey[message.requestId ?? message.id ?? `${active.id}-${index}`].label}</span>}
                  </div>}
                  {message.delivery === "failed" && <div className="message-failure-label">{message.role === "assistant" ? "Resposta interrompida · não será enviada no próximo contexto" : "Envio falhou · pergunta preservada"}</div>}
                  {message.role === "assistant" && message.metrics && <div className="response-metrics">Primeiro texto: {durationLabel(message.metrics.firstContentMs)} · Total: {durationLabel(message.metrics.totalElapsedMs)} · Ollama: {durationLabel(message.metrics.ollamaTotalMs)} · Velocidade: {message.metrics.tokensPerSecond == null ? "N/D" : `${message.metrics.tokensPerSecond.toFixed(1)} tok/s`}</div>}
                  {message.role === "user" && message.delivery === "failed" && <button className="retry-message" onClick={() => void sendMessage(undefined, message.id)} disabled={Boolean(activeRequestId)}>Tentar novamente</button>}
                </div>
              </article>)}
              {activeRequestId && activeStream?.requestId === activeRequestId && <article className="message-row assistant"><div className="message-avatar assistant"><Icon name="spark" size={15} /></div><div className="message-content"><div className="message-author"><span className="message-author-name">Aurion</span><span>{activeStream.model} · {messageTime(activeStream.createdAt)}</span></div>{activeStream.content ? <div className="assistant-markdown"><MarkdownMessage content={activeStream.content} /></div> : <div className="typing-indicator"><i /><i /><i /></div>}{activeStream.content && <div className="message-actions"><button type="button" className="copy-response" aria-label="Copiar resposta" title="Copiar resposta" onClick={() => void copyResponse(activeStream.requestId, activeStream.content)}><Icon name="copy" size={14} /><span>Copiar resposta</span></button>{copyFeedbackByKey[activeStream.requestId] && <span className={`copy-feedback ${copyFeedbackByKey[activeStream.requestId].failed ? "failed" : ""}`} role={copyFeedbackByKey[activeStream.requestId].failed ? "alert" : "status"} aria-live="polite">{copyFeedbackByKey[activeStream.requestId].label}</span>}</div>}<div className="response-metrics">Primeiro texto: {activeStream.firstContentMs == null ? durationLabel(Math.max(0, clockNow - activeStream.startedAt)) + " · aguardando" : durationLabel(activeStream.firstContentMs)} · Total: {durationLabel(Math.max(0, clockNow - activeStream.startedAt))} · Velocidade: N/D</div></div></article>}
              <div className="message-end" />
            </div>
          )}
          {(chatStoreError || chatStoreWarning) && <div className={`notice-banner ${chatStoreError ? "storage-error" : "storage-warning"}`} role={chatStoreError ? "alert" : "status"}><span>!</span><p>{chatStoreError ? `Banco SQLite de conversas indisponível: ${chatStoreError}. As conversas continuam no armazenamento local do navegador.` : chatStoreWarning}</p></div>}
          {errorsByConversation[active.id] && <div className="notice-banner" role="alert"><span aria-hidden="true">!</span><p>{errorsByConversation[active.id]}</p><button onClick={() => setErrorsByConversation((items) => { const next = { ...items }; delete next[active.id]; return next; })}>Fechar</button></div>}
          <div className="composer-area">
          {showJumpToLatest && active.messages.length > 0 && <button type="button" className="jump-to-latest" onClick={jumpToLatest} aria-label="Voltar ao final da conversa" title="Voltar ao final da conversa"><Icon name="chevron" size={14} /><span>Mensagens recentes</span></button>}
          <div className="composer-wrap">
            <form className="composer" onSubmit={sendMessage}>
              <textarea ref={textarea} rows={1} value={draft} onChange={(event) => updateActiveDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} placeholder="Pergunte qualquer coisa ao Aurion..." aria-label="Mensagem" aria-describedby="composer-hint" />
              <div className="composer-bottom">
                <div className="composer-tools">
                  <button type="button" className="voice-button" data-stage={voiceStage}
                    disabled={chatStoreStatus === "checking" || voiceStage === "stopping"}
                    aria-label={voiceStage === "recording" ? "Encerrar gravação e transcrever" : voiceBusy ? "Interromper operação de voz" : "Gravar mensagem"}
                    title={voiceStage === "recording" ? "Encerrar gravação e transcrever" : voiceBusy ? "Interromper operação de voz" : "Gravar mensagem"}
                    onClick={() => {
                      if (voiceStage === "recording") void voice.finishCapture();
                      else if (voiceBusy) voice.stop();
                      else void voice.startCapture();
                    }}>
                    <Icon name={voiceBusy ? "stop" : "mic"} size={16} />
                  </button>
                  <label className="voice-volume" title="Volume aplicado ao próximo trecho de voz">
                    <Icon name="speaker" size={15} />
                    <input type="range" min={0} max={100} step={1} value={voice.volume}
                      aria-label="Volume da voz do Aurion" aria-valuetext={`${voice.volume}%`}
                      onChange={(event) => voice.changeVolume(event.currentTarget.valueAsNumber)} />
                    <span>{voice.volume}%</span>
                  </label>
                  <span className="composer-hint" id="composer-hint">Enter para enviar <span>·</span> Shift + Enter para nova linha</span>
                </div>
                {activeRequestId ? <button type="button" className="send-button cancel-generation" onClick={() => cancelGeneration(active.id, activeRequestId)} aria-label="Parar geração" title="Parar geração"><Icon name="stop" size={15} /></button> : <button className={`send-button ${draft.trim() ? "ready" : ""}`} type="submit" disabled={!draft.trim() || chatStoreStatus === "checking"} aria-label="Enviar mensagem" title="Enviar mensagem"><Icon name="send" size={16} /></button>}
              </div>
              {voice.state.stage === "error" ? <p className="voice-feedback voice-error" role="alert">{voiceNote}</p> :
                <div className="voice-feedback" role="status">{voiceNote || (draft.trim() && dictatedDrafts.current.has(active.id) ? "Revise a transcrição e envie para ouvir a resposta." : "")}</div>}
            </form>
            <p className="privacy-note"><span className="lock-icon">⌑</span> As conversas são processadas localmente no seu computador.</p>
          </div>
          </div>
        </section>
      </main>

      <div
        className="resize-divider dashboard-divider"
        role="separator"
        aria-label="Redimensionar dashboard direito"
        aria-orientation="vertical"
        aria-controls="main-area right-rail"
        aria-valuemin={layoutLimits.dashboard.min}
        aria-valuemax={layoutLimits.dashboard.max}
        aria-valuenow={layoutWidths.dashboardWidth}
        aria-valuetext={`${layoutWidths.dashboardWidth} pixels`}
        tabIndex={0}
        onPointerDown={(event) => startResize("dashboard", event)}
        onPointerMove={(event) => resizeFromPointer("dashboard", event)}
        onLostPointerCapture={(event) => { if (resizeStart.current?.pointerId === event.pointerId) resizeStart.current = null; }}
        onKeyDown={(event) => resizeFromKeyboard("dashboard", event)}
      />

      <aside id="right-rail" className="right-rail">
        <div className="dashboard-head"><h2>Dashboard</h2></div>
        <div className="dashboard-tabs" role="tablist" aria-label="Painel do dashboard">
          {(dashboardTabs as Panel[]).map((tab) => <button
            key={tab}
            id={`dashboard-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={panel === tab}
            aria-controls="dashboard-panel"
            tabIndex={panel === tab ? 0 : -1}
            onClick={() => setPanel(tab)}
            onKeyDown={(event) => {
              const nextTab = nextDashboardTab(tab, event.key);
              if (nextTab == null) return;
              event.preventDefault();
              setPanel(nextTab);
              document.getElementById(`dashboard-tab-${nextTab}`)?.focus();
            }}
            className={panel === tab ? "active" : ""}
          >{tab === "system" ? "Sistema" : tab === "ai" ? "IA" : "Projeto"}</button>)}
        </div>
        <div id="dashboard-panel" className="dashboard-tabpanel" role="tabpanel" aria-label="Conteúdo do dashboard" aria-labelledby={`dashboard-tab-${panel}`} tabIndex={0}>
          {panel === "system" && <SystemDashboard />}
          {panel === "ai" && <div className="dashboard-content" tabIndex={0} aria-label="Configuração do modelo e serviço"><div className="ai-card"><div className="ai-card-top"><span className="ai-symbol"><Icon name="spark" size={18} /></span><span className={`connection-status ${statusClass}`}>{overallStatusLabel}</span></div><span className="section-label">Modelo ativo</span><strong className="model-name">{model}</strong><p className="service-availability">Serviço: {serviceStatus === "checking" ? "verificando" : serviceStatus === "available" ? "disponível" : "indisponível"}</p><p className={`model-availability ${modelStatus === "missing" ? "missing" : ""}`}>Modelo: {modelStatus === "checking" ? "verificando" : modelStatus === "ready" ? "pronto" : modelStatus === "missing" ? "ausente" : "desconhecido"}</p>{statusError && <p className="status-error">{statusError}</p>}<label className="model-select-label">Modelo<input value={model} onChange={(event) => { modelRef.current = event.target.value; setModel(event.target.value); setModelStatus("checking"); }} aria-label="Nome do modelo Ollama" /></label><div className="model-select-label"><span id="keep-alive-label">Manter modelo carregado</span>
            <ThemedSelect id="keep-alive" labelId="keep-alive-label" value={keepAlive} onChange={setKeepAlive}
              options={[
                { value: "0", label: "Descarregar ao terminar" },
                { value: "5m", label: "5 minutos" },
                { value: "10m", label: "10 minutos" },
              ]}
            />
          </div><p className="keep-alive-note">Manter carregado acelera próximas chamadas, mas reserva memória para os pesos do modelo e o contexto. O custo depende do modelo e de quanto dele cabe na GPU.</p><button className="outline-action" onClick={() => void checkOllama()}>Verificar serviço e modelo</button></div><div className="dashboard-note"><span className="note-icon">i</span><p>O histórico salvo é preservado. O envio inclui instruções de sistema e os turnos completos mais recentes até um orçamento aproximado de 10 mil caracteres. Caractere não equivale a token e o contexto varia por modelo; uma instrução ou pergunta muito longa pode exceder o orçamento. Respostas nunca são cortadas.</p></div></div>}
          {panel === "project" && <div className="dashboard-content project-empty" tabIndex={0} aria-label="Projetos"><div className="project-empty-icon"><Icon name="folder" size={22} /></div><h3>Nenhum projeto selecionado</h3><p>O cadastro e o vínculo de projetos ainda estão indisponíveis.</p></div>}
        </div>
      </aside>
      {renameDialog && renameValidation && <ConversationDialog labelId="rename-dialog-title" onDismiss={closeRenameDialog}>
          <h2 id="rename-dialog-title">Renomear conversa</h2>
          <form onSubmit={saveConversationTitle}>
            <label htmlFor="conversation-title-input">Nome da conversa</label>
            <input
              id="conversation-title-input"
              value={renameDialog.value}
              onChange={(event) => setRenameDialog((current) => current ? { ...current, value: event.target.value } : current)}
              aria-invalid={!renameValidation.valid}
              aria-describedby="conversation-title-count"
              autoComplete="off"
            />
            <p id="conversation-title-count" className={renameValidation.valid ? "rename-title-count" : "rename-title-count invalid"} role="status" aria-live="polite">
              {renameValidation.count}/120 caracteres{renameValidation.valid ? "" : renameValidation.count === 0 ? " · O nome não pode ficar vazio." : " · Use no máximo 120 caracteres."}
            </p>
            <div className="rename-dialog-actions">
              <button type="button" className="rename-cancel" onClick={closeRenameDialog}>Cancelar</button>
              <button type="submit" className="rename-save" disabled={!renameValidation.valid}>Salvar nome</button>
            </div>
          </form>
      </ConversationDialog>}
      {deleteDialogId && <ConversationDialog labelId="delete-dialog-title" descriptionId="delete-dialog-description" onDismiss={closeDeleteDialog}>
        <h2 id="delete-dialog-title">Excluir conversa?</h2>
        <p id="delete-dialog-description">Esta ação remove a conversa e suas mensagens salvas deste dispositivo. Não pode ser desfeita.</p>
        <div className="rename-dialog-actions">
          <button type="button" onClick={closeDeleteDialog}>Cancelar</button>
          <button type="button" className="rename-save destructive" onClick={confirmDeleteConversation}>Excluir conversa</button>
        </div>
      </ConversationDialog>}
    </div>
  );
}

export default App;
