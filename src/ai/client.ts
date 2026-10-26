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

/** 服务端输出预算；达到上限视为未完成，不能静默裁掉回答。 */
export interface AiLimits { maxTokens?: number }

function checkFinishReason(reason?: string | null): void {
  if (reason === "length") throw new Error("回答达到输出上限，内容尚未完整，请重试。");
  if (reason && reason !== "stop") throw new Error("AI 输出未正常完成，请重试。");
}

/** SSE frames may span network chunks, including in the middle of UTF-8 characters. */
function aiStream(onUpdate: (text: string) => void) {
  let pending = "", content = "", finishReason: string | null = null, done = false;
  const frame = (event: string) => {
    if (done) return;
    const data = event.split(/\r\n|\n|\r/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") { done = true; return; }
    let value: any;
    try { value = JSON.parse(data); } catch { throw new Error("AI 流式响应格式错误，请重试。"); }
    if (value.error) throw new Error(value.error.message || "AI 接口返回错误，请重试。");
    const choice = value.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      content += delta; onUpdate(content);
    }
    if (choice?.finish_reason != null) finishReason = choice.finish_reason;
  };
  return {
    push(text: string) {
      pending += text;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending))) {
        frame(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
      }
    },
    get done() { return done; },
    finish() {
      if (pending.trim()) frame(pending);
      checkFinishReason(finishReason);
      if (!done && !finishReason) throw new Error("AI 输出中断，请重试。");
      return content;
    },
  };
}

export async function requestReadingAi(config: AiConfig, messages: ChatMessage[], signal: AbortSignal, onUpdate?: (text: string) => void, limits?: AiLimits): Promise<string> {
  const cfg = validateAiConfig(config);
  signal.throwIfAborted();
  const body = { model: cfg.model, messages, temperature: 0.3, max_tokens: limits?.maxTokens ?? 1500, ...(onUpdate ? { stream: true } : {}) };
  let content: unknown;
  if (isTauri) {
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    signal.throwIfAborted();
    const id = crypto.randomUUID();
    content = await new Promise<string>((resolve, reject) => {
      const result = new Channel<{ content?: string; error?: string; chunk?: number[]; done?: boolean; finishReason?: string }>();
      const stream = aiStream(text => onUpdate?.(text));
      const decoder = new TextDecoder();
      let started = false, settled = false;
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => {
        cleanup();
        if (started) void invoke("cancel_ai_request", { id }).catch(() => {});
        reject(new DOMException("已停止", "AbortError"));
      };
      result.onmessage = (message) => {
        if (signal.aborted || settled) return;
        try {
          if (message.error) throw new Error(message.error);
          if (message.chunk) {
            stream.push(decoder.decode(new Uint8Array(message.chunk), { stream: true }));
            // 收到 SSE 的结束标记后释放上游连接。
            if (stream.done) {
              settled = true; cleanup();
              void invoke("cancel_ai_request", { id }).catch(() => {});
              resolve(stream.finish());
            }
            return;
          }
          cleanup();
          settled = true;
          if (typeof message.content === "string") { onUpdate?.(message.content); checkFinishReason(message.finishReason); resolve(message.content); }
          else if (message.done) { stream.push(decoder.decode()); resolve(stream.finish()); }
          else resolve("");
        } catch (error) {
          settled = true;
          cleanup(); reject(error);
          void invoke("cancel_ai_request", { id }).catch(() => {});
        }
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
      if (onUpdate && response.headers?.get("content-type")?.includes("text/event-stream")) {
        if (!response.body) throw new Error("AI 接口没有返回输出流。");
        const reader = response.body.getReader(), decoder = new TextDecoder();
        const stream = aiStream(onUpdate);
        try {
          while (!stream.done) {
            const chunk = await reader.read();
            if (chunk.done) break;
            stream.push(decoder.decode(chunk.value, { stream: true }));
          }
          stream.push(decoder.decode());
          content = stream.finish();
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } else {
        const data = await response.json();
        content = data?.choices?.[0]?.message?.content;
        if (typeof content === "string") onUpdate?.(content);
        checkFinishReason(data?.choices?.[0]?.finish_reason);
      }
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
