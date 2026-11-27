import { Channel, invoke } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef, useState } from "react";
import { prepareSpeech, restoreVoiceVolume, SpeechChunks, VOICE_VOLUME_KEY } from "./voiceText.js";

type NativeStage = "recording" | "transcribing" | "synthesizing" | "playing";
type Stage = NativeStage | "starting" | "waiting" | "stopping";
type Operation = {
  id?: number;
  cancelled: boolean;
};
type Reading = {
  conversationId: string;
  requestId: string | null;
  chunks: SpeechChunks;
  queue: string[];
  complete: boolean;
  running: boolean;
};
type VoiceState =
  | { stage: Stage }
  | { stage: "error"; error: string; conversationId: string }
  | { stage: "idle" };

function control(id: number, cancel: boolean) {
  return invoke<void>("voice_control", { id, cancel });
}

function voiceError(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Falha na operação de voz.";
}

function cancel(operation: Operation | null) {
  if (!operation || operation.cancelled) return;
  operation.cancelled = true;
  if (operation.id !== undefined) void control(operation.id, true).catch(() => undefined);
}

export function useLocalVoice(conversationId: string, onTranscript: (id: string, text: string) => void) {
  const [state, setState] = useState<VoiceState>({ stage: "idle" });
  const [volume, setVolume] = useState(() => {
    try { return restoreVoiceVolume(localStorage.getItem(VOICE_VOLUME_KEY)); }
    catch { return 100; }
  });
  const volumeRef = useRef(volume);
  const [voiceName, setVoiceName] = useState(() => {
    try {
      const saved = localStorage.getItem("aurion.voice.name");
      return saved === "cadu" || saved === "edresson" ? saved : "faber";
    } catch { return "faber"; }
  });
  const voiceNameRef = useRef(voiceName);

  function changeVoice(value: string) {
    if (!["faber", "cadu", "edresson"].includes(value)) return;
    voiceNameRef.current = value;
    setVoiceName(value);
    try { localStorage.setItem("aurion.voice.name", value); } catch { /* Keep the session preference. */ }
  }
  const selected = useRef(conversationId);
  const current = useRef<Operation | null>(null);
  const reading = useRef<Reading | null>(null);
  const mounted = useRef(false);

  function changeVolume(value: number) {
    volumeRef.current = value;
    setVolume(value);
    try { localStorage.setItem(VOICE_VOLUME_KEY, String(value)); }
    catch { /* The current session still uses the selected volume. */ }
  }

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reading.current = null;
      cancel(current.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (selected.current === conversationId) return;
    selected.current = conversationId;
    reading.current = null;
    cancel(current.current);
    setState({ stage: current.current ? "stopping" : "idle" });
  }, [conversationId]);

  async function invokeVoice<T>(
    invokeCommand: (id: number, onStage: Channel<NativeStage>) => Promise<T>,
  ): Promise<{ value: T } | null> {
    const operation: Operation = { cancelled: false };
    current.current = operation;
    try {
      operation.id = await invoke<number>("voice_reserve");
      if (operation.cancelled) return null;
      const onStage = new Channel<NativeStage>((stage) => {
        if (!operation.cancelled && mounted.current) setState({ stage });
      });
      const value = await invokeCommand(operation.id, onStage);
      return operation.cancelled ? null : { value };
    } catch (error) {
      if (!operation.cancelled) throw error;
      return null;
    } finally {
      if (operation.id !== undefined) await control(operation.id, true).catch(() => undefined);
      current.current = null;
    }
  }

  function reportReadingState() {
    if (mounted.current) setState({ stage: reading.current ? "waiting" : "idle" });
  }

  async function drain(session: Reading) {
    if (current.current || session.running || reading.current !== session) return;
    session.running = true;
    try {
      while (reading.current === session && session.queue.length > 0) {
        const text = session.queue.shift()!;
        if (mounted.current) setState({ stage: "synthesizing" });
        await invokeVoice((id, onStage) => invoke<void>("voice_speak", { id, onStage, text, volume: volumeRef.current, voice: voiceNameRef.current }));
      }
      if (reading.current === session && session.complete) reading.current = null;
    } catch (error) {
      if (reading.current === session) {
        reading.current = null;
        if (mounted.current) setState({
          stage: "error", conversationId: session.conversationId,
          error: `${voiceError(error)} A resposta escrita pode ser lida pelo botão “Ouvir resposta”.`,
        });
        return;
      }
    } finally {
      session.running = false;
    }
    if (reading.current && reading.current !== session) void drain(reading.current);
    else reportReadingState();
  }

  function startReply(id: string, requestId: string) {
    if (selected.current !== id) return;
    const previous = reading.current;
    const session: Reading = {
      conversationId: id, requestId, chunks: new SpeechChunks(), queue: [], complete: false, running: false,
    };
    reading.current = session;
    if (previous?.running) cancel(current.current);
    if (!current.current) reportReadingState();
  }

  function appendReply(requestId: string, fragment: string) {
    const session = reading.current;
    if (session?.requestId !== requestId) return;
    session.queue.push(...session.chunks.push(fragment));
    if (session.queue.length) void drain(session);
  }

  function finishReply(requestId: string, finalFragment: string) {
    const session = reading.current;
    if (session?.requestId !== requestId) return;
    session.queue.push(...session.chunks.push(finalFragment), ...session.chunks.finish());
    session.complete = true;
    void drain(session);
  }

  function stop() {
    reading.current = null;
    cancel(current.current);
    if (mounted.current) setState({ stage: current.current ? "stopping" : "idle" });
  }

  async function startCapture() {
    if (current.current || reading.current) return;
    const id = conversationId;
    setState({ stage: "starting" });
    let transcript: { value: string } | null;
    try {
      transcript = await invokeVoice((jobId, onStage) => invoke<string>("voice_capture", { id: jobId, onStage }));
    } catch (error) {
      if (reading.current) void drain(reading.current);
      else if (mounted.current && selected.current === id) setState({ stage: "error", conversationId: id, error: voiceError(error) });
      return;
    }
    // Release the capture reservation before exposing the rascunho for sending.
    reportReadingState();
    if (transcript && mounted.current && selected.current === id) onTranscript(id, transcript.value);
    if (reading.current) void drain(reading.current);
  }

  async function finishCapture() {
    const operation = current.current;
    if (operation?.id === undefined || state.stage !== "recording") return;
    setState({ stage: "transcribing" });
    try {
      await control(operation.id, false);
    } catch {
      if (current.current === operation && !operation.cancelled) setState({ stage: "recording" });
    }
  }

  function speak(markdown: string) {
    if (current.current || reading.current) return;
    const text = prepareSpeech(markdown);
    if (!text) {
      setState({ stage: "error", conversationId, error: "Esta resposta não tem texto para leitura." });
      return;
    }
    const session: Reading = {
      conversationId, requestId: null, chunks: new SpeechChunks(), queue: [text], complete: true, running: false,
    };
    reading.current = session;
    void drain(session);
  }

  return {
    state: state.stage === "error" && state.conversationId !== conversationId ? { stage: "idle" as const } : state,
    volume,
    changeVolume,
    voiceName,
    changeVoice,
    startCapture,
    finishCapture,
    startReply,
    appendReply,
    finishReply,
    stopReply: (requestId: string) => { if (reading.current?.requestId === requestId) stop(); },
    speak,
    stop,
  };
}
