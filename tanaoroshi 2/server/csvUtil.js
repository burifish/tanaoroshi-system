// csvUtil.js
// JANコード・商品コードのような「桁数の長い数字の文字列」をCSV/Excelで扱う際の
// 事故を防ぐための共通ヘルパー。
//
// 問題: ExcelでCSVを開くと、数字だけのセルは自動的に「数値」として扱われ、
// 13桁などの長い数字は指数表記(例: 4.9E+12)で表示される。そのままCSVとして
// 保存し直すと、表示上省略された桁が失われ、元のJAN/商品コードが二度と
// 復元できなくなってしまう。
//
// 対策: CSVを書き出す際は "=" プレフィックス付きの文字列 (例: ="4900000000000")
// として出力する。Excelはこの記法を「文字列として評価する数式」として認識し、
// 指数表記に変換せず、入力した桁をそのまま文字列として表示・保存してくれる。
// 取り込み時は逆にこの記法を取り除いて元の値に戻す。

function excelSafeNumericText(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return `="${s.replace(/"/g, '""')}"`;
}

function stripExcelSafeWrapper(v) {
  if (v == null) return v;
  let s = String(v).trim();
  const m = s.match(/^="([\s\S]*)"$/);
  if (m) return m[1].replace(/""/g, '"');
  // 先頭アポストロフィ(Excelでテキスト強制入力した場合)にも対応
  if (s.startsWith("'")) return s.slice(1);
  return s;
}

// Excelの指数表記(例: 4.93E+11)がそのまま数字として保存されてしまい、
// 元の桁が失われて回復不能になっているケースを検知する
function looksLikeBrokenScientific(v) {
  return /^[\d.]+E[+-]?\d+$/i.test(String(v || '').trim());
}

module.exports = { excelSafeNumericText, stripExcelSafeWrapper, looksLikeBrokenScientific };
