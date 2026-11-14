use tauri::{Emitter, Manager};
mod dictionary;
mod tts;
mod obsidian;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type AiTasks = Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>;

/// 双击 .epub/.pdf 启动时，命令行里的文件路径先存这里，前端就绪后再取走。
#[derive(Default)]
struct PendingFile(Mutex<Option<String>>);

fn first_book_arg(args: impl IntoIterator<Item = String>) -> Option<String> {
    args.into_iter().find(|a| {
        let lower = a.to_ascii_lowercase();
        lower.ends_with(".epub") || lower.ends_with(".pdf")
    })
}

#[tauri::command]
fn take_pending_file(state: tauri::State<'_, PendingFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[derive(serde::Serialize, Clone)]
struct AiReply {
    content: Option<String>,
    error: Option<String>,
    chunk: Option<Vec<u8>>,
    done: bool,
    #[serde(rename = "finishReason")]
    finish_reason: Option<String>,
}

// 桌面请求由本地 HTTP 客户端发送，避免 WebView 的跨域限制。
#[tauri::command]
fn start_ai_request(
    tasks: tauri::State<'_, AiTasks>,
    id: String,
    base: String,
    key: String,
    body: serde_json::Value,
    result: tauri::ipc::Channel<AiReply>,
) -> Result<(), String> {
    let url = reqwest::Url::parse(&format!("{}/chat/completions", base.trim_end_matches('/')))
        .map_err(|_| "接口地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Err("接口地址需为 HTTP(S) 地址，不能包含密码".into());
    }
    let registry = tasks.inner().clone();
    let mut map = registry.lock().map_err(|e| e.to_string())?;
    if map.len() >= 4 || map.contains_key(&id) {
        return Err("已有请求正在处理，请稍后重试".into());
    }
    let cleanup = registry.clone();
    let task_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let response: Result<(Option<String>, Option<String>), String> = async {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .redirect(reqwest::redirect::Policy::none())
                .build().map_err(|_| "无法初始化 HTTP 客户端".to_string())?;
            let mut request = client.post(url).json(&body);
            if !key.trim().is_empty() { request = request.bearer_auth(key.trim()); }
            let mut response = request.send().await.map_err(|e| {
                if e.is_timeout() { "AI 请求超时，请重试".to_string() }
                else { "连接失败，请检查接口地址和网络".to_string() }
            })?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("HTTP {}：请检查接口地址、模型、Key 或额度", status.as_u16()));
            }
            if body["stream"].as_bool() == Some(true) && response.headers()
                .get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.contains("text/event-stream")) {
                let mut total = 0usize;
                while let Some(chunk) = response.chunk().await.map_err(|e| {
                    if e.is_timeout() { "AI 请求超时，请重试".to_string() }
                    else { "AI 输出中断，请检查网络后重试".to_string() }
                })? {
                    total += chunk.len();
                    // 2 MB 兜底：接口异常返回巨型流时不至于把内存吃满
                    if total > 2 * 1024 * 1024 { return Err("AI 输出过长，已停止".to_string()); }
                    result.send(AiReply { content: None, error: None, chunk: Some(chunk.to_vec()), done: false, finish_reason: None })
                        .map_err(|_| "AI 窗口已关闭".to_string())?;
                }
                return Ok((None, None));
            }
            let data: serde_json::Value = response.json().await.map_err(|_| "接口返回的内容不是 JSON".to_string())?;
            data["choices"][0]["message"]["content"].as_str()
                .filter(|s| !s.trim().is_empty()).map(|s| (Some(s.to_string()), data["choices"][0]["finish_reason"].as_str().map(str::to_string)))
                .ok_or_else(|| "接口没有返回正文，请检查模型是否支持对话".to_string())
        }.await;
        let reply = match response {
            Ok((content, finish_reason)) => AiReply { content, error: None, chunk: None, done: true, finish_reason },
            Err(error) => AiReply { content: None, error: Some(error), chunk: None, done: true, finish_reason: None },
        };
        let _ = result.send(reply);
        if let Ok(mut map) = cleanup.lock() { map.remove(&task_id); }
    });
    map.insert(id, task);
    Ok(())
}

#[tauri::command]
fn cancel_ai_request(tasks: tauri::State<'_, AiTasks>, id: String) -> Result<(), String> {
    if let Some(task) = tasks.lock().map_err(|e| e.to_string())?.remove(&id) {
        task.abort();
    }
    Ok(())
}

