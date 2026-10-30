import type { BookMeta, Highlight } from "./storage";
import { isTauri } from "./platform";

export interface ExportGroup {
  book: BookMeta;
  items: Highlight[];
}

const VAULT_KEY = "tauriview.obsidian-vault";
const DEFAULT_VAULT = "C:\\Users\\spark\\Reading";

export function getObsidianVault(): string {
  return localStorage.getItem(VAULT_KEY) ?? DEFAULT_VAULT;
}

export async function saveObsidianVault(value: string): Promise<string> {
  const vault = value.trim().replace(/^"(.*)"$/, "$1");
  if (!vault) throw new Error("请选择或填写 Obsidian 仓库文件夹。");
  if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(vault)) throw new Error("请填写完整的文件夹路径。");
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("validate_obsidian_vault", { vault });
  }
  localStorage.setItem(VAULT_KEY, vault);
  return vault;
}

/** Export exactly the collected filter snapshot to the configured vault. */
export async function exportToObsidian(
  groups: ExportGroup[], chapterLabel: (book: BookMeta, item: Highlight) => string,
): Promise<string | null> {
  if (!groups.length) throw new Error("当前筛选下没有可导出的批注。");
  if (!isTauri) throw new Error("请在 TauriView 桌面应用中导出到 Obsidian。");
  const vault = getObsidianVault().trim();
  if (!vault) throw new Error("请先在「设置 → 导出」中配置 Obsidian 仓库文件夹。");
  const date = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  };
  const fileStamp = (ts: number) => {
    const d = new Date(ts);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0")).join("-");
  };
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<{ books: number; cards: number; skipped: number }>("export_obsidian", {
    vault,
    groups: groups.map(({ book, items }) => ({
      id: book.id, title: book.title, author: book.author, created: date(book.addedAt),
      items: items.map(a => ({
        id: a.id, quote: a.text, insight: a.note || "", chapter: chapterLabel(book, a),
        created: date(a.createdAt), fileStamp: fileStamp(a.createdAt), cfi: a.cfi, percent: a.percent ?? 0,
      })),
    })),
  });
  return `新增 ${result.cards} 张卡片 · 新建 ${result.books} 本书籍 · 跳过 ${result.skipped} 张已有卡片\n${vault}`;
}
