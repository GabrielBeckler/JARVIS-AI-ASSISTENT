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

export function getSystemSnapshot(): Promise<SystemSnapshot> {
  return invoke<SystemSnapshot>("system_snapshot");
}
