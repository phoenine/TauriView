import { buildReadingMessages, type ChatMessage, type ReadingAnchor } from "./context";
import { loadAiConfig, requestReadingAi } from "./client";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const box = $("aiBox"), body = $("aiBody");
const example = $<HTMLButtonElement>("aiExample"), toNote = $<HTMLButtonElement>("aiToNote");
let anchor: ReadingAnchor | null = null;
let history: ChatMessage[] = [];
let answer = "";
let lastQuestion = "";
let request: AbortController | null = null;
let version = 0;
let saving = false;
const savedAnswers = new Set<string>();
let saveNote: ((anchor: ReadingAnchor, answer: string) => Promise<void>) | null = null;
const EXPLAIN = "结合上下文，用一两段话直接解释选区在这里的含义；术语用通俗语言说明，不需要标题或重复原文。";

function busy(): void {
  box.setAttribute("aria-busy", String(!!request));
  example.disabled = !!request || !answer || saving;
  toNote.disabled = !!request || !answer || saving || savedAnswers.has(answer);
  toNote.textContent = saving ? "补充中…" : savedAnswers.has(answer) ? "已补充" : "补充到批注";
}
function renderAnswer(text: string): void {
  body.className = "ai-body";
  body.replaceChildren();
  // 只支持重点加粗，不把模型输出作为 HTML 执行。
  for (const part of text.split(/(\*\*[^*\n]+\*\*)/g)) {
    if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      body.appendChild(strong);
    } else body.appendChild(document.createTextNode(part));
  }
  body.scrollTop = 0;
}
function cancel(): void {
  ++version;
  request?.abort();
  request = null;
  busy();
}
export function closeReadingAi(): void {
  cancel(); box.hidden = true; anchor = null;
  history = []; answer = ""; lastQuestion = ""; savedAnswers.clear();
}
export function openReadingAi(selection: ReadingAnchor): void {
  closeReadingAi();
  anchor = { ...selection, passage: selection.passage ? { ...selection.passage } : undefined };
  saving = false; box.hidden = false;
  $("aiTerm").textContent = selection.text;
  $("aiTerm").title = selection.text;
  $("aiRetry").hidden = true; $("aiConfigure").hidden = true;
  example.hidden = false; toNote.hidden = false; busy();
  const cfg = loadAiConfig();
  if (!cfg.key && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i.test(cfg.base)) {
    body.className = "ai-body";
    body.textContent = "请先在设置中配置 AI 接口。";
    example.hidden = true; toNote.hidden = true; $("aiConfigure").hidden = false;
  } else void ask(EXPLAIN);
}
async function ask(text: string): Promise<void> {
  if (!anchor) return;
  cancel();
  const current = anchor, token = version;
  const controller = new AbortController();
  request = controller; lastQuestion = text; answer = "";
  $("aiRetry").hidden = true;
  body.className = "ai-body loading";
  body.textContent = text === EXPLAIN ? "正在理解…" : "正在举例…";
  busy();
  try {
    const messages = buildReadingMessages(current, "nearby", history, text);
    const output = await requestReadingAi(loadAiConfig(), messages, controller.signal);
    if (version !== token || current !== anchor) return;
    history.push({ role: "user", content: text }, { role: "assistant", content: output });
    answer = output; renderAnswer(output);
  } catch (error) {
    if (version !== token || controller.signal.aborted) return;
    body.className = "ai-body error";
    body.textContent = `理解失败：${(error as Error).message || String(error)}`;
    $("aiRetry").hidden = false;
  } finally {
    if (version === token) { request = null; busy(); }
  }
}
export function initReadingAi(save: (selection: ReadingAnchor, output: string) => Promise<void>, openSettings: () => void): void {
  saveNote = save;
  $("aiClose").addEventListener("click", closeReadingAi);
  $("aiConfigure").addEventListener("click", () => { closeReadingAi(); openSettings(); });
  example.addEventListener("click", () => void ask("用一个简短、生活化的自拟例子说明选区的含义，并点明它与原文的对应关系。"));
  $("aiRetry").addEventListener("click", () => void ask(lastQuestion || EXPLAIN));
  toNote.addEventListener("click", async () => {
    if (!anchor || !answer || saving || savedAnswers.has(answer) || !saveNote) return;
    const current = anchor, output = answer;
    saving = true; busy();
    try {
      await saveNote(current, output);
      if (current === anchor) savedAnswers.add(output);
    } catch (error) {
      if (current === anchor) { body.className = "ai-body error"; body.textContent = `保存失败：${(error as Error).message}`; }
    } finally {
      if (current === anchor) { saving = false; busy(); }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !box.hidden) {
      event.preventDefault(); event.stopImmediatePropagation(); closeReadingAi();
    }
  }, true);
}
