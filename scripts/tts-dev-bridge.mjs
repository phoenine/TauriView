import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// Development only. Production uses the same Python protocol through Tauri IPC.
export function devListening() {
  let root = join(process.cwd(), '.local-tts', 'dev-tts');
  let child, setup, pending = new Map(), sequence = 0, chain = Promise.resolve();
  const config = () => {
    const model = join(process.cwd(), '.local-tts/models/Qwen3-TTS-12Hz-0.6B-CustomVoice');
    const managedPython = join(root, 'runtime/Scripts/python.exe');
    return { python: existsSync(managedPython) && existsSync(join(root, 'runtime/ready.json')) ? managedPython : join(process.cwd(), '.local-tts/fast-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
      model: existsSync(model) && !existsSync(join(root, 'models/Qwen3-TTS-12Hz-0.6B-CustomVoice/config.json')) ? model : join(root, 'models/Qwen3-TTS-12Hz-0.6B-CustomVoice') };
  };
  const configuration = () => {
    const available = existsSync(config().python);
    let progress = {};
    try { progress = JSON.parse(readFileSync(join(root, 'setup-status.json'), 'utf8')); } catch {}
    return { available, installStatus: available ? 'ready' : setup ? 'installing' : progress.status === 'error' ? 'error' : 'missing', installMessage: available ? '' : progress.message || '' };
  };
  const stopSetup = () => {
    if (!setup) return;
    const previous = setup; setup = null;
    if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(previous.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else previous.kill();
  };
  const stop = () => {
    const previous = child; child = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('本地语音服务已停止')); }
    pending.clear();
    if (previous) { previous.stdin.end(); previous.kill(); }
  };
  const start = () => {
    const cfg = config();
    if (!existsSync(cfg.python)) throw Error('本地语音组件尚未准备，请在听书设置中点击「下载并准备」。');
    mkdirSync(root, { recursive: true });
    const fd = openSync(join(root, 'worker.log'), 'a');
    const processChild = spawn(cfg.python, ['-u', join(process.cwd(), 'resources/tts/worker.py'), '--root', root, '--model', cfg.model],
      { windowsHide: true, stdio: ['pipe', 'pipe', fd], env: { ...process.env, PYTHONUTF8: '1', PYTHONNOUSERSITE: '1' } });
    closeSync(fd); child = processChild;
    processChild.on('error', () => { if (child === processChild) stop(); });
    processChild.on('exit', () => { if (child === processChild) stop(); });
    processChild.stdin.on('error', () => {});
    createInterface({ input: processChild.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line), entry = pending.get(message.id);
        if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(Error(message.error)) : entry.resolve(message.result); }
      } catch { if (child === processChild) stop(); }
    });
  };
  async function request(body) {
    if (body.action === 'config') return configuration();
    if (body.action === 'install_runtime') {
      if (process.platform !== 'win32') throw Error('自动准备语音组件目前支持 Windows x64。');
      if (configuration().available || setup) return configuration();
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'setup-status.json'), JSON.stringify({ status: 'installing', message: '正在准备语音组件…' }));
      const fd = openSync(join(root, 'setup.log'), 'a');
      const installer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(process.cwd(), 'resources/tts/setup.ps1'), '-Root', root], { windowsHide: true, stdio: ['ignore', fd, fd] });
      closeSync(fd); setup = installer;
      installer.on('exit', () => { if (setup === installer) setup = null; });
      installer.on('error', error => { setup = null; writeFileSync(join(root, 'setup-status.json'), JSON.stringify({ status: 'error', message: error.message })); });
      return configuration();
    }
    if (!child) start();
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { reject(Error('语音服务未响应，请检查 .local-tts/dev-tts/worker.log')); stop(); }, 30000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, request: body }) + '\n');
    });
  }
  return { name: 'tauriview-dev-listening', apply: 'serve', configureServer(server) {
    if (server.config.server.port !== 5183) root += '-' + server.config.server.port;
    server.httpServer?.once('close', () => { stop(); stopSetup(); });
    server.middlewares.use('/__tts', (req, res) => {
      if (req.method !== 'POST' || !String(req.headers['content-type']).startsWith('application/json') ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(String(req.headers.host).split(':')[0]) ||
          (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) { res.statusCode = 403; res.end(); return; }
      let body = '', size = 0;
      req.on('data', (chunk) => { size += chunk.length; if (size > 4 * 1024 * 1024) { res.statusCode = 413; res.end(); req.destroy(); } else body += chunk; });
      req.on('end', () => {
        const run = async () => {
          try { const result = await request(JSON.parse(body)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result)); }
          catch (error) { res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: String(error.message || error) })); }
        };
        chain = chain.then(run, run);
      });
    });
  } };
}
