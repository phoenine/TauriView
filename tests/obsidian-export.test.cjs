const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

function setup(native, configured) {
  const calls = [], saved = new Map();
  if (configured !== undefined) saved.set('tauriview.obsidian-vault', configured);
  const context = vm.createContext({ exports: {}, calls, localStorage: {
    getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value),
  },
  mockInvoke: async (command, args) => { calls.push({ command, args }); return { books: 1, cards: 1, skipped: 2 }; } });
  const source = fs.readFileSync(path.join(__dirname, '../src/obsidian-export.ts'), 'utf8')
    .replace('import { isTauri } from "./platform";', `const isTauri = ${native};`)
    .replace('await import("@tauri-apps/plugin-dialog")', '({ open: picker })')
    .replaceAll('await import("@tauri-apps/api/core")', '({ invoke: mockInvoke })');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, context);
  return { run: context.exports.exportToObsidian, save: context.exports.saveObsidianVault,
    get: context.exports.getObsidianVault, calls, saved };
}
const groups = [{ book: { id: 'book', title: '测试书', author: '作者', addedAt: 1793232000000 },
  items: [{ id: 'card', text: '原文\n"引号"', note: '**批注**\n第二行', chapter: 'chapter.xhtml',
    cfi: 'epubcfi(/6/2)', createdAt: 1793232000000, percent: 0.5 }] }];

test('exports selected annotations directly to the configured vault without a picker', async () => {
  const { run, calls, saved } = setup(true, 'C:\\Reading');
  const message = await run(groups, () => '第一章 › 小节');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'export_obsidian');
  assert.equal(calls[0].args.vault, 'C:\\Reading');
  const payload = calls[0].args.groups[0];
  assert.equal(payload.title, '测试书');
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].quote, '原文\n"引号"');
  assert.equal(payload.items[0].insight, '**批注**\n第二行');
  assert.equal(payload.items[0].chapter, '第一章 › 小节');
  assert.equal(payload.items[0].cfi, 'epubcfi(/6/2)');
  const stamp = new Date(groups[0].items[0].createdAt);
  const expectedStamp = [stamp.getFullYear(), stamp.getMonth() + 1, stamp.getDate(), stamp.getHours(), stamp.getMinutes(), stamp.getSeconds()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-');
  assert.equal(payload.items[0].fileStamp, expectedStamp);
  assert.equal(saved.get('tauriview.obsidian-vault'), 'C:\\Reading');
  assert.match(message, /跳过 2 张已有卡片/);
});

test('empty path, empty results and browser mode never invoke file export', async () => {
  const unconfigured = setup(true, '');
  await assert.rejects(unconfigured.run(groups, () => ''), /设置 → 导出/);
  assert.equal(unconfigured.calls.length, 0);
  const empty = setup(true, 'C:\\Reading');
  await assert.rejects(empty.run([], () => ''), /没有可导出/);
  assert.equal(empty.calls.length, 0);
  const web = setup(false, 'C:\\Reading');
  await assert.rejects(web.run(groups, () => ''), /桌面应用/);
  assert.equal(web.calls.length, 0);
});

test('settings validate and persist the path, retaining the prior value on invalid input', async () => {
  const config = setup(true);
  assert.equal(config.get(), 'C:\\Users\\spark\\Reading');
  assert.equal(await config.save('  "D:\\My Vault"  '), 'D:\\My Vault');
  assert.equal(config.calls[0].command, 'validate_obsidian_vault');
  assert.equal(config.calls[0].args.vault, 'D:\\My Vault');
  assert.equal(config.get(), 'D:\\My Vault');
  await assert.rejects(config.save('relative/folder'), /完整的文件夹路径/);
  await assert.rejects(config.save('  '), /选择或填写/);
  assert.equal(config.get(), 'D:\\My Vault');
});
