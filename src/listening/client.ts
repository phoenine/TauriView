import { isTauri } from '../platform';

export async function listeningRequest<T = any>(request: Record<string, unknown>): Promise<T> {
  let result: any;
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    result = await invoke('tts_request', { request });
  } else {
    if (!(import.meta as ImportMeta & { env: { DEV: boolean } }).env.DEV) throw new Error('本地听书需要桌面版运行环境。');
    const reply = await fetch('/__tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    result = await reply.json();
    if (!reply.ok && !result.error) throw new Error('本地语音服务不可用');
  }
  if (result?.error) throw new Error(result.error);
  return result;
}
