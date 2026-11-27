use std::{
    ffi::{OsStr, OsString},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, ipc::Channel};

const RATE: u32 = 16_000;
const RECORD_SECONDS: u32 = 60;
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const CANCELLED: &str = "Operação de voz interrompida.";

#[derive(Default)]
pub struct VoiceState {
    next: AtomicU32,
    active: Mutex<Option<Arc<Job>>>,
}

struct Job {
    id: u32,
    started: AtomicBool,
    stop_capture: AtomicBool,
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl Job {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().expect("voice child lock").as_mut() {
            let _ = child.kill();
        }
    }

    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        Ok(())
    }

    fn spawn(&self, command: &mut Command, tool: &str) -> Result<(), String> {
        let mut child = self.child.lock().expect("voice child lock");
        self.check_cancelled()?;
        *child = Some(
            command
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| match error.kind() {
                    io::ErrorKind::NotFound => {
                        format!("{tool} não encontrado. Consulte a instalação de voz no README.")
                    }
                    _ => format!("Não foi possível iniciar {tool}: {error}"),
                })?,
        );
        Ok(())
    }

    fn wait(&self, timeout: Duration, failure: &str, capture: bool) -> Result<(), String> {
        let started = Instant::now();
        loop {
            self.check_cancelled()?;
            {
                let mut guard = self.child.lock().expect("voice child lock");
                let child = guard.as_mut().expect("voice process was started");
                if let Some(status) = child.try_wait().map_err(|_| failure.to_owned())? {
                    *guard = None;
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(failure.to_owned())
                    };
                }
                let timed_out = started.elapsed() >= timeout;
                if timed_out || (capture && self.stop_capture.load(Ordering::SeqCst)) {
                    let _ = child.kill();
                    child.wait().map_err(|_| failure.to_owned())?;
                    *guard = None;
                    return if capture {
                        Ok(())
                    } else {
                        Err(format!("{failure} Tempo limite atingido."))
                    };
                }
            }
            thread::sleep(POLL_INTERVAL);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl VoiceState {
    fn start(&self, id: u32) -> Result<Arc<Job>, String> {
        let active = self.active.lock().expect("voice state lock");
        let job = active
            .as_ref()
            .filter(|job| job.id == id)
            .ok_or(CANCELLED)?;
        if job.started.swap(true, Ordering::SeqCst) {
            return Err("Operação de voz já iniciada.".into());
        }
        Ok(job.clone())
    }

    fn release(&self, id: u32) {
        let mut active = self.active.lock().expect("voice state lock");
        if active.as_ref().is_some_and(|job| job.id == id) {
            active.take();
        }
    }

    pub fn shutdown(&self) {
        if let Some(job) = self.active.lock().expect("voice state lock").take() {
            job.cancel();
        }
    }
}

#[tauri::command]
pub fn voice_reserve(state: State<'_, VoiceState>) -> Result<u32, String> {
    let mut active = state.active.lock().expect("voice state lock");
    if active.is_some() {
        return Err("Já existe uma operação de voz em andamento.".into());
    }
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    *active = Some(Arc::new(Job {
        id,
        started: AtomicBool::new(false),
        stop_capture: AtomicBool::new(false),
        cancelled: AtomicBool::new(false),
        child: Mutex::new(None),
    }));
    Ok(id)
}

#[tauri::command]
pub fn voice_control(state: State<'_, VoiceState>, id: u32, cancel: bool) {
    let mut active = state.active.lock().expect("voice state lock");
    let Some(job) = active.as_ref().filter(|job| job.id == id) else {
        return;
    };
    if cancel {
        job.cancel();
        if !job.started.load(Ordering::SeqCst) {
            active.take();
        }
    } else {
        job.stop_capture.store(true, Ordering::SeqCst);
    }
}

fn voice_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("AURION_VOICE_DIR") {
        return Ok(PathBuf::from(dir));
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("voice"))
        .map_err(|error| format!("Pasta de voz indisponível: {error}"))
}

fn local_tool(dir: &Path, relative: &str, fallback: &str) -> OsString {
    let path = dir.join(relative);
    if path.is_file() {
        path.into_os_string()
    } else {
        fallback.into()
    }
}

fn model_file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let path = dir.join(name);
    if !path
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    {
        return Err(format!(
            "Arquivo de voz ausente ou vazio: {}. Consulte o README.",
            path.display()
        ));
    }
    Ok(path)
}

fn write_wav(pcm: &[u8], mut wav: impl Write) -> io::Result<()> {
    let length = pcm.len() as u32;
    wav.write_all(b"RIFF")?;
    wav.write_all(&(36 + length).to_le_bytes())?;
    wav.write_all(b"WAVEfmt ")?;
    wav.write_all(&16u32.to_le_bytes())?;
    wav.write_all(&1u16.to_le_bytes())?; // PCM
    wav.write_all(&1u16.to_le_bytes())?; // mono
    wav.write_all(&RATE.to_le_bytes())?;
    wav.write_all(&(RATE * 2).to_le_bytes())?;
    wav.write_all(&2u16.to_le_bytes())?;
    wav.write_all(&16u16.to_le_bytes())?;
    wav.write_all(b"data")?;
    wav.write_all(&length.to_le_bytes())?;
    wav.write_all(pcm)
}

