/**
 * トークン概算（27 §5 chunk_size は tokens 基準）。
 *
 * 正確な tiktoken は依存を増やすため MVP では概算ヒューリスティックを使う。
 * 日本語（CJK）は概ね 1 文字 ≈ 1 token、ASCII は概ね 4 文字 ≈ 1 token として
 * 混在テキストを推定する。chunk 分割の閾値判定に使う近似であり、課金計算には
 * 使わない（課金は Provider が返す実 usage を使う / provider-usage）。
 */

const CJK_RE =
  /[　-〿぀-ヿ㐀-䶿一-鿿＀-￯]/

/** テキストのトークン数を概算する。 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1
    else other += 1
  }
  // CJK は 1 文字 ≈ 1 token、それ以外は 4 文字 ≈ 1 token。
  return cjk + Math.ceil(other / 4)
}
