const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), zlib = require("node:zlib"), ts = require("typescript");
const context = vm.createContext({ exports: {}, TextDecoder });
vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/dictionary/stardict.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);
const { StarDictionary, parseSections, normalizeQuery, wordCandidates } = context.exports;
const pinyinContext = vm.createContext({ exports: {} });
vm.runInContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/dictionary/pinyin.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, pinyinContext);
const { pinyinFromBopomofo } = pinyinContext.exports;
function fixture({ bits = 32, word = "bank", data = Buffer.from("IPA\0definition"), synonym, target = 0 } = {}) {
  const number = Buffer.alloc(bits / 8 + 4); number.writeUInt32BE(data.length, bits / 8);
  const idx = Buffer.concat([Buffer.from(word + "\0"), number]);
  const info = `StarDict's dict ifo file\nversion=3.0.0\nbookname=Test\nwordcount=1\nidxfilesize=${idx.length}\nidxoffsetbits=${bits}\nsametypesequence=tm\n${synonym ? "synwordcount=1\n" : ""}`;
  let syn;
  if (synonym) { const n = Buffer.alloc(4); n.writeUInt32BE(target); syn = Buffer.concat([Buffer.from(synonym + "\0"), n]); }
  return { info, idx, data, syn };
}
const pack = { id: "test", kind: "english", builtin: false, enabled: true };
const open = (f) => new StarDictionary(f.info, f.idx, f.data, f.syn, pack);
test("StarDict supports both offset widths, exact casing and synonym lookups", () => {
  for (const bits of [32, 64]) {
    const dictionary = open(fixture({ bits, synonym: "banks" }));
    assert.equal(dictionary.lookup("BANK")[0].sections[1].text, "definition");
    assert.equal(dictionary.lookup("banks")[0].word, "bank");
  }
});
test("StarDict validates counts, bounds and truncated aliases", () => {
  assert.throws(() => open(fixture({ synonym: "bad", target: 8 })), /别名索引/);
  const f = fixture(); f.idx = f.idx.subarray(0, 3); assert.throws(() => open(f), /索引/);
  const f2 = fixture(); f2.data = Buffer.from("small"); assert.throws(() => open(f2), /越界/);
  const f3 = fixture(); f3.info = f3.info.replace("wordcount=1", "wordcount=2"); assert.throws(() => open(f3), /数量/);
});
test("mixed text, empty final fields and binary fields decode without treating audio as text", () => {
  assert.equal(parseSections(Buffer.from("tIPA\0mtext\0"), "")[1].text, "text");
  assert.equal(parseSections(Buffer.from("IPA\0"), "tm")[1].text, "");
  assert.equal(parseSections(Buffer.from("W\0\0\0\x03abcmtail\0"), "")[0].text, "tail");
  assert.throws(() => parseSections(Buffer.from("W\0\0\0\x09abc"), ""), /越界/);
});
test("normalization preserves word interiors and morphology does not override exact words", () => {
  assert.equal(normalizeQuery(" “银行” "), "银行");
  assert.equal(normalizeQuery("don't"), "don't");
  assert.equal(normalizeQuery("ＡＰＩ"), "API");
  assert.equal(wordCandidates("running").includes("run"), true);
  assert.equal(wordCandidates("goes").includes("go"), true);
  assert.equal(wordCandidates("studies").includes("study"), true);
  assert.equal(open(fixture({ word: "saw" })).lookup("saw")[0].word, "saw");
});
test("all shipped packs are real StarDict data with useful offline coverage", () => {
  const root = path.join(__dirname, "../resources/dictionaries");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  // 词库可能换成本地版本（只在本地使用），这里只要求 manifest 与磁盘一致
  assert.deepEqual(
    manifest.map((pack) => pack.id).sort(),
    fs.readdirSync(root).filter((name) => fs.statSync(path.join(root, name)).isDirectory()).sort(),
  );
  assert.equal(manifest.every((pack) => pack.enabled), true);
  assert.equal(manifest.some((pack) => /重編|國語|成語典|教育部/.test(pack.name)), false);
  for (const info of manifest) {
    const file = (extension) => fs.readFileSync(path.join(root, info.id, info.id + "." + extension));
    const dictionary = new StarDictionary(file("ifo").toString("utf8"), zlib.gunzipSync(file("idx.gz")), zlib.gunzipSync(file("dict.dz")), file("syn"), info);
    assert.equal(dictionary.info.count, info.count);
    if (info.kind === "english") {
      assert.equal(dictionary.lookup("went").some((e) => e.word === "go"), true);
      assert.equal(dictionary.lookup("hello").length > 0, true);
    } else if (info.kind === "chinese") {
      assert.equal(dictionary.lookup("银行").some((e) => /háng/.test(e.sections[0].text)), true);
      assert.equal(dictionary.lookup("行").length > 0, true);
    } else {
      assert.equal(dictionary.lookup("画蛇添足").length > 0, true);
      // 本地 EuDic 转换包只保留释义；mapull 包不在此列
      if (/EuDic/.test(info.source)) {
        for (const entry of dictionary.entries) {
          const sections = parseSections(dictionary.data.subarray(entry.offset, entry.offset + entry.size), 'tm');
          assert.ok(sections[1].text.trim());
          assert.doesNotMatch(sections[1].text, /【(?:出处|示例|成语故事|解释)】|【扩展资料】/);
        }
      }
    }
  }
});
test("pinyin follows original syllables, tones, umlauts and zero initials without guessing from Hanzi", () => {
  for (const [reading, result] of [
    ["ㄨㄤˋ　ㄇㄟˊ　ㄓˇ　ㄎㄜˇ", "wàng méi zhǐ kě"],
    ["ㄧㄣˊ ㄏㄤˊ", "yín háng"], ["ㄋㄩˇ ㄌㄩˋ", "nǚ lǜ"],
    ["ㄐㄩ ㄑㄩㄝˋ ㄒㄩㄣˊ", "jū què xún"],
    ["ㄧㄡˇ ㄨㄟˋ ㄨㄥ ㄩㄥˇ", "yǒu wèi wēng yǒng"],
    ["ㄌㄧㄡˊ ㄍㄨㄟˋ ㄉㄨㄟˋ ㄌㄨㄣˋ", "liú guì duì lùn"],
    ["˙ㄉㄜ ㄓ ㄕˊ", "de zhī shí"],
  ]) assert.equal(pinyinFromBopomofo(reading), result);
  assert.equal(pinyinFromBopomofo("银行"), null);
  assert.equal(pinyinFromBopomofo("<script>ㄓ</script>"), null);
});