fn capture(
    job: &Job,
    dir: &Path,
    recorder: &OsStr,
    mut stage: impl FnMut(&'static str),
) -> Result<String, String> {
    let model = model_file(dir, "ggml-base.bin")?;
    let whisper = local_tool(dir, "whisper/bin/whisper-cli", "whisper-cli");
    if whisper == "whisper-cli"
        && !std::env::var_os("PATH").is_some_and(|paths| {
            std::env::split_paths(&paths).any(|path| path.join(&whisper).is_file())
        })
    {
        return Err("whisper-cli não encontrado. Consulte a instalação de voz no README.".into());
    }
    let temp =
        tempfile::tempdir().map_err(|_| "Não foi possível preparar a gravação temporária.")?;
    let pcm_path = temp.path().join("capture.pcm");
    let pcm_file = File::create(&pcm_path)
        .map_err(|_| "Não foi possível abrir o arquivo temporário de gravação.")?;
    let mut recorder = Command::new(recorder);
    recorder
        .args([
            "--raw",
            "--rate",
            "16000",
            "--channels",
            "1",
            "--format",
            "s16",
            "--sample-count",
        ])
        .arg((RATE * RECORD_SECONDS).to_string())
        .arg("-")
        .stdout(pcm_file);
    job.spawn(&mut recorder, "pw-record")?;
    let microphone_error = "Falha na gravação. Confira o microfone e a entrada padrão do PipeWire.";
    stage("recording");
    job.wait(
        Duration::from_secs(RECORD_SECONDS.into()),
        microphone_error,
        true,
    )?;
    job.check_cancelled()?;

    let mut pcm = Vec::new();
    File::open(pcm_path)
        .and_then(|file| {
            file.take(u64::from(RATE * 2 * RECORD_SECONDS))
                .read_to_end(&mut pcm)
        })
        .map_err(|_| "Não foi possível ler a gravação temporária.")?;
    pcm.truncate(pcm.len() & !1);
    if pcm.len() < (RATE / 4) as usize || pcm.iter().all(|byte| *byte == 0) {
        return Err("Nenhum áudio útil foi capturado. Confira se o microfone está ativo e tente falar por mais tempo.".into());
    }

    stage("transcribing");
    let audio = temp.path().join("capture.wav");
    File::create(&audio)
        .and_then(|file| write_wav(&pcm, file))
        .map_err(|_| "Não foi possível preparar o áudio para o Whisper.")?;
    let output = temp.path().join("transcript");
    let mut command = Command::new(whisper);
    command
        .arg("-m")
        .arg(model)
        .arg("-f")
        .arg(audio)
        .args(["-l", "pt", "-nt", "-otxt", "--no-gpu", "-of"])
        .arg(&output)
        .stdout(Stdio::null());
    job.spawn(&mut command, "whisper-cli")?;
    job.wait(
        Duration::from_secs(180),
        "O Whisper não conseguiu transcrever. Confira o modelo multilíngue ggml-base.bin.",
        false,
    )?;
    let text = fs::read_to_string(output.with_extension("txt"))
        .map_err(|_| "O Whisper terminou sem criar um arquivo de transcrição.")?;
    let text = text.trim();
    if text.is_empty() {
        return Err(
            "O Whisper não reconheceu fala. Confira o volume do microfone e tente novamente."
                .into(),
        );
    }
    Ok(text.to_owned())
}

fn speak(
    job: &Job,
    dir: &Path,
    player: &OsStr,
    text: &str,
    mut stage: impl FnMut(&'static str),
) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > 64 * 1024 {
        return Err("O Piper precisa de texto não vazio de até 64 KiB para leitura.".into());
    }
    let model = model_file(dir, "pt_BR-faber-medium.onnx")?;
    let config = model_file(dir, "pt_BR-faber-medium.onnx.json")?;
    let temp =
        tempfile::tempdir().map_err(|_| "Não foi possível preparar a leitura em voz alta.")?;
    let input = temp.path().join("speech.txt");
    let audio = temp.path().join("speech.wav");
    fs::write(&input, text).map_err(|_| "Não foi possível preparar o texto para o Piper.")?;
    let mut command = Command::new(local_tool(dir, "venv/bin/piper", "piper"));
    command
        .arg("--model")
        .arg(model)
        .arg("--config")
        .arg(config)
        .arg("--input-file")
        .arg(input)
        .arg("--output-file")
        .arg(&audio)
        .stdout(Stdio::null());
    stage("synthesizing");
    job.spawn(&mut command, "piper (pacote piper-tts)")?;
    job.wait(
        Duration::from_secs(180),
        "O Piper não conseguiu gerar áudio. Confira a voz pt-BR e o arquivo .onnx.json.",
        false,
    )?;
    let mut playback = Command::new(player);
    playback.arg(audio).stdout(Stdio::null());
    job.spawn(&mut playback, "pw-play")?;
    stage("playing");
    job.wait(
        Duration::from_secs(900),
        "Não foi possível reproduzir o áudio. Confira a saída padrão do PipeWire.",
        false,
    )
}

#[tauri::command]
pub async fn voice_capture(
    app: AppHandle,
    state: State<'_, VoiceState>,
    id: u32,
    on_stage: Channel<String>,
) -> Result<String, String> {
    let dir = voice_dir(&app);
    let job = state.start(id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        capture(&job, &dir?, OsStr::new("pw-record"), |stage| {
            let _ = on_stage.send(stage.into());
        })
    })
    .await;
    state.release(id);
    result.map_err(|_| "A tarefa de transcrição foi interrompida.")?
}

