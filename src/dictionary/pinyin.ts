// 注音→汉语拼音是音标转写，不根据汉字猜读音。
// 对照：https://ws.moe.edu.tw/001/Upload/FileUpload/3692-16962/Documents/970918duizhao.pdf
const initials: Record<string, string> = Object.fromEntries([
  ..."ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ",
].map((symbol, index) => [symbol, ["b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "zh", "ch", "sh", "r", "z", "c", "s"][index]]));
const finals: Record<string, string> = {
  "ㄚ": "a", "ㄛ": "o", "ㄜ": "e", "ㄝ": "ê", "ㄞ": "ai", "ㄟ": "ei", "ㄠ": "ao", "ㄡ": "ou",
  "ㄢ": "an", "ㄣ": "en", "ㄤ": "ang", "ㄥ": "eng", "ㄦ": "er",
  "ㄧ": "i", "ㄧㄚ": "ia", "ㄧㄛ": "io", "ㄧㄝ": "ie", "ㄧㄞ": "iai", "ㄧㄠ": "iao", "ㄧㄡ": "iou", "ㄧㄢ": "ian", "ㄧㄣ": "in", "ㄧㄤ": "iang", "ㄧㄥ": "ing",
  "ㄨ": "u", "ㄨㄚ": "ua", "ㄨㄛ": "uo", "ㄨㄞ": "uai", "ㄨㄟ": "uei", "ㄨㄢ": "uan", "ㄨㄣ": "uen", "ㄨㄤ": "uang", "ㄨㄥ": "ueng",
  "ㄩ": "ü", "ㄩㄝ": "üe", "ㄩㄢ": "üan", "ㄩㄣ": "ün", "ㄩㄥ": "iong",
};
const zero: Record<string, string> = {
  i: "yi", ia: "ya", io: "yo", ie: "ye", iai: "yai", iao: "yao", iou: "you", ian: "yan", in: "yin", iang: "yang", ing: "ying",
  u: "wu", ua: "wa", uo: "wo", uai: "wai", uei: "wei", uan: "wan", uen: "wen", uang: "wang", ueng: "weng",
  "ü": "yu", "üe": "yue", "üan": "yuan", "ün": "yun", iong: "yong",
};
const tones: Record<string, string> = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", "ü": "ǖǘǚǜ" };
function syllable(value: string): string | null {
  const tone = value.includes("˙") ? 0 : value.includes("ˊ") ? 2 : value.includes("ˇ") ? 3 : value.includes("ˋ") ? 4 : 1;
  let symbols = value.replace(/[˙ˊˇˋ]/g, "");
  const initial = initials[symbols[0]] ?? "";
  if (initial) symbols = symbols.slice(1);
  let ending = finals[symbols];
  if (!ending && !symbols && ["zh", "ch", "sh", "r", "z", "c", "s"].includes(initial)) ending = "i";
  if (!ending) return null;
  if (!initial) ending = zero[ending] ?? ending;
  else {
    ending = ({ iou: "iu", uei: "ui", uen: "un", ueng: "ong" } as Record<string, string>)[ending] ?? ending;
    if (["j", "q", "x"].includes(initial)) ending = ending.replace("ü", "u");
  }
  let result = initial + ending;
  if (!tone) return result;
  const index = result.includes("a") ? result.indexOf("a") : result.includes("e") ? result.indexOf("e")
    : result.includes("ou") ? result.indexOf("o") : Math.max(...[...result].map((letter, index) => tones[letter] ? index : -1));
  if (index >= 0 && tones[result[index]]) result = result.slice(0, index) + tones[result[index]][tone - 1] + result.slice(index + 1);
  return result;
}
export function pinyinFromBopomofo(value: string): string | null {
  const tokens = value.match(/˙?[ㄅ-ㄩ]+[ˊˇˋ˙]?/gu);
  if (!tokens?.length) return null;
  // 避免将夹杂拉丁语、HTML 或未知文字的原始字段当成完整注音串。
  if (value.replace(/˙?[ㄅ-ㄩ]+[ˊˇˋ˙]?/gu, "").replace(/[\s　（一二），]/g, "")) return null;
  const result = tokens.map(syllable);
  return result.every(Boolean) ? result.join(" ") : null;
}
