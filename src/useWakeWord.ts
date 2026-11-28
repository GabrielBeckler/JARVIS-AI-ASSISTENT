import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

type WakeStage = "paused" | "connecting" | "waiting" | "capturing" | "awaiting_request" | "transcribing" | "suspended" | "error";
type WakeSnapshot = {
  revision: number;
  enabled: boolean;
  closeToTray: boolean;
  autostart: boolean;
  trayAvailable: boolean;
  stage: WakeStage;
  detail: string | null;
  transcripts: { id: number; text: string }[];
};

const labels: Record<WakeStage, string> = {
  paused: "Escuta por Jota pausada",
  connecting: "Preparando a escuta por Jota…",
  waiting: "Aguardando “Jota”",
  capturing: "Ouvindo seu pedido…",
  awaiting_request: "Estou ouvindo. Pode falar.",
  transcribing: "Transcrevendo em português…",
  suspended: "Escuta por Jota suspensa durante o uso da voz",
  error: "Falha na escuta por Jota.",
};

function messageOf(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Falha ao configurar a escuta.";
}

export function acknowledgeWakeTranscript(id: number) {
  return invoke<void>("wake_acknowledge", { id });
}

export function useWakeWord() {
  const [snapshot, setSnapshot] = useState<WakeSnapshot>();
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState(false);

  function accept(next: WakeSnapshot) {
    setSnapshot((current) => !current || next.revision >= current.revision ? next : current);
  }

  useEffect(() => {
    let live = true;
    const subscription = listen<WakeSnapshot>("wake-status", ({ payload }) => {
      if (live) accept(payload);
    });
    void subscription.then(() => invoke<WakeSnapshot>("wake_status"))
      .then((value) => { if (live) accept(value); })
      .catch(() => { if (live) setError("A escuta por Jota está disponível no aplicativo para Fedora."); });
    return () => {
      live = false;
      void subscription.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  async function update(command: string, args: Record<string, boolean>) {
    setUpdating(true);
    setError("");
    try {
      accept(await invoke<WakeSnapshot>(command, args));
    } catch (error) {
      setError(messageOf(error));
    } finally {
      setUpdating(false);
    }
  }

  return {
    snapshot,
    updating,
    error,
    label: snapshot ? snapshot.detail || labels[snapshot.stage] : "",
    configure: (patch: { enabled?: boolean; closeToTray?: boolean }) => update("wake_configure", patch),
    autostart: (enabled: boolean) => update("wake_autostart", { enabled }),
  };
}
