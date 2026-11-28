use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{ChildStdin, Command, Stdio},
    sync::Mutex,
};
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

pub const BACKGROUND_ARG: &str = "--wake-background";
const EVENT: &str = "wake-status";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    enabled: bool,
    close_to_tray: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Stage {
    #[default]
    Paused,
    Connecting,
    Waiting,
    Capturing,
    AwaitingRequest,
    Transcribing,
    Suspended,
    Error,
}

#[derive(Debug, Deserialize)]
struct WorkerEvent {
    stage: Stage,
    detail: Option<String>,
    text: Option<String>,
}

#[derive(Clone, Serialize)]
struct Transcript {
    id: u64,
    text: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    revision: u64,
    enabled: bool,
    close_to_tray: bool,
    autostart: bool,
    tray_available: bool,
    stage: Stage,
    detail: Option<String>,
    transcripts: Vec<Transcript>,
}

#[derive(Default)]
struct Session {
    snapshot: Snapshot,
    generation: u64,
    holds: usize,
    control: Option<ChildStdin>,
    shutting_down: bool,
}

#[derive(Default)]
pub struct WakeState(Mutex<Session>);

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("wake.json"))
        .map_err(|error| error.to_string())
}

fn read_settings(path: &Path) -> Result<Settings, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn save_settings(path: &Path, settings: Settings) -> Result<(), String> {
    let data = serde_json::to_vec(&settings).map_err(|error| error.to_string())?;
    write_file(path, &data)
}

fn write_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path.parent().expect("settings have a parent directory");
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    temp.write_all(content).map_err(|error| error.to_string())?;
    temp.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temp.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

fn autostart_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .config_dir()
        .map(|dir| {
            dir.join("autostart")
                .join(format!("{}.wake.desktop", app.config().identifier))
        })
        .map_err(|error| error.to_string())
}

fn desktop_entry(executable: &Path) -> Result<String, String> {
    let executable = executable
        .to_str()
        .filter(|path| !path.contains(['\r', '\n', '=']))
        .ok_or("O caminho do executável não é válido para a inicialização automática.")?;
    let mut quoted = String::new();
    for ch in executable.chars() {
        // The Exec argument and Desktop Entry string each apply one escape layer.
        if matches!(ch, '\\' | '"' | '$' | '`') {
            quoted.push_str("\\\\");
        }
        if ch == '\\' {
            quoted.push_str("\\\\");
        } else if ch == '%' {
            quoted.push_str("%%");
        } else {
            quoted.push(ch);
        }
    }
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=J - Escuta por Jota\nExec=\"{quoted}\" {BACKGROUND_ARG}\nTerminal=false\nStartupNotify=false\n"
    ))
}

fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let file = autostart_path(app)?;
    if enabled {
        let executable = match &app.env().appimage {
            Some(path) => PathBuf::from(path),
            None => std::env::current_exe().map_err(|error| error.to_string())?,
        };
        // Linux appends this marker if a package update replaced the running inode.
        let executable = if executable.is_file() {
            executable
        } else {
            executable.to_str()
                .and_then(|path| path.strip_suffix(" (deleted)"))
                .map(PathBuf::from)
                .filter(|path| path.is_file())
                .ok_or("O executável não está mais no caminho de instalação. Reabra o J para ativar o início automático.")?
        };
        write_file(&file, desktop_entry(&executable)?.as_bytes())
    } else {
        match fs::remove_file(file) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

impl Session {
    fn publish(&mut self, app: &AppHandle) {
        self.snapshot.revision += 1;
        let _ = app.emit(EVENT, &self.snapshot);
    }

    fn set_stage(&mut self, stage: Stage, detail: Option<String>) {
        self.snapshot.stage = stage;
        self.snapshot.detail = detail;
    }

    fn stop(&mut self) {
        self.generation += 1;
        if let Some(mut input) = self.control.take() {
            let _ = input.write_all(b"quit\n");
        }
    }

    fn send(&mut self, command: &[u8]) {
        if let Some(input) = self.control.as_mut() {
            if input.write_all(command).is_err() {
                self.stop();
                self.set_stage(
                    Stage::Error,
                    Some("O detector parou. Use “Tentar de novo” para retomar.".into()),
                );
            }
        }
    }

    fn reconcile(&mut self, app: &AppHandle) {
        if self.shutting_down {
            return;
        }
        if !self.snapshot.enabled {
            self.stop();
            self.set_stage(Stage::Paused, None);
        } else if self.holds > 0 {
            self.set_stage(Stage::Suspended, None);
            self.send(b"hold\n");
        } else if self.control.is_none() {
            self.set_stage(Stage::Connecting, None);
            if let Err(error) = self.start(app) {
                self.set_stage(Stage::Error, Some(error));
            }
        }
        self.publish(app);
    }

    fn start(&mut self, app: &AppHandle) -> Result<(), String> {
        let voice_dir = crate::voice::voice_dir(app)?;
        let wake_dir = voice_dir.join("wake");
        let python = wake_dir.join("venv/bin/python");
        let model = wake_dir.join("vosk-model-small-pt-0.3");
        if !python.is_file() || !model.is_dir() {
            return Err(
                "Instale o Vosk e o modelo português na pasta de voz seguindo o README.".into(),
            );
        }
        let (whisper, whisper_model) = crate::voice::whisper_setup(&voice_dir)?;
        let mut child = Command::new(python)
            .args(["-u", "-c", include_str!("wake_worker.py")])
            .arg(model)
            .arg(whisper)
            .arg(whisper_model)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Não consegui iniciar o detector local: {error}"))?;
        let mut input = child.stdin.take().expect("worker stdin is piped");
        let output = child.stdout.take().expect("worker stdout is piped");
        let start_result = input.write_all(b"listen\n");
        self.generation += 1;
        let generation = self.generation;
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str(&line) {
                    receive(&app, generation, event);
                }
            }
            let _ = child.wait();
            let state = app.state::<WakeState>();
            let mut session = state.0.lock().unwrap();
            if session.generation == generation {
                session.control = None;
                if session.snapshot.stage != Stage::Error {
                    session.set_stage(
                        Stage::Error,
                        Some("O detector parou. Use “Tentar de novo” para retomar.".into()),
                    );
                }
                session.publish(&app);
            }
        });
        start_result.map_err(|error| format!("Não consegui comunicar com o detector: {error}"))?;
        self.control = Some(input);
        Ok(())
    }
}

fn receive(app: &AppHandle, generation: u64, event: WorkerEvent) {
    let state = app.state::<WakeState>();
    let mut session = state.0.lock().unwrap();
    if session.generation != generation || session.holds != 0 || !session.snapshot.enabled {
        return;
    }
    // A hold acknowledgment can arrive just after the last playback releases the mic.
    if event.stage == Stage::Suspended {
        return;
    }
    let show = event.stage == Stage::Capturing && session.snapshot.stage != Stage::AwaitingRequest;
    session.set_stage(event.stage, event.detail);
    if let Some(text) = event.text.filter(|text| !text.trim().is_empty()) {
        let id = session.snapshot.revision + 1;
        if session.snapshot.transcripts.len() == 32 {
            session.snapshot.transcripts.remove(0);
        }
        session.snapshot.transcripts.push(Transcript { id, text });
    }
    session.publish(app);
    drop(session);
    if show {
        show_window(app);
    }
}

pub fn show_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    });
}

pub struct AudioHold(AppHandle);

pub fn hold_audio(app: &AppHandle) -> AudioHold {
    let state = app.state::<WakeState>();
    let mut session = state.0.lock().unwrap();
    session.holds += 1;
    if session.holds == 1 && session.snapshot.enabled {
        session.reconcile(app);
    }
    AudioHold(app.clone())
}

impl Drop for AudioHold {
    fn drop(&mut self) {
        let app = &self.0;
        let state = app.state::<WakeState>();
        let mut session = state.0.lock().unwrap();
        session.holds -= 1;
        if session.holds != 0 || !session.snapshot.enabled || session.shutting_down {
            return;
        }
        if session.control.is_some() {
            session.set_stage(Stage::Connecting, None);
            // The worker discards audio during playback and waits for speaker echo to decay.
            session.send(b"listen\n");
        }
        session.reconcile(app);
    }
}

pub fn close_to_tray(app: &AppHandle) -> bool {
    let state = app.state::<WakeState>();
    let session = state.0.lock().unwrap();
    session.snapshot.close_to_tray && session.snapshot.tray_available && !session.shutting_down
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<WakeState>();
    let mut session = state.0.lock().unwrap();
    session.shutting_down = true;
    session.stop();
}

