import { defineConfig } from "vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { devListening } from "./scripts/tts-dev-bridge.mjs";

/**
 * 词典文件只作为 Tauri resources 打包（Rust 侧从 resource_dir 读），
 * 不再放进 public/ —— 否则 Vite 会打进 dist、再被嵌进 exe，等于同一份
 * 24 MB 数据装两遍。这里只给 dev 模式补一个静态转发，让浏览器的
 * 回退路径仍然能 fetch('/dictionaries/...')。
 */
function devDictionaries() {
  const root = join(process.cwd(), "resources", "dictionaries");
  const types: Record<string, string> = {
    ".json": "application/json",
    ".ifo": "text/plain; charset=utf-8",
    ".syn": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".gz": "application/gzip",
    ".dz": "application/octet-stream",
  };
  return {
    name: "tauriview-dev-dictionaries",
    apply: "serve" as const,
    configureServer(server: any) {
      server.middlewares.use("/dictionaries", (req: any, res: any, next: () => void) => {
        const rel = normalize(decodeURIComponent(String(req.url ?? "").split("?")[0])).replace(/^([/\\.]+)/, "");
        const file = join(root, rel);
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
        res.setHeader("Content-Length", String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [devDictionaries(), devListening()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // 不能监听 Rust 构建产物：target/ 里有被编译器占用的 .exe，
      // 监听会抛 EBUSY 并让 vite 整个退出（顺带杀掉 tauri dev）
      ignored: [
        "**/src-tauri/**",
        "**/dist/**",
        "**/.archify/**",
        "**/node_modules/**",
        "**/.local-tts/**",
      ],
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
