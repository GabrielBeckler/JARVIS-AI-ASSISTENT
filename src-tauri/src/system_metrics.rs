use serde::Serialize;
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::OnceLock,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CPU_SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
const COMMAND_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricValue {
    pub value: Option<f64>,
    pub unit: &'static str,
    pub reason: Option<String>,
}

impl MetricValue {
    fn available(value: f64, unit: &'static str) -> Self {
        Self {
            value: Some(value),
            unit,
            reason: None,
        }
    }

    fn unavailable(unit: &'static str, reason: impl Into<String>) -> Self {
        Self {
            value: None,
            unit,
            reason: Some(reason.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    pub name: Option<String>,
    pub name_reason: Option<String>,
    pub usage_percent: MetricValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    pub used_bytes: MetricValue,
    pub total_bytes: MetricValue,
    pub used_percent: MetricValue,
    pub speed_mt_s: MetricValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMetrics {
    pub name: Option<String>,
    pub name_reason: Option<String>,
    pub usage_percent: MetricValue,
    pub vram_used_bytes: MetricValue,
    pub vram_total_bytes: MetricValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperatureMetrics {
    pub cpu_celsius: MetricValue,
    pub gpu_celsius: MetricValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub timestamp_ms: u128,
    pub platform_name: Option<String>,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub gpu: GpuMetrics,
    pub temperatures: TemperatureMetrics,
}

#[tauri::command]
pub async fn system_snapshot() -> Result<SystemSnapshot, String> {
    tauri::async_runtime::spawn_blocking(collect_snapshot)
        .await
        .map_err(|error| format!("Falha na coleta do sistema: {error}"))
}

fn collect_snapshot() -> SystemSnapshot {
    let (cpu_usage, cpu_usage_reason) = read_cpu_usage();
    let cpu_name = read_cpu_name();
    let (memory_used, memory_total) = read_memory();
    let memory_percent = match (memory_used.value, memory_total.value) {
        (Some(used), Some(total)) if total > 0.0 => {
            MetricValue::available((used / total * 100.0).clamp(0.0, 100.0), "%")
        }
        _ => MetricValue::unavailable("%", "Memória total ou disponível não pôde ser lida"),
    };

    let gpu = read_gpu();
    let cpu_temperature = read_cpu_temperature();
    let gpu_temperature = read_gpu_temperature(&gpu.device_path, gpu.temperature.clone());

    SystemSnapshot {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        platform_name: read_platform_name(),
        cpu: CpuMetrics {
            name: cpu_name.clone(),
            name_reason: cpu_name
                .is_none()
                .then(|| "Nome não exposto em /proc/cpuinfo".into()),
            usage_percent: cpu_usage
                .map(|value| MetricValue::available(value, "%"))
                .unwrap_or_else(|| MetricValue::unavailable("%", cpu_usage_reason)),
        },
        memory: MemoryMetrics {
            used_bytes: memory_used,
            total_bytes: memory_total,
            used_percent: memory_percent,
            speed_mt_s: read_memory_speed(),
        },
        gpu: GpuMetrics {
            name: gpu.name.clone(),
            name_reason: gpu
                .name
                .is_none()
                .then(|| "GPU não identificada pelo sistema".into()),
            usage_percent: gpu.usage,
            vram_used_bytes: gpu.vram_used,
            vram_total_bytes: gpu.vram_total,
        },
        temperatures: TemperatureMetrics {
            cpu_celsius: cpu_temperature,
            gpu_celsius: gpu_temperature,
        },
    }
}

#[derive(Debug, Clone, Copy)]
struct CpuCounters {
    total: u64,
    idle: u64,
}

fn parse_cpu_counters(contents: &str) -> Option<CpuCounters> {
    let line = contents.lines().find(|line| line.starts_with("cpu "))?;
    let fields = line
        .split_whitespace()
        .skip(1)
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if fields.len() < 4 {
        return None;
    }
    let total = fields.iter().take(8).sum();
    let idle = fields[3].saturating_add(*fields.get(4).unwrap_or(&0));
    Some(CpuCounters { total, idle })
}

fn cpu_usage_between(before: CpuCounters, after: CpuCounters) -> Option<f64> {
    let total_delta = after.total.checked_sub(before.total)?;
    let idle_delta = after.idle.checked_sub(before.idle)?;
    if total_delta == 0 {
        return None;
    }
    Some(
        (100.0 * (total_delta.saturating_sub(idle_delta) as f64 / total_delta as f64))
            .clamp(0.0, 100.0),
    )
}

fn read_cpu_usage() -> (Option<f64>, String) {
    let first = fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|contents| parse_cpu_counters(&contents));
    let Some(first) = first else {
        return (None, "Leitura de /proc/stat indisponível".into());
    };
    thread::sleep(CPU_SAMPLE_INTERVAL);
    let second = fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|contents| parse_cpu_counters(&contents));
    let Some(second) = second else {
        return (None, "Segunda leitura de /proc/stat indisponível".into());
    };
    match cpu_usage_between(first, second) {
        Some(usage) => (Some(usage), String::new()),
        None => (
            None,
            "Não houve delta de atividade suficiente entre as amostras".into(),
        ),
    }
}

fn read_cpu_name() -> Option<String> {
    let contents = fs::read_to_string("/proc/cpuinfo").ok()?;
    contents
        .lines()
        .find_map(|line| {
            line.strip_prefix("model name\t: ")
                .or_else(|| line.strip_prefix("Model\t: "))
        })
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn parse_meminfo(contents: &str) -> Option<(u64, u64)> {
    let mut values = std::collections::HashMap::new();
    for line in contents.lines() {
        let (key, value) = line.split_once(':')?;
        if matches!(key, "MemTotal" | "MemAvailable") {
            let kib = value.split_whitespace().next()?.parse::<u64>().ok()?;
            values.insert(key, kib.saturating_mul(1024));
        }
    }
    let total = *values.get("MemTotal")?;
    let available = *values.get("MemAvailable")?;
    Some((total.saturating_sub(available), total))
}

fn read_memory() -> (MetricValue, MetricValue) {
    let parsed = fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|contents| parse_meminfo(&contents));
    match parsed {
        Some((used, total)) => (
            MetricValue::available(used as f64, "bytes"),
            MetricValue::available(total as f64, "bytes"),
        ),
        None => (
            MetricValue::unavailable(
                "bytes",
                "MemAvailable/MemTotal indisponível em /proc/meminfo",
            ),
            MetricValue::unavailable("bytes", "MemTotal indisponível em /proc/meminfo"),
        ),
    }
}

#[derive(Debug, Clone)]
struct GpuReading {
    name: Option<String>,
    device_path: Option<PathBuf>,
    usage: MetricValue,
    vram_used: MetricValue,
    vram_total: MetricValue,
    temperature: Option<f64>,
}

#[derive(Debug)]
struct NvidiaRow {
    name: String,
    usage_percent: Option<f64>,
    memory_used_mib: Option<f64>,
    memory_total_mib: Option<f64>,
    temperature_celsius: Option<f64>,
}

fn csv_number(value: &str) -> Option<f64> {
    let value = value.trim();
    if value.is_empty()
        || value.eq_ignore_ascii_case("n/a")
        || value.eq_ignore_ascii_case("[not supported]")
    {
        return None;
    }
    value
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn mib_to_bytes(value: f64) -> f64 {
    value * 1_048_576.0
}

fn parse_nvidia_csv(contents: &str) -> Option<NvidiaRow> {
    let line = contents.lines().find(|line| !line.trim().is_empty())?;
    let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
    if fields.len() < 5 || fields[0].is_empty() {
        return None;
    }
    Some(NvidiaRow {
        name: fields[0].to_owned(),
        usage_percent: csv_number(fields[1]).filter(|value| *value <= 100.0),
        memory_used_mib: csv_number(fields[2]),
        memory_total_mib: csv_number(fields[3]),
        temperature_celsius: csv_number(fields[4]),
    })
}

#[derive(Debug)]
enum CommandFailure {
    Missing,
    TimedOut,
    Failed(String),
}

fn run_command(program: &str, args: &[&str], timeout: Duration) -> Result<String, CommandFailure> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                CommandFailure::Missing
            } else {
                CommandFailure::Failed(error.to_string())
            }
        })?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|error| CommandFailure::Failed(error.to_string()))?;
                if !status.success() {
                    return Err(CommandFailure::Failed(
                        String::from_utf8_lossy(&output.stderr).trim().to_owned(),
                    ));
                }
                return String::from_utf8(output.stdout)
                    .map_err(|error| CommandFailure::Failed(error.to_string()));
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(15)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CommandFailure::TimedOut);
            }
            Err(error) => {
                let _ = child.kill();
                return Err(CommandFailure::Failed(error.to_string()));
            }
        }
    }
}

