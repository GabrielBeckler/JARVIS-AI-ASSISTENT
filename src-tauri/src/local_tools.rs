use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant},
};

const MAX_RESULTS: usize = 30;
const MAX_LISTING: usize = 100;
const MAX_VISITED: usize = 30_000;
const MAX_DEPTH: usize = 14;
const SEARCH_BUDGET: Duration = Duration::from_secs(4);
const MAX_READ_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalAction {
    Search,
    ListDirectory,
    ReadFile,
    OpenProject,
    InspectPath,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalToolRequest {
    pub action: LocalAction,
    pub file_name: Option<String>,
    pub project_name: Option<String>,
    pub search_root: Option<String>,
    pub selected_path: Option<String>,
    pub downloads: Option<bool>,
    pub file_filter: Option<DownloadFilter>,
    pub recursive: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadFilter { All, Images, Pdf }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    path: String,
    kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct LocalToolResult {
    action: String,
    status: String,
    message: String,
    results: Vec<LocalEntry>,
    path: Option<String>,
    content: Option<String>,
    truncated: bool,
}

impl LocalToolResult {
    fn new(action: &str, status: &str, message: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            status: status.into(),
            message: message.into(),
            results: vec![],
            path: None,
            content: None,
            truncated: false,
        }
    }
}

fn display_path(path: &Path) -> String { path.to_string_lossy().into_owned() }
fn entry(path: &Path, kind: &'static str) -> LocalEntry { LocalEntry { path: display_path(path), kind } }
fn action_name(action: LocalAction) -> &'static str {
    match action {
        LocalAction::Search => "search",
        LocalAction::ListDirectory => "list_directory",
        LocalAction::ReadFile => "read_file",
        LocalAction::OpenProject => "open_project",
        LocalAction::InspectPath => "inspect_path",
    }
}

fn normalized(value: &str) -> String {
    value.chars().flat_map(|c| match c {
        'á'|'à'|'â'|'ã'|'ä'|'Á'|'À'|'Â'|'Ã'|'Ä' => "a".chars().collect::<Vec<_>>(),
        'é'|'è'|'ê'|'ë'|'É'|'È'|'Ê'|'Ë' => "e".chars().collect(),
        'í'|'ì'|'î'|'ï'|'Í'|'Ì'|'Î'|'Ï' => "i".chars().collect(),
        'ó'|'ò'|'ô'|'õ'|'ö'|'Ó'|'Ò'|'Ô'|'Õ'|'Ö' => "o".chars().collect(),
        'ú'|'ù'|'û'|'ü'|'Ú'|'Ù'|'Û'|'Ü' => "u".chars().collect(),
        'ç'|'Ç' => "c".chars().collect(),
        _ => c.to_lowercase().collect(),
    }).collect()
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "Não foi possível identificar a pasta pessoal (HOME).".into())
}

fn configured_downloads_dir(home: &Path, config_home: Option<&Path>) -> PathBuf {
    let config_home = config_home.filter(|path| path.is_absolute()).map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"));
    if let Ok(contents) = fs::read_to_string(config_home.join("user-dirs.dirs")) {
        for line in contents.lines() {
            let Some((key, raw)) = line.split_once('=') else { continue };
            if key.trim() != "XDG_DOWNLOAD_DIR" { continue }
            let value = raw.trim().trim_matches('"').replace("${HOME}", &display_path(home)).replace("$HOME", &display_path(home));
            let path = PathBuf::from(value);
            if path.is_absolute() { return path; }
        }
    }
    home.join("Downloads")
}

fn downloads_dir() -> Result<PathBuf, String> {
    let home = home_dir()?;
    let config_home = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    Ok(configured_downloads_dir(&home, config_home.as_deref()))
}

fn explicit_path(text: &str) -> Result<Option<PathBuf>, String> {
    let text = text.trim();
    if text.starts_with('/') { return Ok(Some(PathBuf::from(text))); }
    if text == "~" { return Ok(Some(home_dir()?)); }
    if let Some(rest) = text.strip_prefix("~/") { return Ok(Some(home_dir()?.join(rest))); }
    Ok(None)
}

fn excluded_directory(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".git"
            | ".hg"
            | ".svn"
            | ".cache"
            | "__pycache__"
            | ".venv"
    )
}

