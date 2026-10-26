use tauri::Manager;
mod dictionary;
mod tts;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

type AiTasks = Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>;

#[derive(serde::Serialize, Clone)]
struct AiReply {
    content: Option<String>,
    error: Option<String>,
    chunk: Option<Vec<u8>>,
    done: bool,
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
        let response: Result<Option<String>, String> = async {
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
                    result.send(AiReply { content: None, error: None, chunk: Some(chunk.to_vec()), done: false })
                        .map_err(|_| "AI 窗口已关闭".to_string())?;
                }
                return Ok(None);
            }
            let data: serde_json::Value = response.json().await.map_err(|_| "接口返回的内容不是 JSON".to_string())?;
            data["choices"][0]["message"]["content"].as_str()
                .filter(|s| !s.trim().is_empty()).map(|s| Some(s.to_string()))
                .ok_or_else(|| "接口没有返回正文，请检查模型是否支持对话".to_string())
        }.await;
        let reply = match response {
            Ok(content) => AiReply { content, error: None, chunk: None, done: true },
            Err(error) => AiReply { content: None, error: Some(error), chunk: None, done: true },
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

    let dest = dir.join(format!("{id}.{ext}"));
    std::fs::copy(&src_path, &dest).map_err(|e| format!("复制失败：{e}"))?;

    let meta = std::fs::metadata(&dest).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(ImportedFile {
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
        mtime,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AiTasks::default())
        .manage(dictionary::DictionaryState::default())
        .manage(tts::TtsState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![library_dir, import_book, list_fonts, start_ai_request, cancel_ai_request,
            dictionary::list_dictionaries, dictionary::lookup_dictionary, dictionary::import_dictionary, dictionary::set_dictionary_enabled,
            tts::tts_request])
        .build(tauri::generate_context!())
        .expect("TauriView 启动失败")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) { app.state::<tts::TtsState>().stop(); }
        });
}
