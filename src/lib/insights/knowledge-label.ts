/**
 * 高パフォ投稿のラベル判定（GAS v9.1 のナレッジ判定ロジックを移植）
 *
 * 閾値 = MAX(10000, P80_views)  ← アカウント成長に自動追従
 *   views >= 閾値 かつ ER >= P80_ER → "engage"（エンゲージ型：リーチ＋高ER＝最高品質）
 *   views >= 閾値 かつ ER <  P80_ER → "reach" （リーチ型：広く拡散したパターン）
 *   views <  閾値                    → null    （インプ不足＝ナレッジ不適格）
 */

export const KNOWLEDGE_MIN_VIEWS = 10000;

export type PerfLabel = "engage" | "reach" | null;

export function knowledgeThreshold(p80Views: number): number {
  return Math.max(KNOWLEDGE_MIN_VIEWS, p80Views || 0);
}

export function labelPost(
  views: number | null | undefined,
  er: number | null | undefined,
  p80Views: number,
  p80Er: number
): PerfLabel {
  const v = Number(views);
  if (!Number.isFinite(v) || v < knowledgeThreshold(p80Views)) return null;
  const e = Number(er);
  if (Number.isFinite(e) && e >= p80Er) return "engage";
  return "reach";
}

export function perfLabelJa(label: PerfLabel): string {
  if (label === "engage") return "エンゲージ型";
  if (label === "reach") return "リーチ型";
  return "";
}
