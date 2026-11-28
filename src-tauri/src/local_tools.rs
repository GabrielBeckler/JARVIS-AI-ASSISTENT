use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
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
}

#[derive(Debug, Deserialize)]
pub struct LocalToolRequest {
    pub action: LocalAction,
    pub query: String,
    pub selected_path: Option<String>,
}

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
        Self { action: action.into(), status: status.into(), message: message.into(), results: vec![], path: None, content: None, truncated: false }
    }
}

fn display_path(path: &Path) -> String { path.to_string_lossy().into_owned() }
fn entry(path: PathBuf, kind: &'static str) -> LocalEntry { LocalEntry { path: display_path(&path), kind } }
fn action_name(action: &LocalAction) -> &'static str {
    match action { LocalAction::Search => "search", LocalAction::ListDirectory => "list_directory", LocalAction::ReadFile => "read_file", LocalAction::OpenProject => "open_project" }
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

fn explicit_path(query: &str) -> Result<Option<PathBuf>, String> {
    let query=query.trim();
    if query.starts_with('/') { return Ok(Some(PathBuf::from(query))); }
    if query == "~" { return Ok(Some(home_dir()?)); }
    if let Some(rest)=query.strip_prefix("~/") { return Ok(Some(home_dir()?.join(rest))); }
    if (query.starts_with("./") || query.starts_with("../")) && Path::new(query).exists() { return Ok(Some(PathBuf::from(query))); }
    Ok(None)
}

fn matches_name(path: &Path, query: &str) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false; };
    let query = normalized(query);
    if normalized(name).contains(&query) { return true; }
    let full_path = normalized(&display_path(path));
    let terms: Vec<_> = query.split_whitespace().filter(|word| !["do", "da", "de", "dos", "das", "o", "a", "meu", "minha", "projeto"].contains(word)).collect();
    !terms.is_empty() && terms.iter().all(|term| full_path.contains(term))
}

