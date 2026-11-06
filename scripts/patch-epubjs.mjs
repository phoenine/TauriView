// epub.js 0.3.93（项目最后一版）对「目录文件」的处理有两个坑，都会让书永远打不开：
//
// 1) Navigation.parse 只认 XML Document。目录文件扩展名不是 .xhtml/.html/.ncx 时
//    （Kindle 漫画常见 xml/vol.nav，内容其实是 NCX），archive 按纯文本返回字符串，
//    parse 会走进 load(string) 触发 "string.map is not a function"。
// 2) 这个异常发生在 Book.loadNavigation 的 Promise 链里，被内部吞掉，
//    book.ready 永远不落定 —— 表现就是「点了没反应，界面既没内容也没报错」。
//
// 补丁：字符串先自己 DOMParser 一次；目录解析失败就退化为空目录，不让整本书挂掉。
// postinstall 执行，可重复运行。
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MARK = "/* tv: nav guard */";
const NAV = path.join("node_modules", "epubjs", "src", "navigation.js");
const BOOK = path.join("node_modules", "epubjs", "src", "book.js");

if (!existsSync(NAV) || !existsSync(BOOK)) {
  console.log("[patch-epubjs] 没找到 epubjs（跳过）");
  process.exit(0);
}

let nav = await readFile(NAV, "utf8");
if (nav.includes(MARK)) {
  console.log("[patch-epubjs] 已打过补丁");
  process.exit(0);
}

const navAnchor = "\tparse(xml) {\n\t\tlet isXml = xml.nodeType;";
if (!nav.includes(navAnchor)) {
  console.error("[patch-epubjs] navigation.js 结构与预期不符，未打补丁");
  process.exit(1);
}
nav = nav.replace(
  navAnchor,
  "\tparse(xml) {\n" +
    "\t\t" + MARK + "\n" +
    "\t\tif (typeof xml === \"string\") {\n" +
    "\t\t\tconst doc = new DOMParser().parseFromString(xml, \"text/xml\");\n" +
    "\t\t\tif (doc && doc.documentElement && doc.documentElement.nodeName !== \"parsererror\") xml = doc;\n" +
    "\t\t}\n" +
    "\t\tlet isXml = xml && xml.nodeType;",
);

let book = await readFile(BOOK, "utf8");
const bookAnchor = `\t\treturn this.load(navPath, "xml")
\t\t\t.then((xml) => {
\t\t\t\tthis.navigation = new Navigation(xml);
\t\t\t\tthis.pageList = new PageList(xml);
\t\t\t\treturn this.navigation;
\t\t\t});`;
if (!book.includes(bookAnchor)) {
  console.error("[patch-epubjs] book.js 结构与预期不符，未打补丁");
  process.exit(1);
}
const bookPatched = `\t\treturn this.load(navPath, "xml")
\t\t\t.then((xml) => {
\t\t\t\ttry {
\t\t\t\t\tthis.navigation = new Navigation(xml);
\t\t\t\t\tthis.pageList = new PageList(xml);
\t\t\t\t} catch (error) {
\t\t\t\t\t// 目录坏了不该连累正文：退化成空目录，书照常打开
\t\t\t\t\tconsole.warn("[epubjs] 目录解析失败，已忽略：" + (error && error.message));
\t\t\t\t\tthis.navigation = new Navigation();
\t\t\t\t\tthis.pageList = new PageList();
\t\t\t\t}
\t\t\t\treturn this.navigation;
\t\t\t});`;

await writeFile(NAV, nav);
await writeFile(BOOK, book.replace(bookAnchor, bookPatched));
console.log("[patch-epubjs] 目录解析已加保护（Navigation.parse 支持字符串 + loadNavigation 兜底）");