fn command_reason(error: &CommandFailure, command: &str) -> String {
    match error {
        CommandFailure::Missing => format!("Comando {command} não instalado"),
        CommandFailure::TimedOut => format!("{command} excedeu o limite de tempo"),
        CommandFailure::Failed(detail) if detail.to_lowercase().contains("driver") => {
            "Driver NVIDIA indisponível".into()
        }
        CommandFailure::Failed(detail) if detail.to_lowercase().contains("permission") => {
            "Permissão negada pelo driver".into()
        }
        CommandFailure::Failed(_) => format!("{command} não conseguiu consultar o dispositivo"),
    }
}

#[derive(Debug, Clone)]
struct DrmDevice {
    path: PathBuf,
    pci_address: String,
    vendor: String,
}

fn drm_devices() -> Vec<DrmDevice> {
    let Ok(entries) = fs::read_dir("/sys/class/drm") else {
        return Vec::new();
    };
    let mut devices = Vec::new();
    for entry in entries.flatten() {
        let card = entry.file_name().to_string_lossy().into_owned();
        if !card.starts_with("card") || !card[4..].chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let path = entry.path().join("device");
        let Ok(path) = fs::canonicalize(&path) else {
            continue;
        };
        let Ok(vendor) = fs::read_to_string(path.join("vendor")) else {
            continue;
        };
        let Some(pci_address) = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        devices.push(DrmDevice {
            path,
            pci_address,
            vendor: vendor.trim().to_lowercase(),
        });
    }
    devices.sort_by_key(|device| if device.vendor == "0x10de" { 0 } else { 1 });
    devices
}