fn walk_ranked(
    root: &Path,
    needle: &str,
    desired: Option<&str>,
    stop_after_root: Option<u8>,
    rank: impl Fn(&Path, bool) -> u8,
) -> (Vec<LocalEntry>, bool, bool) {
    let start = Instant::now();
    let needle = normalized(needle.trim());
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = HashSet::new();
    let mut results = Vec::new();
    let mut denied = false;
    let mut limited = false;
    let mut best_rank = None;
    let mut omitted_matches = false;
    while let Some((directory, depth)) = queue.pop_front() {
        if depth > 0 && stop_after_root.is_some() && best_rank == stop_after_root {
            break;
        }
        if start.elapsed() > SEARCH_BUDGET || visited.len() >= MAX_VISITED {
            limited = true;
            break;
        }
        let canonical = match fs::canonicalize(&directory) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                denied = true;
                continue;
            }
            Err(_) => continue,
        };
        if !visited.insert(canonical) {
            continue;
        }
        let children = match fs::read_dir(&directory) {
            Ok(items) => items,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                denied = true;
                continue;
            }
            Err(_) => continue,
        };
        for item in children {
            if start.elapsed() > SEARCH_BUDGET {
                limited = true;
                break;
            }
            let item = match item {
                Ok(item) => item,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    denied = true;
                    continue;
                }
                Err(_) => continue,
            };
            let path = item.path();
            let kind = match item.file_type() {
                Ok(kind) => kind,
                Err(_) => continue,
            };
            let is_dir = kind.is_dir();
            if !is_dir && !kind.is_file() {
                continue;
            }
            let Some(name) = path
                .file_name()
                .and_then(|name| name.to_str())
                .map(normalized)
            else {
                continue;
            };
            if is_dir && excluded_directory(&name) && name != needle {
                continue;
            }
            let label = if is_dir { "directory" } else { "file" };
            if !needle.is_empty()
                && name.contains(&needle)
                && desired.is_none_or(|wanted| wanted == label)
            {
                let score = rank(&path, name == needle);
                if best_rank.is_none_or(|best| score > best) {
                    results.clear();
                    omitted_matches = false;
                    best_rank = Some(score);
                }
                if best_rank == Some(score) {
                    if results.len() < MAX_RESULTS {
                        results.push(entry(&path, label));
                    } else {
                        omitted_matches = true;
                    }
                }
            }
            if is_dir && depth < MAX_DEPTH {
                if visited.len() + queue.len() < MAX_VISITED {
                    queue.push_back((path, depth + 1));
                } else {
                    limited = true;
                }
            }
        }
    }
    results.sort_by(|left, right| left.path.cmp(&right.path));
    (results, limited || omitted_matches, denied)
}

fn walk(root: &Path, needle: &str, desired: Option<&str>) -> (Vec<LocalEntry>, bool, bool) {
    walk_ranked(root, needle, desired, None, |_, _| 0)
}

fn ranked_projects(root: &Path, name: &str, preferred: &Path) -> (Vec<LocalEntry>, bool, bool) {
    walk_ranked(root, name, Some("directory"), None, |path, exact| {
        let has_marker = [
            ".git",
            "package.json",
            "Cargo.toml",
            "pyproject.toml",
            "go.mod",
            "pom.xml",
            "composer.json",
            "Gemfile",
            "CMakeLists.txt",
        ]
        .iter()
        .any(|marker| path.join(marker).exists());
        u8::from(exact) * 4 + u8::from(has_marker) * 2 + u8::from(path.starts_with(preferred))
    })
}

fn scoped_files(root: &Path, name: &str, in_project: bool) -> (Vec<LocalEntry>, bool, bool) {
    walk_ranked(
        root,
        name,
        Some("file"),
        in_project.then_some(3),
        |path, exact| u8::from(exact) * 2 + u8::from(in_project && path.parent() == Some(root)),
    )
}
fn resolve_search_root(request: &LocalToolRequest) -> Result<PathBuf, String> {
    resolve_search_root_from(&home_dir()?, request.search_root.as_deref())
}

fn resolve_search_root_from(home: &Path, name: Option<&str>) -> Result<PathBuf, String> {
    let Some(name) = name.map(str::trim).filter(|s| !s.is_empty()) else { return Ok(home.to_path_buf()); };
    let expanded = if name == "~" { Some(home.to_path_buf()) } else if let Some(rest) = name.strip_prefix("~/") { Some(home.join(rest)) } else { explicit_path(name)? };
    if let Some(path) = expanded {
        if path.is_dir() { return Ok(path); }
        return Err(format!("A pasta de busca não existe ou não é uma pasta: {}", display_path(&path)));
    }
    let direct = home.join(name);
    if direct.is_dir() { return Ok(direct); }
    let (matches, _, _) = walk(home, name, Some("directory"));
    match matches.as_slice() {
        [single] => Ok(PathBuf::from(&single.path)),
        [] => Err(format!("Não encontrei a pasta de busca “{name}” em {}.", display_path(home))),
        _ => Err(format!("A pasta “{name}” aparece em mais de um local. Informe um caminho para a busca.")),
    }
}

fn selected_path(request: &LocalToolRequest) -> Result<Option<PathBuf>, String> {
    let Some(text) = request.selected_path.as_deref() else {
        return Ok(None);
    };
    let path = PathBuf::from(text);
    if !path.is_absolute() {
        return Err("Informe um caminho absoluto.".into());
    }
    fs::metadata(&path)
        .map_err(|error| format!("Não foi possível acessar {}: {error}", display_path(&path)))?;
    Ok(Some(path))
}

fn project_candidates(request: &LocalToolRequest, root: &Path) -> (Vec<LocalEntry>, bool, bool) {
    if let Some(project) = request
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Ok(Some(path)) = explicit_path(project) {
            return if path.is_dir() {
                (vec![entry(&path, "directory")], false, false)
            } else {
                (vec![], false, false)
            };
        }
        let preferred = home_dir().unwrap_or_default().join("Projetos");
        return ranked_projects(root, project, &preferred);
    }
    (vec![entry(root, "directory")], false, false)
}

fn ambiguous(action: &str, message: String, items: Vec<LocalEntry>) -> LocalToolResult {
    let mut result = LocalToolResult::new(action, "ambiguous", message);
    result.results = items;
    result
}