fn walk(root: &Path, needle: &str, desired: Option<&str>) -> (Vec<LocalEntry>, bool, bool) {
    let start = Instant::now();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited_paths = HashSet::new();
    let mut results = Vec::new();
    let mut denied = false;
    let mut limited = false;
    while let Some((directory, depth)) = stack.pop() {
        if start.elapsed() > SEARCH_BUDGET || visited_paths.len() >= MAX_VISITED || results.len() >= MAX_RESULTS {
            limited = true; break;
        }
        let canonical = match fs::canonicalize(&directory) { Ok(p) => p, Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
        if !visited_paths.insert(canonical) { continue; }
        let children = match fs::read_dir(&directory) { Ok(children) => children, Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
        for item in children {
            if start.elapsed() > SEARCH_BUDGET || visited_paths.len() >= MAX_VISITED || results.len() >= MAX_RESULTS { limited = true; break; }
            let item = match item { Ok(item) => item, Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
            let path = item.path();
            let file_type = match item.file_type() { Ok(kind) => kind, Err(_) => continue };
            if file_type.is_symlink() { continue; }
            let is_dir = file_type.is_dir();
            if (desired.is_none() || desired == Some(if is_dir { "directory" } else { "file" })) && matches_name(&path, needle) {
                results.push(entry(path.clone(), if is_dir { "directory" } else { "file" }));
            }
            if is_dir && depth < MAX_DEPTH { stack.push((path, depth + 1)); }
        }
    }
    (results, limited, denied)
}

fn candidates(query: &str, selected: Option<&str>, dirs_only: bool) -> Result<(Vec<LocalEntry>, bool, bool), String> {
    if let Some(path) = selected {
        let path = PathBuf::from(path);
        if !path.exists() { return Err(format!("O caminho selecionado foi removido ou não existe: {}", display_path(&path))); }
        let metadata = fs::symlink_metadata(&path).map_err(|e| format!("Não foi possível consultar {}: {e}", display_path(&path)))?;
        let kind = if metadata.is_dir() { "directory" } else { "file" };
        if dirs_only && kind != "directory" { return Err(format!("O caminho selecionado não é uma pasta: {}", display_path(&path))); }
        return Ok((vec![entry(path, kind)], false, false));
    }
    if let Some(path)=explicit_path(query)? {
        if !path.exists() { return Err(format!("O caminho informado não existe: {}",display_path(&path))); }
        let metadata=fs::symlink_metadata(&path).map_err(|e|format!("Não foi possível consultar {}: {e}",display_path(&path)))?;
        if dirs_only && !metadata.is_dir() {return Err(format!("O caminho informado não é uma pasta: {}",display_path(&path)));}
        return Ok((vec![entry(path,if metadata.is_dir(){"directory"}else{"file"})],false,false));
    }
    let root = home_dir()?;
    let (results, limited, denied) = walk(&root, query, if dirs_only { Some("directory") } else { None });
    Ok((results, limited, denied))
}

fn search(req: &LocalToolRequest) -> LocalToolResult {
    let query = req.query.trim();
    if query.is_empty() || query.len() > 240 { return LocalToolResult::new("search", "error", "Informe um nome de arquivo ou pasta com até 240 caracteres."); }
    let (root, needle) = if let Some((name, location)) = query.split_once(" em ").filter(|(_, location)| location.starts_with('/') || location.starts_with("~/")) {
        match explicit_path(location) { Ok(Some(root)) => (root, name.trim()), Ok(None) => (home_dir().unwrap_or_default(), query), Err(e) => return LocalToolResult::new("search", "error", e) }
    } else { (home_dir().unwrap_or_default(), query) };
    let (results, limited, denied) = walk(&root, needle, None);
    let count = results.len();
    let mut result = LocalToolResult::new("search", "success", if count == 0 { format!("Não encontrei “{query}” a partir de {}.", display_path(&root)) } else { format!("Encontrei {count} resultado(s) para “{query}”{}.", if limited { "; busca limitada por tempo ou volume" } else { "" }) });
    result.results = results;
    if denied { result.message.push_str(" Alguns locais foram ignorados porque o Fedora negou acesso."); }
    result
}

fn list_directory(req: &LocalToolRequest) -> LocalToolResult {
    let selected = req.selected_path.as_deref();
    let query = req.query.trim();
    let target = if let Some(path) = selected { PathBuf::from(path) } else {
        let candidate = match explicit_path(query) { Ok(path) => path, Err(e) => return LocalToolResult::new("list_directory", "error", e) };
        if candidate.as_ref().is_some_and(|path| path.is_dir()) { candidate.unwrap() }
        else {
            let root = match home_dir() { Ok(p) => p, Err(e) => return LocalToolResult::new("list_directory", "error", e) };
            {
                let (mut dirs, limited, denied) = walk(&root, query, Some("directory"));
                dirs.truncate(MAX_RESULTS);
                if dirs.is_empty() { let mut r=LocalToolResult::new("list_directory", "error", format!("Não encontrei uma pasta chamada “{query}”.")); if denied {r.message.push_str(" O Fedora também negou acesso a alguns locais.");} return r; }
                if dirs.len() > 1 { let mut r=LocalToolResult::new("list_directory", "ambiguous", format!("Encontrei {} pastas chamadas “{query}”. Escolha uma para listar{}:", dirs.len(), if limited { " (busca limitada)" } else { "" })); r.results=dirs; return r; }
                PathBuf::from(&dirs[0].path)
            }
        }
    };
    if !target.exists() { return LocalToolResult::new("list_directory", "error", format!("A pasta não existe mais: {}", display_path(&target))); }
    let read = match fs::read_dir(&target) { Ok(r) => r, Err(e) => return LocalToolResult::new("list_directory", "error", format!("Não foi possível listar {}: {e}", display_path(&target))) };
    let mut items = Vec::new();
    let mut denied = false;
    for item in read.take(MAX_LISTING + 1) {
        let item = match item { Ok(item) => item, Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
        let kind = match item.file_type() { Ok(kind) => kind, Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => { denied = true; continue; }, Err(_) => continue };
        if kind.is_symlink() { continue; }
        items.push(entry(item.path(), if kind.is_dir() { "directory" } else { "file" }));
    }
    items.sort_by(|a,b| normalized(&a.path).cmp(&normalized(&b.path)));
    let truncated = items.len() > MAX_LISTING;
    items.truncate(MAX_LISTING);
    let mut result = LocalToolResult::new("list_directory", "success", format!("Conteúdo de {} ({} item(ns) mostrado(s)){}{}:", display_path(&target), items.len(), if truncated { "; lista limitada a 100 itens" } else { "" }, if denied { "; alguns itens foram omitidos por permissão negada" } else { "" }));
    result.path=Some(display_path(&target)); result.results=items; result.truncated=truncated; result
}

fn read_file(req: &LocalToolRequest) -> LocalToolResult {
    let query=req.query.trim();
    let path = if let Some(selected)=req.selected_path.as_deref() { PathBuf::from(selected) } else {
        let candidate=match explicit_path(query) {Ok(path)=>path,Err(e)=>return LocalToolResult::new("read_file","error",e)};
        if candidate.as_ref().is_some_and(|path|path.is_file()) { candidate.unwrap() }
        else {
            let root=match home_dir() {Ok(p)=>p,Err(e)=>return LocalToolResult::new("read_file","error",e)};
            let needle=query;
            let (mut files,limited,denied)=walk(&root,needle,Some("file")); files.truncate(MAX_RESULTS);
            if files.is_empty() { let mut r=LocalToolResult::new("read_file","error",format!("Não encontrei o arquivo “{query}” em {}.",display_path(&root))); if denied {r.message.push_str(" O Fedora negou acesso a alguns locais.");} return r; }
            if files.len()>1 {let mut r=LocalToolResult::new("read_file","ambiguous",format!("Encontrei {} arquivos compatíveis com “{query}”. Escolha qual devo ler{}:",files.len(),if limited {" (busca limitada)"} else {""}));r.results=files;return r;}
            PathBuf::from(&files[0].path)
        }
    };
    let mut file=match fs::File::open(&path) {Ok(f)=>f,Err(e)=>return LocalToolResult::new("read_file","error",format!("Não foi possível ler {}: {e}",display_path(&path)))};
    let mut bytes=vec![0;MAX_READ_BYTES+1]; let count=match file.read(&mut bytes) {Ok(n)=>n,Err(e)=>return LocalToolResult::new("read_file","error",format!("Falha ao ler {}: {e}",display_path(&path)))};
    let truncated=count>MAX_READ_BYTES; bytes.truncate(count.min(MAX_READ_BYTES));
    if bytes.contains(&0) {return LocalToolResult::new("read_file","error",format!("{} parece ser um arquivo binário; não exibi o conteúdo.",display_path(&path)));}
    let content=match String::from_utf8(bytes) {Ok(s)=>s,Err(_)=>return LocalToolResult::new("read_file","error",format!("{} não contém texto UTF-8 válido.",display_path(&path)))};
    let mut result=LocalToolResult::new("read_file","success",format!("Li {} ({} bytes{}).",display_path(&path),count.min(MAX_READ_BYTES),if truncated {"; trecho inicial limitado a 64 KiB"} else {""}));
    result.path=Some(display_path(&path));result.content=Some(content);result.truncated=truncated;result
}

fn open_project(req: &LocalToolRequest) -> LocalToolResult {
    let query=req.query.trim();
    let (entries,limited,denied)=match candidates(query,req.selected_path.as_deref(),true) {Ok(v)=>v,Err(e)=>return LocalToolResult::new("open_project","error",e)};
    if entries.is_empty() {return LocalToolResult::new("open_project","error",format!("Não encontrei uma pasta de projeto chamada “{query}”{}.",if denied {"; o Fedora negou acesso a alguns locais"} else {""}));}
    if entries.len()>1 {let mut r=LocalToolResult::new("open_project","ambiguous",format!("Encontrei {} pastas compatíveis com “{query}”. Escolha qual abrir{}:",entries.len(),if limited {" (busca limitada)"} else {""}));r.results=entries;return r;}
    let path=PathBuf::from(&entries[0].path);
    if !path.is_dir() {return LocalToolResult::new("open_project","error",format!("A pasta foi removida antes da abertura: {}",display_path(&path)));}
    match launch_code(std::ffi::OsStr::new("code"), &path) {
        Ok(_child)=>{let mut r=LocalToolResult::new("open_project","success",format!("Iniciei o VS Code para {}.",display_path(&path)));r.path=Some(display_path(&path));r}
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>LocalToolResult::new("open_project","error","Não encontrei o comando `code`. Instale/ative o comando do VS Code no PATH e tente novamente."),
        Err(e)=>LocalToolResult::new("open_project","error",format!("Não foi possível iniciar o VS Code para {}: {e}",display_path(&path))),
    }
}

fn launch_code(program: &std::ffi::OsStr, path: &Path) -> std::io::Result<Child> {
    Command::new(program).arg(path).spawn()
}

pub fn execute(request: LocalToolRequest) -> LocalToolResult {
    let name=action_name(&request.action);
    if request.query.trim().is_empty() || request.query.len()>240 {return LocalToolResult::new(name,"error","Pedido local vazio ou longo demais (limite: 240 caracteres).");}
    match request.action {LocalAction::Search=>search(&request),LocalAction::ListDirectory=>list_directory(&request),LocalAction::ReadFile=>read_file(&request),LocalAction::OpenProject=>open_project(&request)}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn search_finds_accented_names_without_following_symlink_cycles() {
        let root=tempfile::tempdir().unwrap(); let sub=root.path().join("projeto");fs::create_dir(&sub).unwrap();
        fs::write(sub.join("anotações especiais!.txt"),"ok").unwrap(); symlink(root.path(),sub.join("ciclo")).unwrap();
        let (found,_,_)=walk(root.path(),"anotacoes especiais",Some("file"));assert_eq!(found.len(),1);assert!(found[0].path.contains("anotações especiais!.txt"));
    }
    #[test]
    fn reads_text_and_limits_large_content_but_rejects_binary_and_missing_paths() {
        let root=tempfile::tempdir().unwrap();let file=root.path().join("arquivo com espaço.txt");fs::write(&file,"texto").unwrap();
        let mut r=read_file(&LocalToolRequest{action:LocalAction::ReadFile,query:file.to_string_lossy().into(),selected_path:None});assert_eq!(r.content.as_deref(),Some("texto"));
        fs::write(&file,vec![b'x';MAX_READ_BYTES+20]).unwrap();r=read_file(&LocalToolRequest{action:LocalAction::ReadFile,query:file.to_string_lossy().into(),selected_path:None});assert!(r.truncated);assert_eq!(r.content.unwrap().len(),MAX_READ_BYTES);
        fs::write(&file,[b'x',0,b'y']).unwrap();assert_eq!(read_file(&LocalToolRequest{action:LocalAction::ReadFile,query:file.to_string_lossy().into(),selected_path:None}).status,"error");
        fs::write(&file,[0xff,0xfe]).unwrap();let invalid=read_file(&LocalToolRequest{action:LocalAction::ReadFile,query:file.to_string_lossy().into(),selected_path:None});assert!(invalid.message.contains("UTF-8"));
        assert_eq!(read_file(&LocalToolRequest{action:LocalAction::ReadFile,query:"/caminho/inexistente".into(),selected_path:None}).status,"error");
    }
    #[test]
    fn list_returns_real_entries_and_open_reports_missing_vscode() {
        let root=tempfile::tempdir().unwrap();fs::write(root.path().join("a.txt"),"a").unwrap();let result=list_directory(&LocalToolRequest{action:LocalAction::ListDirectory,query:root.path().to_string_lossy().into(),selected_path:None});assert_eq!(result.results.len(),1);assert_eq!(result.results[0].kind,"file");
    }

    #[test]
    fn search_handles_one_many_and_no_matches() {
        let root=tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("OdontoFlow")).unwrap();
        fs::write(root.path().join("OdontoFlow/README.md"),"a").unwrap();
        fs::write(root.path().join("OdontoFlow/um-arquivo-especial.txt"),"c").unwrap();
        fs::create_dir(root.path().join("OdontoFlow-demo")).unwrap();
        fs::write(root.path().join("OdontoFlow-demo/README.md"),"b").unwrap();
        let (many,_,_)=walk(root.path(),"OdontoFlow",None);assert!(many.len()>=2);
        let (one,_,_)=walk(root.path(),"um-arquivo-especial.txt",Some("file"));assert_eq!(one.len(),1);
        let (multi,_,_)=walk(root.path(),"README.md",Some("file"));assert_eq!(multi.len(),2);
        let (none,_,_)=walk(root.path(),"nao-existe",None);assert!(none.is_empty());
    }

    #[test]
    fn simulated_code_receives_project_path_as_a_single_argument_and_missing_program_is_clear() {
        use std::os::unix::fs::PermissionsExt;
        let root=tempfile::tempdir().unwrap();
        let capture=root.path().join("captured");
        let program=root.path().join("code-simulado");
        fs::write(&program,format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'\n",capture.display())).unwrap();
        fs::set_permissions(&program,fs::Permissions::from_mode(0o755)).unwrap();
        let project=root.path().join("Projeto com espaço");fs::create_dir(&project).unwrap();
        let mut child=launch_code(program.as_os_str(),&project).unwrap();assert!(child.wait().unwrap().success());
        assert_eq!(fs::read_to_string(capture).unwrap(),project.to_string_lossy());
        let missing=launch_code(root.path().join("inexistente-code").as_os_str(),&project).unwrap_err();
        assert_eq!(missing.kind(),std::io::ErrorKind::NotFound);
    }

    #[test]
    fn refuses_to_open_a_directory_removed_after_selection() {
        let root=tempfile::tempdir().unwrap();let path=root.path().join("removida");fs::create_dir(&path).unwrap();fs::remove_dir(&path).unwrap();
        let result=open_project(&LocalToolRequest{action:LocalAction::OpenProject,query:"removida".into(),selected_path:Some(path.to_string_lossy().into())});
        assert_eq!(result.status,"error");assert!(result.message.contains("não existe"));
    }
}
