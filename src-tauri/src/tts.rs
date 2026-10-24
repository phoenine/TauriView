use serde_json::{json, Value};
use std::{fs, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{mpsc, Arc, Mutex}, time::Duration};
use tauri::Manager;

struct Config { python: String, model: String }

struct Setup(Child);
impl Drop for Setup {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            #[cfg(windows)] {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill.exe").args(["/PID", &self.0.id().to_string(), "/T", "/F"])
                    .creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
            let _ = self.0.kill(); let _ = self.0.wait();
        }
    }
}

struct Worker { child: Child, input: ChildStdin, replies: mpsc::Receiver<Result<Value, String>>, sequence: u64 }
impl Drop for Worker {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
impl Worker {
    fn request(&mut self, request: Value) -> Result<Value, String> {
        self.sequence += 1;
        let mut line = serde_json::to_vec(&json!({"id": self.sequence, "request": request})).map_err(|e| e.to_string())?;
        if line.len() > 4 * 1024 * 1024 { return Err("听书请求过大".into()); }
        line.push(b'\n');
        self.input.write_all(&line).and_then(|_| self.input.flush()).map_err(|e| format!("语音进程已退出：{e}"))?;
        let response = self.replies.recv_timeout(Duration::from_secs(30)).map_err(|_| "语音服务未响应，请检查 tts/worker.log".to_string())??;
        if response["id"] != self.sequence { return Err("语音服务响应顺序异常".into()); }
        if let Some(error) = response["error"].as_str() { return Ok(json!({"error": error})); }
        Ok(response["result"].clone())
    }
}

#[derive(Default, Clone)]
pub struct TtsState { worker: Arc<Mutex<Option<Worker>>>, setup: Arc<Mutex<Option<Setup>>> }
impl TtsState {
    pub fn stop(&self) {
        if let Ok(mut worker) = self.worker.lock() { worker.take(); }
        if let Ok(mut setup) = self.setup.lock() { setup.take(); }
    }
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("tts");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn config(root: &std::path::Path) -> Result<Config, String> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(".local-tts");
    let development_python = dev.join("fast-venv").join(if cfg!(windows) {"Scripts/python.exe"} else {"bin/python"});
    let managed_python = root.join("runtime/Scripts/python.exe");
    let model = dev.join("models/Qwen3-TTS-12Hz-0.6B-CustomVoice");
    Ok(Config {
        python: if root.join("runtime/ready.json").is_file() && managed_python.is_file() { managed_python.to_string_lossy().into() }
            else if cfg!(debug_assertions) && development_python.is_file() { development_python.to_string_lossy().into() } else { String::new() },
        model: if cfg!(debug_assertions) && model.is_dir() && !root.join("models/Qwen3-TTS-12Hz-0.6B-CustomVoice/config.json").exists() { model.to_string_lossy().into() }
            else { root.join("models/Qwen3-TTS-12Hz-0.6B-CustomVoice").to_string_lossy().into() },
    })
}
fn resource(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/tts").join(name);
    if cfg!(debug_assertions) && development.is_file() { Ok(development) }
    else { Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("tts").join(name)) }
}
fn configuration(root: &std::path::Path, state: &TtsState) -> Result<Value, String> {
    let cfg = config(root)?;
    let available = PathBuf::from(&cfg.python).is_file();
    let mut setup = state.setup.lock().map_err(|e| e.to_string())?;
    let running = if let Some(process) = setup.as_mut() { process.0.try_wait().map_err(|e| e.to_string())?.is_none() } else { false };
    if !running { setup.take(); }
    let progress: Value = fs::read(root.join("setup-status.json")).ok().and_then(|data| serde_json::from_slice(&data).ok()).unwrap_or(json!({}));
    let status = if available { "ready" } else if running { "installing" } else if progress["status"] == "error" { "error" } else { "missing" };
    Ok(json!({"available": available, "installStatus": status, "installMessage": if status == "ready" { "" } else { progress["message"].as_str().unwrap_or("") }}))
}
fn spawn(app: &tauri::AppHandle, root: &std::path::Path, config: &Config) -> Result<Worker, String> {
    if !PathBuf::from(&config.python).is_file() { return Err("本地语音组件尚未准备，请在听书设置中点击「下载并准备」。".into()); }
    let script = resource(app, "worker.py")?;
    let log = fs::OpenOptions::new().create(true).append(true).open(root.join("worker.log")).map_err(|e| e.to_string())?;
    let mut command = Command::new(&config.python);
    command.arg("-u").arg(script).arg("--root").arg(root).arg("--model").arg(&config.model)
        .env("PYTHONUTF8", "1").env("PYTHONNOUSERSITE", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|e| format!("无法启动本地语音环境：{e}"))?;
    let input = child.stdin.take().ok_or("语音服务输入不可用")?;
    let output = child.stdout.take().ok_or("语音服务输出不可用")?;
    let (send, replies) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let value = line.map_err(|e| e.to_string()).and_then(|line| serde_json::from_str(&line).map_err(|e| format!("语音服务协议错误：{e}")));
            if send.send(value).is_err() { break; }
        }
    });
    Ok(Worker { child, input, replies, sequence: 0 })
}

#[tauri::command]
pub async fn tts_request(app: tauri::AppHandle, state: tauri::State<'_, TtsState>, request: Value) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&app)?;
        let action = request["action"].as_str().ok_or("缺少听书操作")?;
        if action == "config" {
            return configuration(&root, &state);
        }
        if action == "install_runtime" {
            if !cfg!(windows) { return Err("自动准备语音组件目前支持 Windows x64。".into()); }
            if configuration(&root, &state)?["available"] == true { return configuration(&root, &state); }
            {
                let mut setup = state.setup.lock().map_err(|e| e.to_string())?;
                if setup.is_none() {
                    fs::write(root.join("setup-status.json"), br#"{"status":"installing","message":"Preparing voice components..."}"#).map_err(|e| e.to_string())?;
                    let log = fs::OpenOptions::new().create(true).append(true).open(root.join("setup.log")).map_err(|e| e.to_string())?;
                    let mut command = Command::new("powershell.exe");
                    command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                        .arg(resource(&app, "setup.ps1")?).arg("-Root").arg(&root).stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log);
                    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
                    *setup = Some(Setup(command.spawn().map_err(|e| format!("无法准备语音组件：{e}"))?));
                }
            }
            return configuration(&root, &state);
        }
        // 关闭听书：结束 python 进程，显存与 GPU 占用随之释放
        if action == "shutdown" {
            state.stop();
            return Ok(json!({ "ok": true }));
        }
        let mut worker = state.worker.lock().map_err(|e| e.to_string())?;
        if worker.is_none() { *worker = Some(spawn(&app, &root, &config(&root)?)?); }
        let reply = worker.as_mut().unwrap().request(request);
        if reply.is_err() { worker.take(); }
        reply
    }).await.map_err(|e| e.to_string())?
}
