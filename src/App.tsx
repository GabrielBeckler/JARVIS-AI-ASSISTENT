import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { appendAssistantOnce, isCurrentRequest, restoreConversations, updateMessage, type StoredConversation } from "./chat.js";
import { isModelInstalled, shouldUseFastMode, toChatContext, type StoredMessage } from "./ollama.js";
import { listOllamaModels, normalizeOllamaError, streamOllamaChat } from "./ollamaService";
import "./App.css";

type Message = StoredMessage;
type Conversation = StoredConversation;
type Panel = "system" | "ai" | "project";
type ServiceStatus = "checking" | "available" | "unavailable";
type ModelStatus = "checking" | "missing" | "ready" | "unknown";

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
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    cpu: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9zM9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4" /></>,
    memory: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10v4m4-4v4m4-4v4m4-4v4" /></>,
    gpu: <><rect x="3" y="4" width="18" height="15" rx="2" /><circle cx="12" cy="11.5" r="3.5" /><path d="M7 19v2m10-2v2" /></>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2L12 3Z" /><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
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
  const [activeId, setActiveId] = useState(conversations[0]?.id ?? starter.id);
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [panel, setPanel] = useState<Panel>("system");
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>("checking");
  const [modelStatus, setModelStatus] = useState<ModelStatus>("checking");
  const [model, setModel] = useState(defaultModel);
  const modelRef = useRef(model);
  const [activeRequests, setActiveRequests] = useState<Record<string, string>>({});
  const [streamingByConversation, setStreamingByConversation] = useState<Record<string, { requestId: string; content: string; model: string; createdAt: number }>>({});
  const [errorsByConversation, setErrorsByConversation] = useState<Record<string, string>>({});
  const [statusError, setStatusError] = useState("");
  const activeRequestsRef = useRef(new Map<string, string>());
  const statusCheckRef = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const active = conversations.find((conversation) => conversation.id === activeId) ?? conversations[0] ?? starter;
  const recent = conversations.filter((conversation) => conversation.messages.length > 0 && conversation.title.toLowerCase().includes(search.toLowerCase()));
  const activeRequestId = activeRequests[active.id];
  const activeStream = streamingByConversation[active.id];
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
    localStorage.setItem("jarvis.conversations", JSON.stringify(conversations));
  }, [conversations]);

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

  const newConversation = () => {
    const conversation = { ...starter, id: crypto.randomUUID(), updatedAt: Date.now() };
    setConversations((items) => [conversation, ...items]);
    setActiveId(conversation.id);
    setDraft("");
    textarea.current?.focus();
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
    const conversation = conversations.find((item) => item.id === activeId);
    if (!conversation || activeRequestsRef.current.has(conversation.id)) return;
    const retrying = retryMessageId
      ? conversation.messages.find((message) => message.id === retryMessageId && message.role === "user" && message.delivery === "failed")
      : undefined;
    if (retryMessageId && !retrying) return;
    const content = retrying?.content ?? draft.trim();
    if (!content) return;

    const conversationId = conversation.id;
    const requestId = crypto.randomUUID();
    const requestedModel = model;
    const history = toChatContext(conversation.messages.filter((message) => message.id !== retrying?.id));
    const requestMessages = [...history, { role: "user" as const, content }];
    const now = Date.now();
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
    let answer = "";

    statusCheckRef.current += 1;
    setRequestState(conversationId, requestId);
    setStreamingByConversation((items) => ({ ...items, [conversationId]: { requestId, content: "", model: requestedModel, createdAt: now } }));
    setErrorsByConversation((items) => { const next = { ...items }; delete next[conversationId]; return next; });
    if (!retrying) setDraft("");
    setConversations((items) => items.map((item) => {
      if (item.id !== conversationId) return item;
      const messages = retrying
        ? item.messages.map((message) => message.id === retrying.id ? userMessage : message)
        : [...item.messages, userMessage];
      return {
        ...item,
        title: item.messages.length ? item.title : content.slice(0, 36),
        updatedAt: now,
        messages,
      };
    }));

    try {
      const completion = await streamOllamaChat(
        ollamaBaseUrl,
        requestedModel,
        requestMessages,
        shouldUseFastMode(content, history.length > 0) ? false : undefined,
        (fragment) => {
          answer += fragment;
          if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
          setStreamingByConversation((items) => {
            const previous = items[conversationId];
            if (previous && previous.requestId !== requestId) return items;
            return { ...items, [conversationId]: { requestId, content: `${previous?.content ?? ""}${fragment}`, model: requestedModel, createdAt: now } };
          });
        },
      );
      if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
      statusCheckRef.current += 1;
      setServiceStatus("available");
      if (modelRef.current === requestedModel) setModelStatus("ready");
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
        }).map((item) => item.id === conversationId ? { ...item, updatedAt: Date.now() } : item);
      });
    } catch (error) {
      if (!isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) return;
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
      setErrorsByConversation((items) => ({ ...items, [conversationId]: result.message }));
      setConversations((items) => {
        let next = updateMessage(items, conversationId, userMessage.id!, { delivery: "failed" });
        if (partial) {
          next = appendAssistantOnce(next, conversationId, `${requestId}:partial`, {
            id: crypto.randomUUID(), role: "assistant", content: partial,
            model: requestedModel, createdAt: Date.now(), requestId: `${requestId}:partial`, delivery: "failed",
          });
        }
        return next;
      });
    } finally {
      if (isCurrentRequest(activeRequestsRef.current, conversationId, requestId)) {
        setRequestState(conversationId, null);
        setStreamingByConversation((items) => { const next = { ...items }; delete next[conversationId]; return next; });
      }
    }
  };

  return (
    <div className="app-shell">
      <aside className="left-rail">
        <div className="brand-lockup">
          <div className="brand-mark"><Icon name="spark" size={19} /></div>
          <div><strong>JARVIS</strong><span>LOCAL INTELLIGENCE</span></div>
        </div>
        <button className="new-chat" onClick={newConversation}><Icon name="plus" size={17} /><span>Nova conversa</span><kbd>⌘ K</kbd></button>
        <label className="search-box"><Icon name="search" size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar conversas" /><kbd>⌘ F</kbd></label>
        <div className="sidebar-section">
          <div className="section-label">WORKSPACE <button aria-label="Opções do workspace"><Icon name="more" size={16} /></button></div>
          <button className="nav-item"><span className="nav-icon"><Icon name="folder" size={16} /></span><span>Projetos</span><span className="nav-count">0</span></button>
          <button className="nav-item"><span className="nav-icon"><Icon name="chat" size={16} /></span><span>Conversas</span></button>
        </div>
        <div className="sidebar-section recent-section">
          <div className="section-label">RECENTES <button aria-label="Ordenar conversas"><Icon name="more" size={16} /></button></div>
          {recent.length ? recent.slice(0, 8).map((conversation) => (
            <button key={conversation.id} onClick={() => setActiveId(conversation.id)} className={`conversation-link ${conversation.id === activeId ? "selected" : ""}`} title={conversation.title}>
              <Icon name="chat" size={15} /><span>{conversation.title}</span>
            </button>
          )) : <p className="empty-recent">Suas conversas aparecerão aqui.</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="local-badge"><span className="pulse-dot" /> Seus dados ficam neste dispositivo</div>
          <button className="profile-button" onClick={() => setPanel("ai")}><div className="avatar">G</div><div className="profile-copy"><strong>Workspace local</strong><span>Configurações</span></div><Icon name="settings" size={17} /></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><Icon name="chevron" size={14} /><strong>{active?.messages.length ? active.title : "Nova conversa"}</strong></div>
          <div className="topbar-actions"><div className="model-chip"><span className={`status-dot ${serviceStatus === "checking" ? "checking" : serviceStatus === "available" ? "online" : "offline"}`} />{model}<Icon name="chevron" size={13} /></div><button className="icon-button" aria-label="Mais opções"><Icon name="more" /></button><div className="top-avatar">G</div></div>
        </header>

        <section className={`chat-view ${active?.messages.length ? "has-messages" : ""}`}>
          {!active?.messages.length ? (
            <div className="welcome-wrap">
              <div className="welcome-orb"><div className="orb-core"><Icon name="spark" size={25} /></div><span className="orb-ring ring-one" /><span className="orb-ring ring-two" /></div>
              <div className="eyebrow"><span className="pulse-dot" /> ASSISTENTE LOCAL</div>
              <h1>Bom dia, Gabriel<span>.</span></h1>
              <p className="welcome-subtitle">No que vamos trabalhar hoje?</p>
              <div className="suggestion-grid">
                <button className="suggestion-card" onClick={() => setDraft("Como está o desempenho do meu computador?")}><span className="suggestion-icon violet"><Icon name="cpu" /></span><span><strong>Verificar meu sistema</strong><small>Acompanhe o desempenho do computador</small></span><Icon name="chevron" size={15} /></button>
                <button className="suggestion-card" onClick={() => setDraft("Me ajude a planejar meu próximo projeto.")}><span className="suggestion-icon blue"><Icon name="folder" /></span><span><strong>Começar um projeto</strong><small>Organize ideias e próximos passos</small></span><Icon name="chevron" size={15} /></button>
                <button className="suggestion-card" onClick={() => setDraft("Explique como posso usar modelos locais com Ollama.")}><span className="suggestion-icon amber"><Icon name="spark" /></span><span><strong>Explorar IA local</strong><small>Converse com seu modelo no Ollama</small></span><Icon name="chevron" size={15} /></button>
              </div>
            </div>
          ) : (
            <div className="message-list">
              <div className="conversation-date">MENSAGENS DA CONVERSA</div>
              {active.messages.map((message, index) => <article className={`message-row ${message.role} ${message.delivery === "failed" ? "failed" : ""}`} key={`${active.id}-${index}`}>
                <div className={`message-avatar ${message.role}`}>{message.role === "user" ? "G" : <Icon name="spark" size={15} />}</div>
                <div className="message-content">
                  <div className="message-author"><span className="message-author-name">{message.role === "user" ? "Você" : "Jarvis"}</span><span>{message.model ?? "Modelo desconhecido"} · {messageTime(message.createdAt)}</span></div>
                  <p>{message.content}</p>
                  {message.delivery === "failed" && <div className="message-failure-label">{message.role === "assistant" ? "Resposta interrompida · não será enviada no próximo contexto" : "Envio falhou · pergunta preservada"}</div>}
                  {message.role === "user" && message.delivery === "failed" && <button className="retry-message" onClick={() => void sendMessage(undefined, message.id)} disabled={Boolean(activeRequestId)}>Tentar novamente</button>}
                </div>
              </article>)}
              {activeRequestId && activeStream?.requestId === activeRequestId && <article className="message-row assistant"><div className="message-avatar assistant"><Icon name="spark" size={15} /></div><div className="message-content"><div className="message-author"><span className="message-author-name">Jarvis</span><span>{activeStream.model} · {messageTime(activeStream.createdAt)}</span></div>{activeStream.content ? <p>{activeStream.content}</p> : <div className="typing-indicator"><i /><i /><i /></div>}</div></article>}
              <div className="message-end" />
            </div>
          )}
          {errorsByConversation[active.id] && <div className="notice-banner"><span>!</span><p>{errorsByConversation[active.id]}</p><button onClick={() => setErrorsByConversation((items) => { const next = { ...items }; delete next[active.id]; return next; })}>Fechar</button></div>}
          <div className="composer-wrap">
            <form className="composer" onSubmit={sendMessage}>
              <textarea ref={textarea} rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Pergunte qualquer coisa ao Jarvis..." aria-label="Mensagem" />
              <div className="composer-bottom"><div className="composer-tools"><button type="button" className="tool-button mic-button" title="Áudio ainda não configurado" aria-label="Microfone indisponível"><Icon name="mic" size={17} /></button><span className="composer-hint">Enter para enviar <span>·</span> Shift + Enter para nova linha</span></div><button className={`send-button ${draft.trim() ? "ready" : ""}`} type="submit" disabled={!draft.trim() || Boolean(activeRequestId)} aria-label={activeRequestId ? "Gerando resposta" : "Enviar mensagem"}>{activeRequestId ? <span className="send-spinner" /> : <Icon name="send" size={16} />}</button></div>
            </form>
            <p className="privacy-note"><span className="lock-icon">⌑</span> As conversas são processadas localmente no seu computador.</p>
          </div>
        </section>
      </main>

      <aside className="right-rail">
        <div className="dashboard-head"><div><span className="section-label">CENTRAL DE CONTROLE</span><h2>Dashboard</h2></div><button className="icon-button" aria-label="Recolher painel"><Icon name="more" /></button></div>
        <div className="dashboard-tabs" role="tablist">
          {(["system", "ai", "project"] as Panel[]).map((tab) => <button key={tab} role="tab" aria-selected={panel === tab} onClick={() => setPanel(tab)} className={panel === tab ? "active" : ""}>{tab === "system" ? "Sistema" : tab === "ai" ? "IA" : "Projeto"}</button>)}
        </div>
        {panel === "system" && <div className="dashboard-content">
          <div className="system-summary"><div className="summary-icon"><Icon name="cpu" size={17} /></div><div><strong>Seu sistema</strong><span>Fedora Linux · Wayland</span></div><span className="live-label unavailable"><i /> SENSORES N/D</span></div>
          <div className="metric-card"><div className="metric-head"><span><Icon name="cpu" size={15} /> Processador</span><span className="metric-value na">N/D</span></div><div className="metric-track" /><div className="metric-foot"><span>Intel Core i5-12450H</span><span>Uso indisponível</span></div></div>
          <div className="metric-card"><div className="metric-head"><span><Icon name="memory" size={15} /> Memória RAM</span><span className="metric-value na">N/D</span></div><div className="metric-track" /><div className="metric-foot"><span>16 GB total</span><span>Uso indisponível</span></div></div>
          <div className="metric-card"><div className="metric-head"><span><Icon name="gpu" size={15} /> GPU</span><span className="metric-value na">N/D</span></div><div className="metric-track" /><div className="metric-foot"><span>NVIDIA RTX 2050 · 4 GB</span><span>Sensores indisponíveis</span></div></div>
          <div className="temperature-card"><div className="temperature-copy"><span className="section-label">TEMPERATURAS</span><strong>Monitoramento nativo</strong><small>Requer integração com sensores do sistema</small></div><div className="temperature-reading">—°<span>C</span></div></div>
          <div className="chart-card"><div className="chart-title"><span>Atividade recente</span><span>ÚLTIMOS 60S</span></div><div className="chart-placeholder"><div className="chart-grid"><i /><i /><i /></div><div className="chart-empty">Aguardando dados do sistema</div></div><div className="chart-legend"><span><i className="violet-dot" />CPU</span><span><i className="blue-dot" />RAM</span><span><i className="amber-dot" />GPU</span></div></div>
          <div className="system-footer"><span className="pulse-dot" /> Coleta de sensores não configurada</div>
        </div>}
        {panel === "ai" && <div className="dashboard-content"><div className="ai-card"><div className="ai-card-top"><span className="ai-symbol"><Icon name="spark" size={18} /></span><span className={`connection-status ${statusClass}`}>{overallStatusLabel}</span></div><span className="section-label">MODELO ATIVO</span><strong className="model-name">{model}</strong><p className="service-availability">Serviço: {serviceStatus === "checking" ? "verificando" : serviceStatus === "available" ? "disponível" : "indisponível"}</p><p className={`model-availability ${modelStatus === "missing" ? "missing" : ""}`}>Modelo: {modelStatus === "checking" ? "verificando" : modelStatus === "ready" ? "pronto" : modelStatus === "missing" ? "ausente" : "desconhecido"}</p>{statusError && <p className="status-error">{statusError}</p>}<label className="model-select-label">Modelo<input value={model} onChange={(event) => { modelRef.current = event.target.value; setModel(event.target.value); setModelStatus("checking"); }} aria-label="Nome do modelo Ollama" /></label><button className="outline-action" onClick={() => void checkOllama()}>Verificar serviço e modelo</button></div><div className="metric-card"><div className="metric-head"><span>Velocidade de geração</span><span className="metric-value na">— tok/s</span></div><div className="metric-foot"><span>Métricas da geração</span><span>Disponíveis após resposta</span></div></div><div className="dashboard-note"><span className="note-icon">i</span><p>Use um modelo já instalado no Ollama. O nome acima pode ser editado para corresponder à sua biblioteca local.</p></div></div>}
        {panel === "project" && <div className="dashboard-content project-empty"><div className="project-empty-icon"><Icon name="folder" size={22} /></div><h3>Nenhum projeto selecionado</h3><p>Vincule uma conversa a um projeto para manter instruções e contexto organizados.</p><button className="outline-action" onClick={() => setErrorsByConversation((items) => ({ ...items, [active.id]: "O cadastro de projetos será habilitado em uma próxima etapa." }))}>Explorar projetos <Icon name="chevron" size={14} /></button></div>}
        <div className="right-footer"><span>JARVIS AI <b>·</b> BUILD 0.1</span><span>LOCAL FIRST</span></div>
      </aside>
    </div>
  );
}

export default App;