fn tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "wake-open", "Abrir J", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        "wake-toggle",
        "Pausar ou retomar escuta",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "wake-quit", "Encerrar J", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &quit])?;
    let mut builder = TrayIconBuilder::with_id("jota-listener")
        .tooltip("J")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "wake-open" => show_window(app),
            "wake-toggle" => {
                let enabled = !wake_status(app.clone()).enabled;
                if update_settings(app, Some(enabled), None).is_err() {
                    show_window(app);
                }
            }
            "wake-quit" => {
                shutdown(app);
                app.state::<crate::voice::VoiceState>().shutdown();
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn setup(app: &AppHandle) {
    let tray_available = tray(app).is_ok();
    let autostart = autostart_path(app).is_ok_and(|file| file.is_file());
    let settings = settings_path(app).and_then(|path| read_settings(&path));
    {
        let state = app.state::<WakeState>();
        let mut session = state.0.lock().unwrap();
        session.snapshot.tray_available = tray_available;
        session.snapshot.autostart = autostart;
        match settings {
            Ok(settings) => {
                session.snapshot.enabled = settings.enabled;
                session.snapshot.close_to_tray = settings.close_to_tray;
                session.reconcile(app);
            }
            Err(error) => {
                session.set_stage(
                    Stage::Error,
                    Some(format!("Não consegui ler as opções de escuta: {error}")),
                );
                session.publish(app);
            }
        }
    }
    if !tray_available || !std::env::args_os().any(|arg| arg == BACKGROUND_ARG) {
        show_window(app);
    }
}

#[tauri::command]
pub fn wake_status(app: AppHandle) -> Snapshot {
    let state = app.state::<WakeState>();
    state.0.lock().unwrap().snapshot.clone()
}

fn update_settings(
    app: &AppHandle,
    enabled: Option<bool>,
    close_to_tray: Option<bool>,
) -> Result<Snapshot, String> {
    let state = app.state::<WakeState>();
    let mut session = state.0.lock().unwrap();
    let settings = Settings {
        enabled: enabled.unwrap_or(session.snapshot.enabled),
        close_to_tray: close_to_tray.unwrap_or(session.snapshot.close_to_tray),
    };
    save_settings(&settings_path(app)?, settings)
        .map_err(|error| format!("Não consegui salvar as opções de escuta: {error}"))?;
    session.snapshot.enabled = settings.enabled;
    session.snapshot.close_to_tray = settings.close_to_tray;
    session.reconcile(app);
    Ok(session.snapshot.clone())
}

#[tauri::command]
pub fn wake_configure(
    app: AppHandle,
    enabled: Option<bool>,
    close_to_tray: Option<bool>,
) -> Result<Snapshot, String> {
    update_settings(&app, enabled, close_to_tray)
}

#[tauri::command]
pub fn wake_autostart(app: AppHandle, enabled: bool) -> Result<Snapshot, String> {
    set_autostart(&app, enabled)
        .map_err(|error| format!("Não consegui alterar a inicialização após o login: {error}"))?;
    let state = app.state::<WakeState>();
    let mut session = state.0.lock().unwrap();
    session.snapshot.autostart = enabled;
    session.publish(&app);
    Ok(session.snapshot.clone())
}

#[tauri::command]
pub fn wake_acknowledge(app: AppHandle, id: u64) {
    let state = app.state::<WakeState>();
    let mut session = state.0.lock().unwrap();
    let pending = session.snapshot.transcripts.len();
    session
        .snapshot
        .transcripts
        .retain(|transcript| transcript.id > id);
    if session.snapshot.transcripts.len() != pending {
        session.publish(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn autostart_entry_quotes_the_executable_and_starts_hidden() {
        let entry = desktop_entry(Path::new("/tmp/J versão 100%.AppImage")).unwrap();
        assert!(entry.contains("Exec=\"/tmp/J versão 100%%.AppImage\" --wake-background"));
        assert!(desktop_entry(Path::new("/tmp/J\nTerminal=true")).is_err());
    }

    #[test]
    fn settings_default_to_paused_and_persist_independent_choices() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("app/wake.json");
        assert_eq!(read_settings(&file).unwrap(), Settings::default());
        let settings = Settings {
            enabled: true,
            close_to_tray: true,
        };
        save_settings(&file, settings).unwrap();
        assert_eq!(read_settings(&file).unwrap(), settings);
        save_settings(
            &file,
            Settings {
                enabled: false,
                ..settings
            },
        )
        .unwrap();
        assert!(!read_settings(&file).unwrap().enabled);
        assert!(read_settings(&file).unwrap().close_to_tray);
    }
}
