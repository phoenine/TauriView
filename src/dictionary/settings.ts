import { isTauri } from "../platform";
import { listDictionaries, setDictionaryEnabled, importNativeDictionary, importBrowserDictionary, type DictionaryKind } from "./client";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const kinds: Record<DictionaryKind, string> = { english: "英文", chinese: "汉语", idiom: "成语" };
let wired = false;
export async function refreshDictionarySettings(): Promise<void> {
  const list = $("dictionaryPacks"), status = $("dictionaryPackStatus");
  status.textContent = "正在读取词典…";
  try {
    const packs = await listDictionaries();
    list.replaceChildren();
    for (const pack of packs) {
      const row = document.createElement("div"); row.className = "sp-row";
      const content = document.createElement("div"); content.className = "sp-text";
      const label = document.createElement("div"); label.className = "sp-label"; label.textContent = pack.name;
      const description = document.createElement("div"); description.className = "sp-desc";
      description.textContent = `${kinds[pack.kind]} · ${pack.count.toLocaleString()} 条${pack.version ? " · " + pack.version : ""}${pack.builtin ? " · 内置" : ""}`;
      content.append(label, description);
      const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "sp-switch";
      toggle.setAttribute("aria-label", `${pack.enabled ? "停用" : "启用"}${pack.name}`);
      toggle.setAttribute("aria-pressed", String(pack.enabled)); toggle.appendChild(document.createElement("i"));
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try { await setDictionaryEnabled(pack.id, !pack.enabled); await refreshDictionarySettings(); }
        catch (error) { status.textContent = (error as Error).message; toggle.disabled = false; }
      });
      row.append(content, toggle); list.appendChild(row);
    }
    status.textContent = "词典查询完全离线。导入 StarDict 时，先解压词典包，再选择 .ifo 文件及配套文件。";
  } catch (error) { status.textContent = `读取失败：${(error as Error).message}`; }
}
export function initDictionarySettings(): void {
  if (wired) return; wired = true;
  const button = $<HTMLButtonElement>("dictionaryImport"), picker = $<HTMLInputElement>("dictionaryFiles"), status = $("dictionaryPackStatus");
  button.addEventListener("click", async () => {
    if (!isTauri) { picker.click(); return; }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, title: "选择 StarDict 的 .ifo 文件", filters: [{ name: "StarDict", extensions: ["ifo"] }] });
    if (!path || Array.isArray(path)) return;
    button.disabled = true; status.textContent = "正在导入并校验词典…";
    try { await importNativeDictionary(path, $<HTMLSelectElement>("dictionaryImportKind").value as DictionaryKind); await refreshDictionarySettings(); }
    catch (error) { status.textContent = `导入失败：${(error as Error).message}`; }
    finally { button.disabled = false; }
  });
  picker.addEventListener("change", async () => {
    if (!picker.files?.length) return;
    button.disabled = true; status.textContent = "正在导入并校验词典…";
    try { await importBrowserDictionary(picker.files, $<HTMLSelectElement>("dictionaryImportKind").value as DictionaryKind); await refreshDictionarySettings(); }
    catch (error) { status.textContent = `导入失败：${(error as Error).message}`; }
    finally { picker.value = ""; button.disabled = false; }
  });
}
