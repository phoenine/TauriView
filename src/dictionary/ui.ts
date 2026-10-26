import { lookupDictionary, type DictionaryEntry } from "./client";
import { normalizeQuery, sectionText, type DictionarySnapshot } from "./stardict";
import { pinyinFromBopomofo } from "./pinyin";
import type { ReadingAnchor } from "../ai/context";
import { closeReadingAi, openReadingAi } from "../ai/ui";

export type { DictionarySnapshot } from "./stardict";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const box = $("dictionaryBox"), body = $("dictionaryBody"), pronunciation = $("dictionaryPronunciation");
const sources = $<HTMLSelectElement>("dictionarySource"), save = $<HTMLButtonElement>("dictionarySave");
let anchor: ReadingAnchor | null = null, entries: DictionaryEntry[] = [], selected = 0, revision = 0;
let saving = false;
const saved = new Set<number>();
let persist: ((selection: ReadingAnchor, snapshot: DictionarySnapshot) => Promise<void>) | null = null;

function snapshot(): DictionarySnapshot | null {
  const entry = entries[selected];
  if (!entry) return null;
  const reading = entry.sections.filter((s) => s.format === "phonetic").map(sectionText).join(" / ");
  // Imported dictionaries may use Bopomofo; retain the original reading alongside its transcription.
  const companion = entry.kind === "idiom" && !/[a-z]/i.test(reading)
    ? entries.filter((e) => e.kind === "chinese" && e.word === entry.word) : [];
  const transcribed = !/[a-z]/i.test(reading) ? pinyinFromBopomofo(reading) : null;
  const pinyin = transcribed ?? [...new Set(companion.flatMap((e) => e.sections.filter((s) => s.format === "phonetic").map(sectionText)).filter(Boolean))].join(" / ");
  return {
    word: entry.word, name: entry.dictionary, version: entry.version, source: entry.source,
    pronunciation: pinyin ? `${pinyin}\n${reading}` : reading,
    pronunciationSource: transcribed ? "原词条注音转写" : pinyin ? companion[0].dictionary : undefined,
    definition: entry.sections.filter((s) => s.format !== "phonetic").map(sectionText).filter(Boolean).join("\n\n"),
  };
}
function render(): void {
  const entry = snapshot();
  sources.hidden = entries.length < 2;
  sources.value = String(selected);
  sources.disabled = saving;
  $("dictionaryTerm").textContent = anchor ? normalizeQuery(anchor.text) : "词典";
  pronunciation.textContent = entry ? `${entry.word !== normalizeQuery(anchor!.text) ? entry.word + (entry.pronunciation ? " · " : "") : ""}${entry.pronunciation}` : "";
  pronunciation.hidden = !pronunciation.textContent;
  body.className = "ai-body dictionary-body";
  const [meaning, extra] = (entry?.definition ?? "").split("\n\n【扩展资料】\n");
  body.textContent = meaning || (entries.length ? "此词条仅包含暂不支持的音频或图片内容。" : "本地词典未收录此词，可使用 AI 结合原文理解。");
  const details = $<HTMLDetailsElement>("dictionaryDetails");
  details.hidden = !extra; details.open = false;
  $("dictionaryExtra").textContent = extra ?? "";
  $("dictionaryAttribution").textContent = entry ? `${entry.name}${entry.pronunciationSource ? " · 拼音：" + entry.pronunciationSource : ""}` : "";
  $("dictionaryAttribution").title = entry?.source ?? "";
  save.disabled = !entry || !entry.definition || saving || saved.has(selected);
  save.textContent = saving ? "补充中…" : saved.has(selected) ? "已补充" : "补充到批注";
}
export function closeDictionary(): void {
  ++revision; box.hidden = true; anchor = null; entries = []; saved.clear();
}
export async function openDictionary(selection: ReadingAnchor): Promise<void> {
  closeReadingAi(); closeDictionary();
  const current = ++revision;
  anchor = { ...selection }; selected = 0; saving = false;
  box.hidden = false; sources.hidden = true; pronunciation.hidden = true;
  $("dictionaryDetails").hidden = true;
  $("dictionaryTerm").textContent = normalizeQuery(selection.text);
  $("dictionaryAttribution").textContent = "";
  body.className = "ai-body loading"; body.textContent = "正在查词…";
  save.disabled = true;
  try {
    const result = await lookupDictionary(selection.text);
    if (current !== revision) return;
    entries = result;
    sources.replaceChildren();
    for (let index = 0; index < entries.length; index++) {
      const option = document.createElement("option");
      option.value = String(index);
      const reading = entries[index].sections.filter((s) => s.format === "phonetic").map(sectionText).join(" / ");
      option.textContent = `${entries[index].dictionary} · ${entries[index].word}${reading ? " · " + reading : ""}`;
      sources.appendChild(option);
    }
    render();
  } catch (error) {
    if (current !== revision) return;
    body.className = "ai-body error"; body.textContent = `查词失败：${(error as Error).message}`;
  }
}
export function initDictionary(saveNote: (selection: ReadingAnchor, snapshot: DictionarySnapshot) => Promise<void>, openSettings: () => void): void {
  persist = saveNote;
  $("dictionaryClose").addEventListener("click", closeDictionary);
  sources.addEventListener("change", () => { selected = Number(sources.value); render(); });
  $("dictionaryAi").addEventListener("click", () => {
    if (!anchor) return;
    const current = anchor, entry = snapshot();
    closeDictionary();
    openReadingAi({ ...current, dictionary: entry ? `${entry.word}\n${entry.pronunciation}\n${entry.definition}`.slice(0, 6000) : undefined });
  });
  $("dictionarySettings").addEventListener("click", () => { closeDictionary(); openSettings(); });
  save.addEventListener("click", async () => {
    const entry = snapshot(), current = anchor, token = revision, index = selected;
    if (!current || !entry || !persist || saving || saved.has(index)) return;
    saving = true; render();
    try {
      await persist(current, entry);
      if (token === revision) saved.add(index);
    } catch (error) {
      if (token === revision) { body.className = "ai-body error"; body.textContent = `保存失败：${(error as Error).message}`; }
    } finally { if (token === revision) { saving = false; sources.disabled = false; save.disabled = saved.has(index); save.textContent = saved.has(index) ? "已补充" : "补充到批注"; } }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !box.hidden) { event.preventDefault(); event.stopImmediatePropagation(); closeDictionary(); }
  }, true);
}
