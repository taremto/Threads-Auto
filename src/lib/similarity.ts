/**
 * 投稿の「似すぎ」判定ユーティリティ。
 *
 * 文字 bi-gram の Jaccard 係数で、書き出し（フック）と本文全体それぞれの類似度を測る。
 * これを使って「バッチをまたいだ重複（昨日と今日の投稿がかぶる）」と
 * 「同一バッチ内の焼き直し」の両方を弾く。日本語は単語境界が曖昧なので
 * 形態素解析せず、文字 2-gram の集合一致で素朴に見る（十分に効く・依存ゼロ）。
 */

export type SimThread = {
  hook: string; // スレッド1投稿目（書き出し）
  fullText: string; // スレッド全文（全リプライ連結）
};

export type SimFingerprint = {
  hook: Set<string>;
  body: Set<string>;
};

// この値以上で「似すぎ」と判定する。hook（書き出し）は本文より短く一致が出やすいので別閾値。
export const HOOK_SIM_THRESHOLD = 0.55;
export const BODY_SIM_THRESHOLD = 0.5;

function normalize(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[、。，．！？!?「」『』（）()[\]【】〜~ー・…,.:：;；'"'"]/g, "");
}

function bigrams(text: string): Set<string> {
  const t = normalize(text);
  const set = new Set<string>();
  if (t.length <= 1) {
    if (t) set.add(t);
    return set;
  }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function fingerprint(t: SimThread): SimFingerprint {
  return { hook: bigrams(t.hook), body: bigrams(t.fullText) };
}

export function similarity(
  a: SimFingerprint,
  b: SimFingerprint
): { hook: number; body: number } {
  return { hook: jaccard(a.hook, b.hook), body: jaccard(a.body, b.body) };
}

export function isTooSimilar(a: SimFingerprint, b: SimFingerprint): boolean {
  const s = similarity(a, b);
  return s.hook >= HOOK_SIM_THRESHOLD || s.body >= BODY_SIM_THRESHOLD;
}

/** cand と参照集合の中で最も高い類似度（hook/body の大きい方）。補充時の順位付けに使う。 */
export function maxSimilarity(
  cand: SimFingerprint,
  refs: SimFingerprint[]
): number {
  let max = 0;
  for (const r of refs) {
    const s = similarity(cand, r);
    const m = Math.max(s.hook, s.body);
    if (m > max) max = m;
  }
  return max;
}