/// 首个命令：把书库目录暴露给前端，后续换掉 storage.ts 的 IndexedDB 实现
#[tauri::command]
fn library_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("books");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 导入结果：前端据此写元数据，不再需要读取原路径
#[derive(serde::Serialize)]
struct ImportedFile {
    path: String,
    size: u64,
    mtime: u64,
    /// 书库里已有内容相同的书时不复制，直接返回那本书的 id
    #[serde(rename = "duplicateId")]
    duplicate_id: Option<String>,
}

fn mtime_millis(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 分块读满 buf。File::read 允许短读，按单次读取长度比较会误判。
fn read_chunk(file: &mut std::fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    use std::io::Read;
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// 两个文件内容是否完全相同（同名同大小也不一定是同一本书）
fn same_content(a: &std::path::Path, b: &std::path::Path) -> bool {
    let (mut fa, mut fb) = match (std::fs::File::open(a), std::fs::File::open(b)) {
        (Ok(x), Ok(y)) => (x, y),
        _ => return false,
    };
    let mut ba = [0u8; 64 * 1024];
    let mut bb = [0u8; 64 * 1024];
    loop {
        let na = match read_chunk(&mut fa, &mut ba) {
            Ok(n) => n,
            Err(_) => return false,
        };
        let nb = match read_chunk(&mut fb, &mut bb) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if na != nb || ba[..na] != bb[..nb] {
            return false;
        }
        if na == 0 {
            return true;
        }
    }
}

/// 在书库目录里找内容与 src 完全相同的书，返回 (书 id, 书库内路径)。
/// 书库文件名就是书 id，所以老记录（没有 sourcePath）也能被认出来。
fn find_duplicate(
    dir: &std::path::Path,
    src: &std::path::Path,
    ext: &str,
) -> Option<(String, std::path::PathBuf)> {
    let src_len = std::fs::metadata(src).ok()?.len();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() || path == src {
            continue;
        }
        let same_ext = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(ext));
        if !same_ext {
            continue;
        }
        // 先用大小筛一遍：同一文件的副本一定同大小，只有撞上才读内容
        match std::fs::metadata(&path) {
            Ok(meta) if meta.len() == src_len => {}
            _ => continue,
        }
        if !same_content(src, &path) {
            continue;
        }
        if let Some(id) = path.file_stem().and_then(|s| s.to_str()) {
            return Some((id.to_string(), path));
        }
    }
    None
}

