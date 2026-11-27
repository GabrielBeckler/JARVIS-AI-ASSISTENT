import { Channel, invoke } from "@tauri-apps/api/core";
import { useLayoutEffect, useRef, useState } from "react";

type Stage = "starting" | "recording" | "transcribing" | "synthesizing" | "playing" | "stopping";
type Operation = {
  id?: number;
  conversationId: string;
  cancelled: boolean;
};
type VoiceState =
  | { stage: Stage }
  | { stage: "error"; error: string; conversationId: string }
  | { stage: "idle" };

function control(id: number, cancel: boolean) {
  return invoke<void>("voice_control", { id, cancel });
}

export function useLocalVoice(conversationId: string, onTranscript: (id: string, text: string) => void) {
  const [state, setState] = useState<VoiceState>({ stage: "idle" });
  const selected = useRef(conversationId);
  const current = useRef<Operation | null>(null);
  const mounted = useRef(false);

  function cancel(operation: Operation | null) {
    if (!operation || operation.cancelled) return;
    operation.cancelled = true;
    if (operation.id !== undefined) void control(operation.id, true).catch(() => undefined);
  }

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel(current.current);
    };
  }, []);

  useLayoutEffect(() => {
    selected.current = conversationId;
    const operation = current.current;
    if (operation && operation.conversationId !== conversationId) {
      cancel(operation);
      setState({ stage: "stopping" });
    }
  }, [conversationId]);

  async function run(id: string, text?: string) {
    if (current.current || selected.current !== id) return;
    const operation: Operation = { conversationId: id, cancelled: false };
    current.current = operation;
    setState({ stage: text === undefined ? "starting" : "synthesizing" });
    let result: VoiceState = { stage: "idle" };
    try {
      operation.id = await invoke<number>("voice_reserve");
      if (operation.cancelled) return;
      const onStage = new Channel<Stage>((stage) => {
        if (!operation.cancelled && mounted.current) setState({ stage });
      });
      if (text === undefined) {
        const transcript = await invoke<string>("voice_capture", { id: operation.id, onStage });
        if (!operation.cancelled && mounted.current) onTranscript(id, transcript);
      } else {
        await invoke<void>("voice_speak", { id: operation.id, onStage, text });
      }
    } catch (error) {
      if (!operation.cancelled) {
        result = {
          stage: "error",
          conversationId: id,
          error: typeof error === "string" ? error : error instanceof Error ? error.message : "Falha na operação de voz.",
        };
      }
    } finally {
      // Also releases a reservation if cancellation happened before the native command began.
      if (operation.id !== undefined) await control(operation.id, true).catch(() => undefined);
      current.current = null;
      if (mounted.current) setState(result);
    }
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

  function stop() {
    const operation = current.current;
    if (!operation) return;
    cancel(operation);
    setState({ stage: "stopping" });
  }

  return {
    state: state.stage === "error" && state.conversationId !== conversationId ? { stage: "idle" as const } : state,
    startCapture: () => run(conversationId),
    finishCapture,
    speak: (id: string, text: string) => run(id, text),
    stop,
  };
}
