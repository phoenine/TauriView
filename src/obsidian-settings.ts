import { isTauri } from "./platform";
import { getObsidianVault, saveObsidianVault } from "./obsidian-export";

export function initObsidianSettings(): void {
  const input = document.querySelector<HTMLInputElement>("#setObsidianPath")!;
  const browse = document.querySelector<HTMLButtonElement>("#setObsidianBrowse")!;
  const save = document.querySelector<HTMLButtonElement>("#setObsidianSave")!;
  const status = document.querySelector<HTMLElement>("#setObsidianStatus")!;
  input.value = getObsidianVault();
  status.textContent = "批注将保存到上方文件夹，可随时更改。";
  let busy = false;
  const feedback = (message: string, error = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", error);
  };
  const persist = async () => {
    if (busy) return;
    busy = true;
    input.disabled = browse.disabled = save.disabled = true;
    feedback("正在检查文件夹…");
    try {
      input.value = await saveObsidianVault(input.value);
      feedback("已保存。批注页将直接导出到此文件夹。");
    } catch (error) {
      feedback(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      input.disabled = browse.disabled = save.disabled = false;
    }
  };
  input.addEventListener("input", () => feedback("路径已修改，点击保存后生效。"));
  input.addEventListener("keydown", event => { if (event.key === "Enter") void persist(); });
  save.addEventListener("click", () => void persist());
  browse.addEventListener("click", async () => {
    if (busy) return;
    if (!isTauri) { feedback("请在桌面应用中选择文件夹，也可以直接填写路径。", true); return; }
    browse.disabled = true;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ title: "选择 Obsidian 仓库文件夹", directory: true, multiple: false,
        defaultPath: input.value.trim() || getObsidianVault() || undefined });
      if (typeof picked === "string") {
        input.value = picked;
        await persist();
      }
    } catch (error) { feedback(error instanceof Error ? error.message : String(error), true); }
    finally { browse.disabled = false; }
  });
}
