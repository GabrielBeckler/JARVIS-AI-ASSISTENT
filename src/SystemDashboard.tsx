import { useEffect, useState } from "react";
import { chartPath, CHART_WINDOW_MS } from "./systemChart.js";
import { getSystemSnapshot, type SystemMetric, type SystemSnapshot } from "./systemMonitor";

const SAMPLE_INTERVAL_MS = 2_000;
const MAX_SAMPLES = 30;
const STALE_AFTER_MS = 5_000;

function metricText(metric: SystemMetric, digits = 0): string {
  return metric.value == null || !Number.isFinite(metric.value) ? "N/D" : `${metric.value.toFixed(digits)}${metric.unit}`;
}

function bytesText(metric: SystemMetric): string {
  if (metric.value == null || !Number.isFinite(metric.value)) return "N/D";
  const gib = metric.value / 1_073_741_824;
  return `${gib.toFixed(gib >= 10 ? 1 : 2)} GiB`;
}

function reasonText(metric: SystemMetric): string {
  return metric.value == null ? metric.reason ?? "Fonte não disponível" : "";
}

function briefReason(reason: string): string {
  if (reason.includes("Velocidade não disponível")) return "EDAC sem dados; SMBIOS pode exigir permissão";
  if (reason.includes("velocidade") || reason.includes("Velocidade")) return "Velocidade sem fonte acessível";
  if (reason.toLowerCase().includes("driver nvidia")) return "Driver NVIDIA indisponível";
  if (reason.toLowerCase().includes("vram")) return "VRAM sem leitura do driver";
  return reason;
}

function updatedLabel(timestampMs: number): string {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestampMs);
}

function SystemIcon({ name, size = 15 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "cpu" ? <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9h6v6H9zM9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4" /></>
      : name === "memory" ? <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10v4m4-4v4m4-4v4m4-4v4" /></>
        : <><rect x="3" y="4" width="18" height="15" rx="2" /><circle cx="12" cy="11.5" r="3.5" /><path d="M7 19v2m10-2v2" /></>}
  </svg>;
}

function MetricCard({
  title,
  icon,
  value,
  name,
  detail,
  reason,
  percent,
}: {
  title: string;
  icon: string;
  value: string;
  name: string;
  detail: string;
  reason: string;
  percent: number | null;
}) {
  const progress = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return <div className="metric-card">
    <div className="metric-head"><span><SystemIcon name={icon} /> {title}</span><span className={`metric-value ${percent == null ? "na" : ""}`}>{value}</span></div>
    <div className="metric-track" aria-hidden="true">
      {percent != null && <i className={`metric-fill ${icon}`} style={{ width: `${progress}%` }} />}
    </div>
    <div className="metric-foot">
      <span>{name}</span>
      <span title={reason || undefined}>{detail}{reason ? ` · ${briefReason(reason)}` : ""}</span>
    </div>
  </div>;
}