fn missing_after_search(
    action: &str,
    what: &str,
    root: &Path,
    limited: bool,
    denied: bool,
) -> LocalToolResult {
    let mut message = format!("Não encontrei {what} em {}.", display_path(root));
    if limited {
        message.push_str(" A busca atingiu o limite. Informe uma pasta mais específica.");
    }
    if denied {
        message.push_str(" O Fedora negou acesso a alguns locais.");
    }
    LocalToolResult::new(action, "not_found", message)
}

fn found_path(path: &Path) -> LocalToolResult {
    let kind = if path.is_dir() { "directory" } else { "file" };
    let mut result = LocalToolResult::new("search", "success", "Encontrei o caminho:");
    result.results.push(entry(path, kind));
    result
}

fn inspect_path(request: &LocalToolRequest) -> LocalToolResult {
    let (status, message) = match selected_path(request) {
        Ok(Some(path)) if path.is_file() => (
            "clarification",
            format!(
                "Encontrei o arquivo {}. Você quer que eu leia? Para confirmar, envie “Leia {}”.",
                display_path(&path),
                display_path(&path)
            ),
        ),
        Ok(Some(path)) if path.is_dir() => (
            "clarification",
            format!(
                "Encontrei a pasta {}. Você quer listar o conteúdo ou abri-la no VS Code? Envie o pedido com o caminho.",
                display_path(&path)
            ),
        ),
        Ok(_) => ("error", "Informe o caminho de um arquivo ou pasta.".into()),
        Err(error) => ("error", error),
    };
    LocalToolResult::new("inspect_path", status, message)
}

fn search(request: &LocalToolRequest) -> LocalToolResult {
    let root = match selected_path(request) {
        Ok(Some(path)) if path.is_file() || (path.is_dir() && request.file_name.is_none()) => {
            return found_path(&path);
        }
        Ok(Some(path)) if path.is_dir() => path,
        Ok(Some(path)) => {
            return LocalToolResult::new(
                "search",
                "error",
                format!(
                    "O caminho não é um arquivo comum nem uma pasta: {}",
                    display_path(&path)
                ),
            );
        }
        Ok(None) => match resolve_search_root(request) {
            Ok(path) => path,
            Err(error) => return LocalToolResult::new("search", "error", error),
        },
        Err(error) => return LocalToolResult::new("search", "error", error),
    };
    if let Some(project) = request.project_name.as_deref() {
        let project_path = if request.selected_path.is_some() {
            root
        } else {
            match find_single_project(request, &root, "search") {
                Ok(path) => path,
                Err(result) => return result,
            }
        };
        if let Some(file_name) = request.file_name.as_deref() {
            let (files, file_limited, file_denied) = scoped_files(&project_path, file_name, true);
            if files.is_empty() {
                return missing_after_search(
                    "search",
                    &format!("o arquivo “{file_name}”"),
                    &project_path,
                    file_limited,
                    file_denied,
                );
            }
            if files.len() > 1 {
                return ambiguous(
                    "search",
                    format!(
                        "Encontrei {} arquivos compatíveis com “{file_name}”. Escolha o arquivo:",
                        files.len()
                    ),
                    files,
                );
            }
            let mut result = LocalToolResult::new(
                "search",
                "success",
                format!(
                    "Encontrei {} arquivo(s) chamado(s) “{file_name}” em {}{}.",
                    files.len(),
                    display_path(&project_path),
                    if file_limited {
                        " (busca limitada)"
                    } else {
                        ""
                    }
                ),
            );
            result.results = files;
            if file_denied {
                result
                    .message
                    .push_str(" Alguns locais foram ignorados por permissão negada.");
            }
            return result;
        }
        let mut result = LocalToolResult::new(
            "search",
            "success",
            format!("Encontrei a pasta de projeto “{project}”."),
        );
        result.results.push(entry(&project_path, "directory"));
        return result;
    }
    let Some(file_name) = request
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return LocalToolResult::new(
            "search",
            "error",
            "Informe o nome do arquivo ou projeto que devo procurar.",
        );
    };
    let (files, limited, denied) = walk(&root, file_name, None);
    if files.is_empty() {
        return missing_after_search("search", &format!("“{file_name}”"), &root, limited, denied);
    }
    let mut result = LocalToolResult::new(
        "search",
        "success",
        format!(
            "Encontrei {} resultado(s) para “{file_name}”{}.",
            files.len(),
            if limited { " (busca limitada)" } else { "" }
        ),
    );
    result.results = files;
    result
}

fn list_directory_at(target: &Path) -> LocalToolResult {
    if !target.is_dir() { return LocalToolResult::new("list_directory", "error", format!("A pasta não existe ou não pode ser acessada: {}", display_path(target))); }
    let read = match fs::read_dir(target) { Ok(items) => items, Err(error) => return LocalToolResult::new("list_directory", "error", format!("Não foi possível listar {}: {error}", display_path(target))) };
    let mut items = Vec::new();
    let mut denied = false;
    for item in read.take(MAX_LISTING + 1) {
        let item = match item { Ok(item) => item, Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
        let kind = match item.file_type() { Ok(kind) => kind, Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
        if kind.is_symlink() { continue; }
        items.push(entry(&item.path(), if kind.is_dir() { "directory" } else { "file" }));
    }
    items.sort_by(|a, b| normalized(&a.path).cmp(&normalized(&b.path)));
    let truncated = items.len() > MAX_LISTING;
    items.truncate(MAX_LISTING);
    let mut result = LocalToolResult::new("list_directory", "success", format!("Conteúdo de {} ({} item(ns) mostrado(s)){}{}:", display_path(target), items.len(), if truncated { "; lista limitada a 100 itens" } else { "" }, if denied { "; alguns itens foram omitidos por permissão negada" } else { "" }));
    result.path = Some(display_path(target)); result.results = items; result.truncated = truncated; result
}

fn matches_download_filter(path: &Path, filter: DownloadFilter) -> bool {
    match filter {
        DownloadFilter::All => true,
        DownloadFilter::Images => path.extension().and_then(|value| value.to_str())
            .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "svg")),
        DownloadFilter::Pdf => path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("pdf")),
    }
}

