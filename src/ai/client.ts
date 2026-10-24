import { isTauri } from "../platform";
import type { ChatMessage } from "./context";

export interface AiConfig { base: string; key: string; model: string }
const DEFAULT: AiConfig = { base: "https://api.deepseek.com/v1", key: "", model: "deepseek-chat" };
let sessionConfig: AiConfig | undefined;

export function loadAiConfig(): AiConfig {
  if (sessionConfig) return { ...sessionConfig };
  try {
    return Object.fromEntries(Object.entries(DEFAULT).map(([key, value]) => [key, localStorage.getItem(`tauriview.ai.${key}`) ?? value])) as unknown as AiConfig;
  } catch { return { ...DEFAULT }; }
}
export function validateAiConfig(config: AiConfig): AiConfig {
  const base = config.base.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("请输入有效的接口地址。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("接口地址需为 HTTP(S) 地址，不能包含密码、查询参数或片段。");
  }
  if (!config.model.trim()) throw new Error("请填写模型名称。");
  return { base, model: config.model.trim(), key: config.key.trim() };
}
export function saveAiConfig(config: AiConfig): boolean {
  sessionConfig = validateAiConfig(config);
  try {
    for (const [key, value] of Object.entries(sessionConfig)) localStorage.setItem(`tauriview.ai.${key}`, value);
    return true;
  } catch { return false; }
}

export async function requestReadingAi(config: AiConfig, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  const cfg = validateAiConfig(config);
  signal.throwIfAborted();
  const body = { model: cfg.model, messages, temperature: 0.3, max_tokens: 1500 };
  let content: unknown;
  if (isTauri) {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    content = await new Promise<string>((resolve, reject) => {
      const result = new Channel<{ content?: string; error?: string }>();
      let started = false;
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => {
        cleanup();
        if (started) void invoke("cancel_ai_request", { id }).catch(() => {});
        reject(new DOMException("已停止", "AbortError"));
      };
      result.onmessage = (message) => {
        cleanup();
        if (signal.aborted) return;
        if (message.error) reject(new Error(message.error));
        else resolve(message.content ?? "");
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void invoke("start_ai_request", { id, base: cfg.base, key: cfg.key, body, result }).then(() => {
        started = true;
        if (signal.aborted) void invoke("cancel_ai_request", { id }).catch(() => {});
      }, (error) => { cleanup(); reject(new Error(String(error))); });
    });
  } else {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(abort, 120000);
    try {
      const response = await fetch(`${cfg.base}/chat/completions`, {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}：请检查接口地址、模型、Key 或额度。`);
      const data = await response.json();
      content = data?.choices?.[0]?.message?.content;
    } catch (error) {
      if (controller.signal.aborted && !signal.aborted) throw new Error("AI 请求超时，请重试。");
      throw error;
    } finally {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  signal.throwIfAborted();
  if (typeof content !== "string" || !content.trim()) throw new Error("接口没有返回正文，请检查模型是否支持对话。");
  return content.trim();
}