export function SystemDashboard() {
  const [samples, setSamples] = useState<SystemSnapshot[]>([]);
  const [collectionError, setCollectionError] = useState("");
  const [now, setNow] = useState(Date.now());
  const latest = samples[samples.length - 1];
  const ageMs = latest ? Math.max(0, now - latest.timestampMs) : null;
  const stale = ageMs != null && ageMs > STALE_AFTER_MS;
  const oldData = Boolean(collectionError) || stale;

  useEffect(() => {
    let mounted = true;
    let timer = 0;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const collect = async () => {
      const startedAt = performance.now();
      try {
        const snapshot = await getSystemSnapshot();
        if (!mounted) return;
        setSamples((current) => [...current, snapshot]
          .filter((sample) => sample.timestampMs >= snapshot.timestampMs - CHART_WINDOW_MS)
          .slice(-MAX_SAMPLES));
        setCollectionError("");
        setNow(Date.now());
      } catch (error) {
        if (!mounted) return;
        setCollectionError(error instanceof Error ? error.message : "Falha ao consultar métricas do sistema");
      } finally {
        if (mounted) {
          const remaining = Math.max(0, SAMPLE_INTERVAL_MS - (performance.now() - startedAt));
          timer = window.setTimeout(collect, remaining);
        }
      }
    };
    void collect();
    return () => {
      mounted = false;
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, []);

  const cpu = latest?.cpu;
  const memory = latest?.memory;
  const gpu = latest?.gpu;
  const cpuUsage = cpu?.usagePercent.value ?? null;
  const ramUsage = memory?.usedPercent.value ?? null;
  const gpuUsage = gpu?.usagePercent.value ?? null;
  const cpuTemp = latest?.temperatures.cpuCelsius;
  const gpuTemp = latest?.temperatures.gpuCelsius;
  const waiting = !latest && !collectionError;

  const chartEnd = Math.max(now, latest?.timestampMs ?? 0);
  const series = [
    { label: "CPU", className: "cpu", value: (sample: SystemSnapshot) => sample.cpu.usagePercent.value },
    { label: "RAM", className: "ram", value: (sample: SystemSnapshot) => sample.memory.usedPercent.value },
    { label: "GPU", className: "gpu", value: (sample: SystemSnapshot) => sample.gpu.usagePercent.value },
  ].map(({ value, ...item }) => ({
    ...item,
    path: chartPath(samples.map((sample) => ({ timestampMs: sample.timestampMs, value: value(sample) })), chartEnd, SAMPLE_INTERVAL_MS),
  }));

  return <div className="dashboard-content system-dashboard" tabIndex={0} aria-label="Métricas do sistema">
    <div className="system-summary">
      <strong>{latest?.platformName ?? (waiting ? "Sistema" : "Plataforma N/D")}</strong>
      <span className={`live-label ${!latest && collectionError ? "unavailable" : oldData ? "stale" : latest ? "available" : "unavailable"}`}><i />{waiting ? "Verificando" : !latest ? "Indisponível" : oldData ? "Dados antigos" : "Ao vivo"}</span>
    </div>

    {collectionError && <div className="system-collection-notice" role="status">
      {latest ? `Dados antigos · última coleta falhou: ${collectionError}` : `Coleta indisponível: ${collectionError}`}
    </div>}

    <MetricCard title="Processador" icon="cpu" value={cpu ? metricText(cpu.usagePercent) : "N/D"}
      name={cpu?.name ?? (waiting ? "Verificando processador…" : cpu?.nameReason ?? "Nome não disponível")}
      detail="Uso total" reason={cpu ? reasonText(cpu.usagePercent) : ""} percent={cpuUsage} />

    <MetricCard title="Memória RAM" icon="memory" value={memory ? metricText(memory.usedPercent) : "N/D"}
      name={memory ? `${bytesText(memory.usedBytes)} usados de ${bytesText(memory.totalBytes)}` : waiting ? "Verificando memória…" : "RAM não disponível"}
      detail={`Velocidade: ${memory ? metricText(memory.speedMtS) : "N/D"}`}
      reason={memory ? reasonText(memory.usedBytes) || reasonText(memory.speedMtS) : ""} percent={ramUsage} />

    <MetricCard title="GPU" icon="gpu" value={gpu ? metricText(gpu.usagePercent) : "N/D"}
      name={gpu?.name ?? (waiting ? "Verificando GPU…" : gpu?.nameReason ?? "GPU não detectada")}
      detail={gpu ? `VRAM ${bytesText(gpu.vramUsedBytes)} / ${bytesText(gpu.vramTotalBytes)}` : "VRAM N/D"}
      reason={gpu ? [reasonText(gpu.usagePercent), reasonText(gpu.vramUsedBytes)].filter(Boolean).join(" · ") : ""} percent={gpuUsage} />

    <section className="temperature-card" aria-labelledby="temperatures-title">
      <h3 id="temperatures-title">Temperaturas</h3>
      <dl>
        {[{ label: "CPU", sensor: cpuTemp }, { label: "GPU", sensor: gpuTemp }].map(({ label, sensor }) =>
          <div key={label}>
            <dt>{label}</dt>
            <dd>{sensor ? metricText(sensor, 1) : "N/D"}</dd>
            {sensor?.reason && <dd className="temperature-reason">{briefReason(sensor.reason)}</dd>}
          </div>
        )}
      </dl>
    </section>

    <section className="chart-card" aria-labelledby="chart-heading">
      <div className="chart-title"><h3 id="chart-heading">Atividade</h3><span>Últimos 60 s</span></div>
      {series.some(({ path }) => path) ? <svg className="system-chart" viewBox="0 0 100 72" preserveAspectRatio="none" role="img" aria-label="Uso de CPU, RAM e GPU nos últimos 60 segundos">
        {series.map(({ label, className, path }) => <path key={label} className={`chart-line ${className}-line`} d={path} />)}
      </svg> : <p className="chart-empty">{waiting ? "Coletando dados…" : "Sem amostras disponíveis"}</p>}
      <div className="chart-legend">{series.map(({ label, className, path }) => <span key={label}><i className={`chart-key ${className}`} />{label}{!path && " · N/D"}</span>)}</div>
    </section>

    <div className="system-footer"><span className="pulse-dot" />{latest ? `${oldData ? "Dados antigos · " : ""}última leitura ${updatedLabel(latest.timestampMs)}${ageMs != null && ageMs > STALE_AFTER_MS ? ` · há ${Math.floor(ageMs / 1_000)} s` : ""}` : collectionError || "Aguardando primeira leitura"}</div>
  </div>;
}