fn drm_gpu_name(device: &DrmDevice) -> Option<String> {
    match run_command(
        "lspci",
        &["-D", "-nn", "-s", &device.pci_address],
        COMMAND_TIMEOUT,
    ) {
        Ok(output) => output.lines().next().and_then(|line| {
            line.split_once("]: ")
                .map(|(_, name)| name.trim().to_owned())
        }),
        Err(_) => {
            let vendor = fs::read_to_string(device.path.join("vendor")).ok()?;
            let model = fs::read_to_string(device.path.join("device")).ok()?;
            Some(format!("GPU PCI {}:{}", vendor.trim(), model.trim()))
        }
    }
}

fn primary_gpu() -> &'static (Option<DrmDevice>, Option<String>) {
    static PRIMARY_GPU: OnceLock<(Option<DrmDevice>, Option<String>)> = OnceLock::new();
    PRIMARY_GPU.get_or_init(|| {
        let device = drm_devices().into_iter().next();
        let name = device.as_ref().and_then(drm_gpu_name);
        (device, name)
    })
}

fn read_gpu() -> GpuReading {
    let (selected, cached_name) = primary_gpu();
    let nvidia_device = selected.as_ref().filter(|device| device.vendor == "0x10de");
    let nvidia = if nvidia_device.is_some() {
        run_command(
            "nvidia-smi",
            &[
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            COMMAND_TIMEOUT,
        )
    } else {
        Err(CommandFailure::Missing)
    };
    if let Ok(output) = &nvidia {
        if let Some(row) = parse_nvidia_csv(output) {
            let unavailable = "Campo não reportado pelo nvidia-smi";
            return GpuReading {
                name: Some(row.name),
                device_path: nvidia_device.map(|device| device.path.clone()),
                usage: row
                    .usage_percent
                    .map(|value| MetricValue::available(value, "%"))
                    .unwrap_or_else(|| MetricValue::unavailable("%", unavailable)),
                vram_used: row
                    .memory_used_mib
                    .map(|value| MetricValue::available(mib_to_bytes(value), "bytes"))
                    .unwrap_or_else(|| MetricValue::unavailable("bytes", unavailable)),
                vram_total: row
                    .memory_total_mib
                    .map(|value| MetricValue::available(mib_to_bytes(value), "bytes"))
                    .unwrap_or_else(|| MetricValue::unavailable("bytes", unavailable)),
                temperature: row.temperature_celsius,
            };
        }
    }

    let name = cached_name.clone();
    let device_path = selected.as_ref().map(|device| device.path.clone());
    let driver_reason = match &nvidia {
        Err(error) if nvidia_device.is_some() => command_reason(error, "nvidia-smi"),
        Ok(_) => "Resposta do nvidia-smi inválida".into(),
        Err(_) => "Monitoramento de uso da GPU não exposto pelo driver".into(),
    };

    if let Some(device) = selected {
        let usage = read_number(device.path.join("gpu_busy_percent"))
            .filter(|value| *value <= 100.0)
            .map(|value| MetricValue::available(value, "%"))
            .unwrap_or_else(|| MetricValue::unavailable("%", driver_reason.clone()));
        let vram_used = read_number(device.path.join("mem_info_vram_used"))
            .map(|value| MetricValue::available(value, "bytes"))
            .unwrap_or_else(|| {
                MetricValue::unavailable("bytes", "VRAM usada não exposta pelo driver")
            });
        let vram_total = read_number(device.path.join("mem_info_vram_total"))
            .map(|value| MetricValue::available(value, "bytes"))
            .unwrap_or_else(|| {
                MetricValue::unavailable("bytes", "VRAM total não exposta pelo driver")
            });
        return GpuReading {
            name,
            device_path,
            usage,
            vram_used,
            vram_total,
            temperature: None,
        };
    }

    let no_gpu = "Nenhuma GPU DRM acessível";
    GpuReading {
        name: None,
        device_path: None,
        usage: MetricValue::unavailable(
            "%",
            if nvidia_device.is_some() {
                driver_reason
            } else {
                no_gpu.into()
            },
        ),
        vram_used: MetricValue::unavailable("bytes", no_gpu),
        vram_total: MetricValue::unavailable("bytes", no_gpu),
        temperature: None,
    }
}

fn read_number(path: impl AsRef<Path>) -> Option<f64> {
    fs::read_to_string(path)
        .ok()?
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn parse_memory_speed(contents: &str) -> Option<f64> {
    contents
        .split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
}

fn parse_millidegrees(contents: &str) -> Option<f64> {
    contents
        .trim()
        .parse::<f64>()
        .ok()
        .map(|value| value / 1000.0)
        .filter(|value| value.is_finite() && (-40.0..=150.0).contains(value))
}

fn read_memory_speed() -> MetricValue {
    let Ok(controllers) = fs::read_dir("/sys/devices/system/edac/mc") else {
        return MetricValue::unavailable(
            "MT/s",
            "Velocidade não exposta pelo EDAC; leitura SMBIOS exigiria outra fonte",
        );
    };
    let mut speeds = Vec::new();
    for controller in controllers.flatten() {
        let Ok(dimms) = fs::read_dir(controller.path()) else {
            continue;
        };
        for dimm in dimms
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("dimm"))
        {
            if let Ok(contents) = fs::read_to_string(dimm.path().join("dimm_speed")) {
                let Some(speed) = parse_memory_speed(&contents) else {
                    continue;
                };
                if speed > 0.0 {
                    speeds.push(speed);
                }
            }
        }
    }
    match speeds.first().copied() {
        Some(first) if speeds.iter().all(|speed| (speed - first).abs() < 1.0) => {
            MetricValue::available(first, "MT/s")
        }
        Some(_) => MetricValue::unavailable(
            "MT/s",
            "Módulos reportaram velocidades diferentes pelo EDAC",
        ),
        None => MetricValue::unavailable(
            "MT/s",
            "Velocidade não disponível em /sys/devices/system/edac/mc; sem fonte legível sem sudo",
        ),
    }
}

fn read_temperature_from_hwmon(names: &[&str], root: &Path) -> Option<f64> {
    let entries = fs::read_dir(root).ok()?;
    let mut labeled = Vec::<(String, f64)>::new();
    for entry in entries.flatten() {
        let Ok(name) = fs::read_to_string(entry.path().join("name")) else {
            continue;
        };
        let name = name.trim().to_lowercase();
        if !names.iter().any(|candidate| name.contains(candidate)) {
            continue;
        }
        let Ok(sensors) = fs::read_dir(entry.path()) else {
            continue;
        };
        for sensor in sensors.flatten() {
            let file = sensor.file_name().to_string_lossy().to_string();
            if !file.starts_with("temp") || !file.ends_with("_input") {
                continue;
            }
            let Ok(contents) = fs::read_to_string(sensor.path()) else {
                continue;
            };
            let Some(temperature) = parse_millidegrees(&contents) else {
                continue;
            };
            let label = fs::read_to_string(
                sensor
                    .path()
                    .with_file_name(file.replace("_input", "_label")),
            )
            .unwrap_or_default()
            .trim()
            .to_lowercase();
            labeled.push((label, temperature));
        }
    }
    labeled
        .iter()
        .find(|(label, _)| {
            label.contains("package") || label.contains("tdie") || label.contains("tctl")
        })
        .map(|(_, temperature)| *temperature)
        .or_else(|| {
            labeled
                .iter()
                .map(|(_, temperature)| *temperature)
                .reduce(f64::max)
        })
}

fn read_cpu_temperature() -> MetricValue {
    match read_temperature_from_hwmon(
        &["coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz"],
        Path::new("/sys/class/hwmon"),
    ) {
        Some(value) => MetricValue::available(value, "°C"),
        None => MetricValue::unavailable(
            "°C",
            "Sensor de temperatura da CPU não exposto ou sem permissão",
        ),
    }
}

fn read_gpu_temperature(
    device_path: &Option<PathBuf>,
    nvidia_temperature: Option<f64>,
) -> MetricValue {
    if let Some(temperature) = nvidia_temperature {
        return MetricValue::available(temperature, "°C");
    }
    if let Some(path) = device_path {
        if let Some(value) = read_temperature_from_hwmon(
            &["amdgpu", "i915", "xe", "nouveau", "nvidia"],
            &path.join("hwmon"),
        ) {
            return MetricValue::available(value, "°C");
        }
    }
    MetricValue::unavailable("°C", "Sensor de temperatura da GPU não exposto pelo driver")
}

fn read_platform_name() -> Option<String> {
    let contents = fs::read_to_string("/etc/os-release").ok()?;
    contents.lines().find_map(|line| {
        let value = line.strip_prefix("PRETTY_NAME=")?.trim_matches('"');
        (!value.is_empty()).then(|| value.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cpu_counters_and_computes_usage_between_two_samples() {
        let before =
            parse_cpu_counters("cpu 100 5 20 200 10 2 3 0 0 0\ncpu0 1 0 0 2 0 0 0 0 0 0").unwrap();
        let after = parse_cpu_counters("cpu 150 5 30 220 15 2 3 0 0 0").unwrap();
        assert!((cpu_usage_between(before, after).unwrap() - 70.588235).abs() < 0.001);
        assert!(parse_cpu_counters("invalid").is_none());
        assert!(cpu_usage_between(after, after).is_none());
    }

    #[test]
    fn parses_meminfo_as_bytes_and_uses_available_memory() {
        let (used, total) =
            parse_meminfo("MemTotal: 1024 kB\nMemFree: 100 kB\nMemAvailable: 256 kB").unwrap();
        assert_eq!(total, 1_048_576);
        assert_eq!(used, 786_432);
        assert!(parse_meminfo("MemTotal: 1 kB").is_none());
    }

    #[test]
    fn parses_nvidia_smi_values_independently_and_rejects_invalid_data() {
        let row = parse_nvidia_csv("NVIDIA GeForce RTX 2050, 42, 1024, 4096, 67\n").unwrap();
        assert_eq!(row.name, "NVIDIA GeForce RTX 2050");
        assert_eq!(row.usage_percent, Some(42.0));
        assert_eq!(row.memory_used_mib, Some(1024.0));
        assert_eq!(row.temperature_celsius, Some(67.0));
        assert_eq!(mib_to_bytes(4096.0), 4_294_967_296.0);
        let partial = parse_nvidia_csv("GPU, N/A, 100, N/A, N/A").unwrap();
        assert_eq!(partial.usage_percent, None);
        assert_eq!(partial.memory_used_mib, Some(100.0));
        assert!(parse_nvidia_csv("garbage").is_none());
    }

    #[test]
    fn detects_missing_commands_and_kills_commands_that_exceed_timeout() {
        assert!(matches!(
            run_command("jarvis-command-that-does-not-exist", &[], COMMAND_TIMEOUT),
            Err(CommandFailure::Missing)
        ));
        #[cfg(unix)]
        assert!(matches!(
            run_command("/bin/sleep", &["2"], Duration::from_millis(25)),
            Err(CommandFailure::TimedOut)
        ));
    }

    #[test]
    fn converts_sensor_units_and_keeps_missing_sensors_unavailable() {
        assert_eq!(parse_memory_speed("3200 MT/s\n"), Some(3200.0));
        assert_eq!(parse_memory_speed("unknown"), None);
        assert_eq!(parse_millidegrees("67500\n"), Some(67.5));
        assert_eq!(parse_millidegrees("not-a-temperature"), None);
        assert_eq!(parse_millidegrees("-273000"), None);
        assert_eq!(
            read_temperature_from_hwmon(&["coretemp"], Path::new("/jarvis-no-such-sensors")),
            None
        );
        let no_speed = MetricValue::unavailable("MT/s", "sensor ausente");
        assert_eq!(no_speed.value, None);
        assert_eq!(no_speed.unit, "MT/s");
    }

    #[test]
    fn reports_independent_real_local_metrics_across_repeated_collections() {
        let first = collect_snapshot();
        let second = collect_snapshot();
        println!(
            "métricas locais @{} ms: CPU={} ({:?}) | RAM={} / {} ({:?}) | GPU={:?}, uso={} VRAM={} / {} | temperaturas CPU={} GPU={} | RAM speed={}",
            first.timestamp_ms,
            first
                .cpu
                .usage_percent
                .value
                .map(|value| format!("{value:.1}%"))
                .unwrap_or_else(|| "N/D".into()),
            first.cpu.name,
            first
                .memory
                .used_bytes
                .value
                .map(|value| format!("{:.2} GiB", value / 1_073_741_824.0))
                .unwrap_or_else(|| "N/D".into()),
            first
                .memory
                .total_bytes
                .value
                .map(|value| format!("{:.2} GiB", value / 1_073_741_824.0))
                .unwrap_or_else(|| "N/D".into()),
            first
                .memory
                .used_percent
                .value
                .map(|value| format!("{value:.1}%"))
                .unwrap_or_else(|| "N/D".into()),
            first.gpu.name,
            first
                .gpu
                .usage_percent
                .value
                .map(|value| format!("{value:.1}%"))
                .unwrap_or_else(|| "N/D".into()),
            first
                .gpu
                .vram_used_bytes
                .value
                .map(|value| format!("{:.2} GiB", value / 1_073_741_824.0))
                .unwrap_or_else(|| "N/D".into()),
            first
                .gpu
                .vram_total_bytes
                .value
                .map(|value| format!("{:.2} GiB", value / 1_073_741_824.0))
                .unwrap_or_else(|| "N/D".into()),
            first
                .temperatures
                .cpu_celsius
                .value
                .map(|value| format!("{value:.1} °C"))
                .unwrap_or_else(|| "N/D".into()),
            first
                .temperatures
                .gpu_celsius
                .value
                .map(|value| format!("{value:.1} °C"))
                .unwrap_or_else(|| "N/D".into()),
            first
                .memory
                .speed_mt_s
                .value
                .map(|value| format!("{value:.0} MT/s"))
                .unwrap_or_else(|| "N/D".into()),
        );
        assert!(second.timestamp_ms >= first.timestamp_ms);
        assert_eq!(first.cpu.name.is_some(), second.cpu.name.is_some());
        assert_eq!(
            first.memory.total_bytes.value.is_some(),
            second.memory.total_bytes.value.is_some()
        );
        assert_eq!(first.cpu.usage_percent.unit, "%");
        assert_eq!(first.memory.total_bytes.unit, "bytes");
    }
}
