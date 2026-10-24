/** 运行环境判定：同一份前端代码要在浏览器 dev 与 Tauri 外壳里都能跑 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