#[tauri::command]
pub async fn voice_speak(
    app: AppHandle,
    state: State<'_, VoiceState>,
    id: u32,
    text: String,
    on_stage: Channel<String>,
) -> Result<(), String> {
    let dir = voice_dir(&app);
    let job = state.start(id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        speak(&job, &dir?, OsStr::new("pw-play"), &text, |stage| {
            let _ = on_stage.send(stage.into());
        })
    })
    .await;
    state.release(id);
    result.map_err(|_| "A tarefa de reprodução foi interrompida.")?
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn job() -> Job {
        Job {
            id: 0,
            started: AtomicBool::new(true),
            stop_capture: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            child: Mutex::new(None),
        }
    }

    fn executable(dir: &Path, path: &str, script: &str) -> PathBuf {
        let path = dir.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("#!/bin/sh\nset -eu\n{script}")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[test]
    fn pcm_is_wrapped_in_a_mono_16khz_wav() {
        let mut wav = Vec::new();
        write_wav(&[1, 2, 3, 4], &mut wav).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16000);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(&wav[36..44], b"data\x04\0\0\0");
        assert_eq!(&wav[44..], &[1, 2, 3, 4]);
    }

    #[test]
    fn reports_missing_models_without_starting_audio_devices() {
        let dir = tempfile::tempdir().unwrap();
        let mut stages = Vec::new();
        let input = capture(&job(), dir.path(), OsStr::new("unused"), |s| stages.push(s));
        assert!(input.unwrap_err().contains("ggml-base.bin"));
        let output = speak(&job(), dir.path(), OsStr::new("unused"), "Olá", |s| {
            stages.push(s)
        });
        assert!(output.unwrap_err().contains("pt_BR-faber-medium.onnx"));
        assert!(stages.is_empty());
    }

    #[test]
    fn captures_and_transcribes_with_simulated_commands() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("ggml-base.bin"), "fake").unwrap();
        let recorder = executable(dir.path(), "record", "yes PCM | head -c 6400");
        executable(
            dir.path(),
            "whisper/bin/whisper-cli",
            r#"
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    -l) shift; test "$1" = pt ;;
                    -f) shift; test "$(head -c 4 "$1")" = RIFF ;;
                    -of) shift; printf ' Olá, Aurion! \n' > "$1.txt" ;;
                esac
                shift
            done
        "#,
        );
        let mut stages = Vec::new();
        let transcript =
            capture(&job(), dir.path(), recorder.as_os_str(), |s| stages.push(s)).unwrap();
        assert_eq!(transcript, "Olá, Aurion!");
        assert_eq!(stages, ["recording", "transcribing"]);

        let silent = executable(dir.path(), "silence", "head -c 6400 /dev/zero");
        assert!(
            capture(&job(), dir.path(), silent.as_os_str(), |_| {})
                .unwrap_err()
                .contains("Nenhum áudio útil")
        );
    }

    #[test]
    fn synthesizes_and_interrupts_simulated_playback() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("pt_BR-faber-medium.onnx"), "fake").unwrap();
        fs::write(dir.path().join("pt_BR-faber-medium.onnx.json"), "{}").unwrap();
        executable(
            dir.path(),
            "venv/bin/piper",
            r#"
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    --input-file) shift; test "$(cat "$1")" = "Olá de novo." ;;
                    --output-file) shift; printf 'RIFF' > "$1" ;;
                esac
                shift
            done
        "#,
        );
        let player = executable(
            dir.path(),
            "play",
            r#"test "$(cat "$1")" = RIFF; exec sleep 20"#,
        );
        let job = job();
        let mut stages = Vec::new();
        let result = speak(
            &job,
            dir.path(),
            player.as_os_str(),
            "Olá de novo.",
            |stage| {
                stages.push(stage);
                if stage == "playing" {
                    job.cancel();
                }
            },
        );
        assert_eq!(stages, ["synthesizing", "playing"]);
        assert_eq!(result.unwrap_err(), CANCELLED);
    }
}
