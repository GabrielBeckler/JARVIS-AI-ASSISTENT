import { invoke } from "@tauri-apps/api/core";

export type SystemMetric = {
  value: number | null;
  unit: string;
  reason: string | null;
};

export type SystemSnapshot = {
  timestampMs: number;
  platformName: string | null;
  cpu: {
    name: string | null;
    nameReason: string | null;
    usagePercent: SystemMetric;
  };
  memory: {
    usedBytes: SystemMetric;
    totalBytes: SystemMetric;
    usedPercent: SystemMetric;
    speedMtS: SystemMetric;
  };
  gpu: {
    name: string | null;
    nameReason: string | null;
    usagePercent: SystemMetric;
    vramUsedBytes: SystemMetric;
    vramTotalBytes: SystemMetric;
  };
  temperatures: {
    cpuCelsius: SystemMetric;
    gpuCelsius: SystemMetric;
  };
};

let pendingSnapshot: Promise<SystemSnapshot> | null = null;

export function getSystemSnapshot(): Promise<SystemSnapshot> {
  if (!pendingSnapshot) {
    const request = invoke<SystemSnapshot>("system_snapshot");
    const shared = request.finally(() => {
      if (pendingSnapshot === shared) pendingSnapshot = null;
    });
    pendingSnapshot = shared;
  }
  return pendingSnapshot;
}