/// 把用户选中的书复制进书库目录。
/// 这样前端只碰 $APPDATA 下的文件，fs scope 不必再放开 "**"。
#[tauri::command]
fn import_book(app: tauri::AppHandle, src: String, id: String) -> Result<ImportedFile, String> {
    let src_path = std::path::PathBuf::from(&src);
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "epub" && ext != "pdf" {
        return Err(format!("不支持的文件类型：{ext}"));
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("books");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // 同一个文件再次双击：不再复制第二份，直接复用书库里已有的那本
    if let Some((existing, path)) = find_duplicate(&dir, &src_path, &ext) {
        if let Ok(meta) = std::fs::metadata(&path) {
            return Ok(ImportedFile {
                path: path.to_string_lossy().to_string(),
                size: meta.len(),
                mtime: mtime_millis(&meta),
                duplicate_id: Some(existing),
            });
        }
    }

    let dest = dir.join(format!("{id}.{ext}"));
    std::fs::copy(&src_path, &dest).map_err(|e| format!("复制失败：{e}"))?;

    let meta = std::fs::metadata(&dest).map_err(|e| e.to_string())?;

    Ok(ImportedFile {
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
        mtime: mtime_millis(&meta),
        duplicate_id: None,
    })
}

/// 枚举本机已安装的字体族（GDI EnumFontFamiliesEx），给前端的字体下拉框用
#[cfg(windows)]
#[tauri::command]
fn list_fonts() -> Vec<String> {
    use windows_sys::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn collect(
        logfont: *const LOGFONTW,
        _metric: *const TEXTMETRICW,
        _font_type: u32,
        param: isize,
    ) -> i32 {
        let list = &mut *(param as *mut Vec<String>);
        let raw = (*logfont).lfFaceName;
        let len = raw.iter().position(|c| *c == 0).unwrap_or(raw.len());
        let name = String::from_utf16_lossy(&raw[..len]);
        // 以 @ 开头的是竖排变体，跳过；重名只留一次
        let meaningful = name.chars().any(|c| c.is_alphanumeric());
        if meaningful && !name.starts_with('@') && !list.iter().any(|n| n == &name) {
            list.push(name);
        }
        1
    }

    let mut names: Vec<String> = Vec::new();
    unsafe {
        let hdc = GetDC(std::ptr::null_mut());
        if !hdc.is_null() {
            let mut lf: LOGFONTW = std::mem::zeroed();
            lf.lfCharSet = DEFAULT_CHARSET as u8;
            EnumFontFamiliesExW(
                hdc,
                &lf,
                Some(collect),
                &mut names as *mut Vec<String> as isize,
                0,
            );
            ReleaseDC(std::ptr::null_mut(), hdc);
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    names
}

#[cfg(not(windows))]
#[tauri::command]
fn list_fonts() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tauriview-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 双击同一个文件：书库里已有的副本必须被认出来（文件名即书 id）
    #[test]
    fn find_duplicate_matches_identical_copy_under_other_name() {
        let dir = scratch_dir("same");
        let outside = scratch_dir("same-src");
        let mut content = vec![0u8; 200 * 1024]; // 跨多个 64KB 块
        for (i, b) in content.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        let src = outside.join("源文件.epub");
        std::fs::write(&src, &content).unwrap();

        assert!(find_duplicate(&dir, &src, "epub").is_none(), "空书库不该命中");

        let copy = dir.join("book-a.epub");
        std::fs::write(&copy, &content).unwrap();
        let (id, path) = find_duplicate(&dir, &src, "epub").expect("同内容副本应命中");
        assert_eq!(id, "book-a");
        assert_eq!(path, copy);

        // 扩展名不同（封面、注释等）不参与比较
        std::fs::write(dir.join("book-b.pdf"), &content).unwrap();
        assert_eq!(find_duplicate(&dir, &src, "epub").unwrap().0, "book-a");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// 大小相同、内容不同：不能误认成同一本书
    #[test]
    fn find_duplicate_ignores_same_size_different_bytes() {
        let dir = scratch_dir("diff");
        let outside = scratch_dir("diff-src");
        let a = vec![7u8; 4096];
        let mut b = a.clone();
        b[0] = 8;
        let src = outside.join("source.pdf");
        std::fs::write(&src, &a).unwrap();
        std::fs::write(dir.join("other.pdf"), &b).unwrap();
        assert!(find_duplicate(&dir, &src, "pdf").is_none());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// 源文件自己躺在书库目录里时不算「副本」
    #[test]
    fn find_duplicate_never_returns_the_source_file_itself() {
        let dir = scratch_dir("self");
        let src = dir.join("book.epub");
        std::fs::write(&src, b"payload").unwrap();
        assert!(find_duplicate(&dir, &src, "epub").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 前缀相同但更短的文件不是同一本书
    #[test]
    fn same_content_rejects_prefix_and_trailing_bytes() {
        let dir = scratch_dir("prefix");
        let full = vec![3u8; 8192];
        let short = full[..4096].to_vec();
        let mut longer = full.clone();
        longer.push(3);
        let a = dir.join("a.epub");
        let b = dir.join("b.epub");
        let c = dir.join("c.epub");
        std::fs::write(&a, &full).unwrap();
        std::fs::write(&b, &short).unwrap();
        std::fs::write(&c, &longer).unwrap();
        assert!(!same_content(&a, &b));
        assert!(!same_content(&a, &c));
        assert!(same_content(&a, &a));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AiTasks::default())
        .manage(dictionary::DictionaryState::default())
        .manage(tts::TtsState::default())
        .manage(PendingFile::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // 第二次启动改为把已有窗口提到前台：WebView2 的 profile 只能被一个进程用，
        // 不拦的话新进程会因为 0x8007139F 静默退出，看起来就是「双击没反应」。
        // 顺带把双击那个文件的路径存下来，通知前端打开。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = first_book_arg(argv) {
                if let Some(state) = app.try_state::<PendingFile>() {
                    *state.0.lock().unwrap() = Some(path);
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("open-file", ());
            }
        }))
        .setup(|app| {
            // 首次启动就是双击文件进来的：存下路径，前端 boot 完再取
            if let Some(path) = first_book_arg(std::env::args()) {
                if let Some(state) = app.try_state::<PendingFile>() {
                    *state.0.lock().unwrap() = Some(path);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![library_dir, import_book, list_fonts, start_ai_request, cancel_ai_request, take_pending_file,
            obsidian::export_obsidian, obsidian::validate_obsidian_vault,
            dictionary::list_dictionaries, dictionary::lookup_dictionary, dictionary::import_dictionary, dictionary::set_dictionary_enabled,
            tts::tts_request])
        .build(tauri::generate_context!())
        .expect("TauriView 启动失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) { app.state::<tts::TtsState>().stop(); }
        });
}