fn path_readable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).map(|metadata| metadata.permissions().mode() & 0o444 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    { fs::metadata(path).is_ok() }
}

fn list_downloads_at(root: &Path, filter: DownloadFilter, recursive: bool) -> LocalToolResult {
    match fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return LocalToolResult::new("list_directory", "error", format!("O caminho configurado para Downloads não é uma pasta: {}", display_path(root))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return LocalToolResult::new("list_directory", "error", format!("A pasta Downloads não existe: {}", display_path(root))),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return LocalToolResult::new("list_directory", "error", format!("Não foi possível acessar a pasta Downloads {}: permissão negada.", display_path(root))),
        Err(error) => return LocalToolResult::new("list_directory", "error", format!("Não foi possível acessar a pasta Downloads {}: {error}", display_path(root))),
    }
    if !path_readable(root) {
        return LocalToolResult::new("list_directory", "error", format!("Não foi possível acessar a pasta Downloads {}: permissão negada.", display_path(root)));
    }
    let mut pending = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut items = Vec::new();
    let mut denied = false;
    let mut truncated = false;
    let mut visited = 0usize;
    while let Some((directory, depth)) = pending.pop_front() {
        if visited >= MAX_VISITED { truncated = true; break; }
        visited += 1;
        if !path_readable(&directory) { denied = true; continue; }
        let read = match fs::read_dir(&directory) {
            Ok(items) => items,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }
            Err(error) if depth == 0 => return LocalToolResult::new("list_directory", "error", format!("Não foi possível listar Downloads em {}: {error}", display_path(root))),
            Err(_) => continue,
        };
        for item in read {
            let item = match item { Ok(item) => item, Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
            let kind = match item.file_type() { Ok(kind) => kind, Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
            if kind.is_symlink() { continue; }
            let path = item.path();
            if kind.is_dir() {
                if filter == DownloadFilter::All {
                    items.push(entry(&path, "directory"));
                }
                if recursive && depth < MAX_DEPTH {
                    if pending.len() < MAX_VISITED { pending.push_back((path.clone(), depth + 1)); } else { truncated = true; }
                }
            } else if kind.is_file() && matches_download_filter(&path, filter) {
                items.push(entry(&path, "file"));
            }
            if items.len() > MAX_LISTING { truncated = true; break; }
        }
        if truncated { break; }
    }
    items.sort_by(|a, b| {
        let depth = |path: &str| Path::new(path).components().count();
        depth(&a.path).cmp(&depth(&b.path)).then_with(|| normalized(&a.path).cmp(&normalized(&b.path)))
    });
    items.truncate(MAX_LISTING);
    let filter_name = match filter { DownloadFilter::All => "arquivos", DownloadFilter::Images => "imagens", DownloadFilter::Pdf => "PDFs" };
    let scope = if recursive { "incluindo subpastas" } else { "somente na pasta" };
    let mut message = if items.is_empty() {
        format!("Não encontrei {filter_name} em {} ({scope}).", display_path(root))
    } else {
        format!("Conteúdo de {} ({}, {} item(ns) mostrado(s)){}:", display_path(root), scope, items.len(), if truncated { "; lista limitada a 100 itens" } else { "" })
    };
    if denied { message.push_str(" Alguns itens foram omitidos por permissão negada."); }
    let mut result = LocalToolResult::new("list_directory", "success", message);
    result.path = Some(display_path(root));
    result.results = items;
    result.truncated = truncated;
    result
}

fn list_downloads(request: &LocalToolRequest) -> LocalToolResult {
    let root = match downloads_dir() { Ok(path) => path, Err(error) => return LocalToolResult::new("list_directory", "error", error) };
    list_downloads_at(&root, request.file_filter.unwrap_or(DownloadFilter::All), request.recursive.unwrap_or(false))
}

fn read_file_at(path: &Path) -> LocalToolResult {
    let mut bytes = Vec::new();
    if let Err(error) = fs::File::open(path).and_then(|file| {
        file.take((MAX_READ_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
    }) {
        return LocalToolResult::new(
            "read_file",
            "error",
            format!("Não foi possível ler {}: {error}", display_path(path)),
        );
    }
    let count = bytes.len();
    let truncated = count > MAX_READ_BYTES;
    bytes.truncate(count.min(MAX_READ_BYTES));
    if bytes.contains(&0) {
        return LocalToolResult::new(
            "read_file",
            "error",
            format!(
                "{} parece ser um arquivo binário; não exibi o conteúdo.",
                display_path(path)
            ),
        );
    }
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(error) if truncated && error.utf8_error().error_len().is_none() => {
            let end = error.utf8_error().valid_up_to();
            let mut bytes = error.into_bytes();
            bytes.truncate(end);
            String::from_utf8(bytes).expect("prefixo UTF-8 validado")
        }
        Err(_) => {
            return LocalToolResult::new(
                "read_file",
                "error",
                format!("{} não contém texto UTF-8 válido.", display_path(path)),
            );
        }
    };
    let mut result = LocalToolResult::new(
        "read_file",
        "success",
        format!(
            "Li {} ({} bytes{}).",
            display_path(path),
            count.min(MAX_READ_BYTES),
            if truncated {
                "; trecho inicial limitado a 64 KiB"
            } else {
                ""
            }
        ),
    );
    result.path = Some(display_path(path));
    result.content = Some(content);
    result.truncated = truncated;
    result
}

fn find_single_project(
    request: &LocalToolRequest,
    root: &Path,
    action: &str,
) -> Result<PathBuf, LocalToolResult> {
    let (projects, limited, denied) = project_candidates(request, root);
    if projects.is_empty() {
        let name = request.project_name.as_deref().unwrap_or("projeto");
        return Err(missing_after_search(
            action,
            &format!("a pasta de projeto “{name}”"),
            root,
            limited,
            denied,
        ));
    }
    if projects.len() > 1 {
        return Err(ambiguous(
            action,
            format!(
                "Encontrei {} pastas de projeto compatíveis{}. Escolha uma:",
                projects.len(),
                if limited { " (busca limitada)" } else { "" }
            ),
            projects,
        ));
    }
    Ok(PathBuf::from(&projects[0].path))
}

fn list_directory(request: &LocalToolRequest) -> LocalToolResult {
    if request.downloads.unwrap_or(false) { return list_downloads(request); }
    let selected = match selected_path(request) { Ok(path) => path, Err(error) => return LocalToolResult::new("list_directory", "error", error) };
    let target = if let Some(path) = selected { path } else {
        let root = match resolve_search_root(request) { Ok(path) => path, Err(error) => return LocalToolResult::new("list_directory", "error", error) };
        if request.project_name.is_some() { match find_single_project(request, &root, "list_directory") { Ok(path) => path, Err(result) => return result } } else { root }
    };
    list_directory_at(&target)
}

fn read_file(request: &LocalToolRequest) -> LocalToolResult {
    let selected = match selected_path(request) {
        Ok(path) => path,
        Err(error) => return LocalToolResult::new("read_file", "error", error),
    };
    if let Some(path) = selected.as_ref().filter(|path| path.is_file()) {
        return read_file_at(path);
    }
    let root = if let Some(path) = selected {
        path
    } else {
        let search_root = match resolve_search_root(request) {
            Ok(path) => path,
            Err(error) => return LocalToolResult::new("read_file", "error", error),
        };
        if request.project_name.is_some() {
            match find_single_project(request, &search_root, "read_file") {
                Ok(path) => path,
                Err(result) => return result,
            }
        } else {
            search_root
        }
    };
    if !root.is_dir() {
        return LocalToolResult::new(
            "read_file",
            "error",
            format!(
                "O caminho selecionado não é um arquivo nem uma pasta: {}",
                display_path(&root)
            ),
        );
    }
    let Some(file_name) = request
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return LocalToolResult::new(
            "read_file",
            "error",
            "Informe o nome do arquivo que devo ler.",
        );
    };
    let (files, limited, denied) = scoped_files(&root, file_name, request.project_name.is_some());
    if files.is_empty() {
        return missing_after_search(
            "read_file",
            &format!("o arquivo “{file_name}”"),
            &root,
            limited,
            denied,
        );
    }
    if files.len() > 1 {
        return ambiguous(
            "read_file",
            format!(
                "Encontrei {} arquivos compatíveis{}. Escolha qual devo ler:",
                files.len(),
                if limited { " (busca limitada)" } else { "" }
            ),
            files,
        );
    }
    read_file_at(Path::new(&files[0].path))
}

fn open_project_at(path: &Path) -> LocalToolResult {
    if !path.is_dir() { return LocalToolResult::new("open_project", "error", format!("A pasta foi removida ou não pode ser acessada: {}", display_path(path))); }
    match launch_code(std::ffi::OsStr::new("code"), path) {
        Ok(_child) => { let mut result = LocalToolResult::new("open_project", "success", format!("Iniciei o VS Code para {}.", display_path(path))); result.path = Some(display_path(path)); result }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LocalToolResult::new("open_project", "error", "Não encontrei o comando `code`. Instale/ative o comando do VS Code no PATH e tente novamente."),
        Err(error) => LocalToolResult::new("open_project", "error", format!("Não foi possível iniciar o VS Code para {}: {error}", display_path(path))),
    }
}

fn open_project(request: &LocalToolRequest) -> LocalToolResult {
    let selected = match selected_path(request) { Ok(path) => path, Err(error) => return LocalToolResult::new("open_project", "error", error) };
    let project = if let Some(path) = selected { path } else {
        let root = match resolve_search_root(request) { Ok(path) => path, Err(error) => return LocalToolResult::new("open_project", "error", error) };
        match find_single_project(request, &root, "open_project") { Ok(path) => path, Err(result) => return result }
    };
    open_project_at(&project)
}

fn execute_inner(request: &LocalToolRequest) -> LocalToolResult {
    let action = action_name(request.action);
    for (label, value) in [
        ("nome do arquivo", request.file_name.as_deref()),
        ("nome do projeto", request.project_name.as_deref()),
        ("pasta de busca", request.search_root.as_deref()),
        ("caminho selecionado", request.selected_path.as_deref()),
    ] {
        if value.is_some_and(|value| value.len() > 240) {
            return LocalToolResult::new(
                action,
                "error",
                format!("O {label} informado é longo demais (limite: 240 caracteres)."),
            );
        }
    }
    match request.action {
        LocalAction::Search => search(request),
        LocalAction::ListDirectory => list_directory(request),
        LocalAction::ReadFile => read_file(request),
        LocalAction::OpenProject => open_project(request),
        LocalAction::InspectPath => inspect_path(request),
    }
}

pub fn execute(request: LocalToolRequest) -> LocalToolResult {
    execute_inner(&request)
}

fn launch_code(program: &std::ffi::OsStr, path: &Path) -> std::io::Result<Child> { Command::new(program).arg(path).spawn() }

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn request(action: LocalAction, file: Option<&str>, project: Option<&str>, root: Option<&Path>, selected: Option<&Path>) -> LocalToolRequest {
        LocalToolRequest { action, file_name: file.map(str::to_owned), project_name: project.map(str::to_owned), search_root: root.map(|path| path.to_string_lossy().into_owned()), selected_path: selected.map(|path| path.to_string_lossy().into_owned()), downloads: None, file_filter: None, recursive: None }
    }

    #[test]
    fn resolves_xdg_download_folder_and_falls_back_only_when_unconfigured() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("config"); fs::create_dir(&config).unwrap();
        fs::write(config.join("user-dirs.dirs"), "XDG_DOWNLOAD_DIR=\"$HOME/Transferências\"\n").unwrap();
        assert_eq!(configured_downloads_dir(home.path(), Some(&config)), home.path().join("Transferências"));
        fs::write(config.join("user-dirs.dirs"), "XDG_DOCUMENTS_DIR=\"$HOME/Documentos\"\n").unwrap();
        assert_eq!(configured_downloads_dir(home.path(), Some(&config)), home.path().join("Downloads"));
        assert_eq!(configured_downloads_dir(home.path(), None), home.path().join("Downloads"));
    }

    #[test]
    fn lists_download_files_with_case_insensitive_filters_and_optional_subfolders() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("café.PNG"), "png").unwrap();
        fs::write(root.path().join("foto.JpG"), "jpg").unwrap();
        fs::write(root.path().join("foto.jpeg"), "jpeg").unwrap();
        fs::write(root.path().join("ícone.SVG"), "svg").unwrap();
        fs::write(root.path().join("animação.GIF"), "gif").unwrap();
        fs::write(root.path().join("paisagem.webp"), "webp").unwrap();
        fs::write(root.path().join("relatório.PDF"), "pdf").unwrap();
        fs::write(root.path().join("notas.txt"), "texto").unwrap();
        let nested = root.path().join("sub pasta"); fs::create_dir(&nested).unwrap();
        fs::write(nested.join("dentro.jpg"), "nested").unwrap();
        let images = list_downloads_at(root.path(), DownloadFilter::Images, false);
        assert_eq!(images.results.len(), 6);
        assert!(images.results.iter().all(|item| [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].iter().any(|ext| item.path.to_lowercase().ends_with(ext))));
        assert!(images.results.iter().all(|item| !item.path.contains("sub pasta")));
        let pdf = list_downloads_at(root.path(), DownloadFilter::Pdf, false);
        assert_eq!(pdf.results.len(), 1); assert!(pdf.results[0].path.ends_with("relatório.PDF"));
        let all = list_downloads_at(root.path(), DownloadFilter::All, false);
        assert_eq!(all.results.len(), 9); assert!(all.results.iter().any(|item| item.kind == "directory"));
        let recursive = list_downloads_at(root.path(), DownloadFilter::Images, true);
        assert_eq!(recursive.results.len(), 7); assert!(recursive.results.iter().any(|item| item.path.ends_with("dentro.jpg")));
    }

    #[test]
    fn download_listing_reports_empty_missing_denied_and_limit_conditions() {
        let root = tempfile::tempdir().unwrap();
        let empty = list_downloads_at(root.path(), DownloadFilter::Pdf, false);
        assert_eq!(empty.status, "success"); assert!(empty.message.contains("PDFs")); assert!(empty.message.contains(&display_path(root.path())));
        let missing = list_downloads_at(&root.path().join("inexistente"), DownloadFilter::All, false);
        assert_eq!(missing.status, "error"); assert!(missing.message.contains("não existe"));
        for index in 0..(MAX_LISTING + 3) { fs::write(root.path().join(format!("arquivo {index:03}.pdf")), "pdf").unwrap(); }
        let many = list_downloads_at(root.path(), DownloadFilter::Pdf, false);
        assert_eq!(many.results.len(), MAX_LISTING); assert!(many.truncated); assert!(many.message.contains("limitada"));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            let denied = root.path().join("negada"); fs::create_dir(&denied).unwrap();
            fs::set_permissions(&denied, fs::Permissions::from_mode(0o000)).unwrap();
            let result = list_downloads_at(&denied, DownloadFilter::All, false);
            assert_eq!(result.status, "error"); assert!(result.message.contains("permissão negada"));
            fs::set_permissions(&denied, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    #[test]
    fn finds_case_and_accent_insensitive_project_and_file_names_without_following_symlink_cycles() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("OdontoFlów Projeto"); fs::create_dir(&project).unwrap();
        fs::write(project.join("ReadMe.MD"), "conteúdo local").unwrap();
        symlink(root.path(), project.join("ciclo")).unwrap();
        let req = request(LocalAction::ReadFile, Some("README.md"), Some("odontoflow projeto"), Some(root.path()), None);
        let result = execute(req);
        assert_eq!(result.status, "success"); assert!(result.path.unwrap().ends_with("ReadMe.MD")); assert_eq!(result.content.as_deref(), Some("conteúdo local"));
    }

    #[test]
    fn duplicate_projects_are_ambiguous_and_selection_continues_the_read() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("one/OdontoFlow"); let second = root.path().join("two/OdontoFlow");
        fs::create_dir_all(&first).unwrap(); fs::create_dir_all(&second).unwrap();
        fs::write(first.join("README.md"), "primeiro").unwrap(); fs::write(second.join("README.md"), "segundo").unwrap();
        let ambiguous = execute(request(LocalAction::ReadFile, Some("README.md"), Some("OdontoFlow"), Some(root.path()), None));
        assert_eq!(ambiguous.status, "ambiguous"); assert_eq!(ambiguous.results.len(), 2);
        let selected = execute(request(LocalAction::ReadFile, Some("README.md"), Some("OdontoFlow"), Some(root.path()), Some(Path::new(&second))));
        assert_eq!(selected.status, "success"); assert_eq!(selected.content.as_deref(), Some("segundo"));
    }

    #[test]
    fn reports_missing_file_project_and_search_folder() {
        let root = tempfile::tempdir().unwrap();
        let missing_file = execute(request(LocalAction::ReadFile, Some("README.md"), Some("OdontoFlow"), Some(root.path()), None));
        assert_eq!(missing_file.status, "not_found");
        let missing_project = execute(request(LocalAction::OpenProject, None, Some("OdontoFlow"), Some(root.path()), None));
        assert_eq!(missing_project.status, "not_found");
        let missing_root = execute(request(LocalAction::Search, Some("README.md"), None, Some(&root.path().join("inexistente")), None));
        assert_eq!(missing_root.status, "error");
    }

    #[test]
    fn resolves_named_projects_folder_relative_to_the_home_directory() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("Projetos"); fs::create_dir(&projects).unwrap();
        assert_eq!(resolve_search_root_from(home.path(), Some("Projetos")).unwrap(), projects);
        assert_eq!(resolve_search_root_from(home.path(), Some("~/Projetos")).unwrap(), projects);
    }

    #[test]
    fn reads_text_limits_large_content_and_rejects_binary_and_invalid_encoding() {
        let root = tempfile::tempdir().unwrap(); let file = root.path().join("arquivo com espaço.txt");
        fs::write(&file, "texto").unwrap(); assert_eq!(read_file_at(&file).content.as_deref(), Some("texto"));
        fs::write(&file, vec![b'x'; MAX_READ_BYTES + 20]).unwrap(); let large = read_file_at(&file); assert!(large.truncated); assert_eq!(large.content.unwrap().len(), MAX_READ_BYTES);
        fs::write(&file, [b'x', 0, b'y']).unwrap(); assert_eq!(read_file_at(&file).status, "error");
        fs::write(&file, [0xff, 0xfe]).unwrap(); assert!(read_file_at(&file).message.contains("UTF-8"));
    }

    #[test]
    fn lists_directory_and_open_uses_simulated_executable_with_one_path_argument() {
        let root = tempfile::tempdir().unwrap(); let project = root.path().join("Projeto com espaço"); fs::create_dir(&project).unwrap();
        fs::write(project.join("a.txt"), "a").unwrap(); assert_eq!(list_directory_at(&project).results.len(), 1);
        let capture = root.path().join("captured"); let program = root.path().join("code-simulado");
        fs::write(&program, format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'\n", capture.display())).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = launch_code(program.as_os_str(), &project).unwrap(); assert!(child.wait().unwrap().success());
        assert_eq!(fs::read_to_string(capture).unwrap(), project.to_string_lossy());
        assert_eq!(launch_code(root.path().join("missing-code").as_os_str(), &project).unwrap_err().kind(), std::io::ErrorKind::NotFound);
    }

    #[test]
    fn search_finds_single_and_multiple_candidates() {
        let root = tempfile::tempdir().unwrap(); let p1 = root.path().join("one"); let p2 = root.path().join("two");
        fs::create_dir(&p1).unwrap(); fs::create_dir(&p2).unwrap(); fs::write(p1.join("README.md"), "1").unwrap(); fs::write(p2.join("README.md"), "2").unwrap();
        let one = execute(request(LocalAction::Search, Some("README.md"), None, Some(&p1), None)); assert_eq!(one.results.len(), 1);
        let many = execute(request(LocalAction::Search, Some("README.md"), None, Some(root.path()), None)); assert_eq!(many.results.len(), 2);

        let project = root.path().join("Projetos/OdontoFlow"); fs::create_dir_all(&project).unwrap(); fs::write(project.join("ReadMe.MD"), "conteúdo").unwrap();
        let scoped = execute(request(LocalAction::Search, Some("README.md"), Some("odontoflow"), Some(&root.path().join("Projetos")), None));
        assert_eq!(scoped.status, "success"); assert_eq!(scoped.results.len(), 1); assert!(scoped.results[0].path.ends_with("ReadMe.MD"));
    }

    #[test]
    fn prioritizes_project_root_and_ignores_generated_directories_unless_requested() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join("Projetos");
        let project = projects.join("odontoflow");
        for directory in [
            "src",
            "src-tauri",
            "node_modules/dependencia",
            "dist",
            ".git",
        ] {
            fs::create_dir_all(project.join(directory)).unwrap();
        }
        fs::create_dir_all(home.path().join(".local/share/br.com.odontoflow.desktop")).unwrap();
        let readme = project.join("README.md");
        let dependency_readme = project.join("node_modules/dependencia/README.md");
        let nested_readme = project.join("src/README.md");
        fs::write(&readme, "README da raiz").unwrap();
        fs::write(&dependency_readme, "README da dependência").unwrap();
        fs::write(&nested_readme, "README de src").unwrap();

        let open = request(
            LocalAction::OpenProject,
            None,
            Some("OdontoFlow"),
            Some(home.path()),
            None,
        );
        let target = find_single_project(&open, home.path(), "open_project").unwrap();
        assert_eq!(target, project);

        let program = home.path().join("code-simulado");
        fs::write(
            &program,
            "#!/bin/sh\n[ \"$#\" -eq 1 ] && [ -d \"$1/.git\" ] && [ -f \"$1/README.md\" ]\n",
        )
        .unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            launch_code(program.as_os_str(), &target)
                .unwrap()
                .wait()
                .unwrap()
                .success()
        );

        let read = || {
            execute(request(
                LocalAction::ReadFile,
                Some("README.md"),
                Some("OdontoFlow"),
                Some(home.path()),
                None,
            ))
        };
        assert_eq!(read().content.as_deref(), Some("README da raiz"));
        let scoped = execute(request(
            LocalAction::Search,
            Some("README.md"),
            Some("OdontoFlow"),
            Some(home.path()),
            None,
        ));
        assert_eq!(scoped.results.len(), 1);
        assert_eq!(scoped.results[0].path, display_path(&readme));
        let generic = execute(request(
            LocalAction::Search,
            Some("README.md"),
            None,
            Some(home.path()),
            None,
        ));
        assert_eq!(generic.results.len(), 2);
        assert!(
            !generic
                .results
                .iter()
                .any(|entry| entry.path.contains("node_modules"))
        );

        let dependency = execute(request(
            LocalAction::Search,
            None,
            Some("node_modules"),
            Some(home.path()),
            None,
        ));
        assert_eq!(
            dependency.results[0].path,
            display_path(&project.join("node_modules"))
        );
        let explicit = execute(request(
            LocalAction::ReadFile,
            None,
            None,
            Some(home.path()),
            Some(&dependency_readme),
        ));
        assert_eq!(explicit.content.as_deref(), Some("README da dependência"));

        fs::remove_file(&readme).unwrap();
        assert_eq!(
            read().path.as_deref(),
            Some(display_path(&nested_readme).as_str())
        );
        fs::remove_file(&nested_readme).unwrap();
        assert_eq!(read().status, "not_found");
    }

    #[test]
    fn ranks_equivalent_projects_in_the_preferred_directory_and_preserves_ties_there() {
        let home = tempfile::tempdir().unwrap();
        let preferred = home.path().join("Projetos");
        let first = preferred.join("OdontoFlow");
        let unmarked = preferred.join("old/OdontoFlow");
        let elsewhere = home.path().join("archive/odontoflow");
        for path in [&first, &unmarked, &elsewhere] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir(first.join(".git")).unwrap();
        fs::write(elsewhere.join("Cargo.toml"), "").unwrap();
        let (results, _, _) = ranked_projects(home.path(), "OdontoFlow", &preferred);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, display_path(&first));

        fs::write(unmarked.join("package.json"), "{}").unwrap();
        let (results, _, _) = ranked_projects(home.path(), "OdontoFlow", &preferred);
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn inspects_an_absolute_path_and_continues_an_ambiguous_read_without_fabricating_content() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("OdontoFlow");
        let first = project.join("src/README.md");
        let second = project.join("docs/README.md");
        for path in [&first, &second] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, display_path(path)).unwrap();
        }
        let inspect = |path: &Path| {
            execute(request(
                LocalAction::InspectPath,
                None,
                None,
                None,
                Some(path),
            ))
        };
        assert_eq!(inspect(&first).status, "clarification");
        assert!(inspect(&first).content.is_none());
        assert_eq!(inspect(&project).status, "clarification");
        let read = |path| {
            execute(request(
                LocalAction::ReadFile,
                Some("README.md"),
                Some("OdontoFlow"),
                Some(root.path()),
                path,
            ))
        };
        let options = read(None);
        assert_eq!(options.status, "ambiguous");
        assert_eq!(options.results.len(), 2);
        let chosen = Path::new(&options.results[0].path);
        assert_eq!(read(Some(chosen)).content.as_deref(), chosen.to_str());

        fs::remove_file(chosen).unwrap();
        assert_eq!(inspect(chosen).status, "error");
        let failed = read(Some(chosen));
        assert_eq!(failed.status, "error");
        assert!(failed.content.is_none());
    }
}
