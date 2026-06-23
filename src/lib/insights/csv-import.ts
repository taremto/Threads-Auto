/**
 * 既存スプシ分析ツールのCSV履歴インポート（20列）
 * ヘッダ:
 *  ID,投稿日時,投稿テキスト,投稿URL,閲覧,いいね,返信,リポスト,引用,CVR,
 *  取得日時,投稿時間,ツリー本文,ツリー数,取得日,Tag,月,P80_閲覧,P80_ER,ナレッジ対象
 *
 * 注意:
 *  - ID は巨大数値 → 必ず String 扱い（精度損失防止）
 *  - インサイト空行（views等が空）は null 許容
 *  - 本文/ツリー本文にカンマ・改行・"" を含むため RFC4180 準拠パーサが必須
 */
import type { PerfLabel } from "./knowledge-label";

/** RFC4180準拠のCSVパーサ（引用フィールド内のカンマ/改行/エスケープ "" を処理） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // BOM除去
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // CRLF の CR は無視（次の \n で改行確定）
      } else {
        field += c;
      }
    }
  }
  // 末尾フィールド/行
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export type HistoricalRecord = {
  threadsPostId: string | null;
  postedAt: Date | null;
  text: string;
  postUrl: string | null;
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
  er: number | null;
  treeBody: string | null;
  treeCount: number | null;
  tag: string | null;
  perfLabel: PerfLabel;
};

function num(s: string | undefined): number | null {
  if (s == null) return null;
  // 桁区切りのカンマ（半角/全角）・パーセント記号を除去してから数値化する。
  // T-Insight 等の書き出しCSVは「12,345」「5.58%」形式のため、これを外さないと
  // 1,000以上の数値が全て NaN→null になり集計が壊れる。
  const t = s.trim().replace(/[,，]/g, "").replace(/%/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function intNum(s: string | undefined): number | null {
  const n = num(s);
  return n == null ? null : Math.round(n);
}

function date(s: string | undefined): Date | null {
  if (!s || !s.trim()) return null;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function labelFromJa(s: string | undefined): PerfLabel {
  const t = (s || "").trim();
  if (t === "エンゲージ型") return "engage";
  if (t === "リーチ型") return "reach";
  return null;
}

/** ID列のクリーニング（先頭の ' を除去、空は null） */
function cleanId(s: string | undefined): string | null {
  let t = (s || "").trim();
  if (t.startsWith("'")) t = t.slice(1);
  return t === "" ? null : t;
}

type Field =
  | "threadsPostId"
  | "postedAt"
  | "text"
  | "postUrl"
  | "views"
  | "likes"
  | "replies"
  | "reposts"
  | "quotes"
  | "er"
  | "treeBody"
  | "treeCount"
  | "tag"
  | "perfLabel";

// 各フィールドの見出し別名（日本語/英語/表記ゆれ）。列名から自動認識するために使う。
const FIELD_ALIASES: Record<Field, string[]> = {
  threadsPostId: ["id", "投稿id", "postid", "post id", "メディアid", "mediaid"],
  postedAt: ["投稿日時", "日時", "投稿日", "日付", "投稿時刻", "timestamp", "date", "postedat", "posted at", "created time", "createdtime"],
  text: ["投稿テキスト", "本文", "テキスト", "投稿内容", "内容", "text", "content", "caption", "message"],
  postUrl: ["投稿url", "url", "パーマリンク", "permalink", "リンク", "link", "posturl"],
  views: ["閲覧", "閲覧数", "ビュー", "表示回数", "インプレッション", "インプレッション数", "views", "view", "impressions", "reach"],
  likes: ["いいね", "いいね数", "likes", "like", "favorites"],
  replies: ["返信", "返信数", "コメント", "コメント数", "replies", "reply", "comments"],
  reposts: ["リポスト", "リポスト数", "再投稿", "再投稿数", "reposts", "repost", "reblog", "shares", "share"],
  quotes: ["引用", "引用数", "quotes", "quote"],
  er: ["cvr", "er", "エンゲージメント率", "エンゲージ率", "engagement rate", "engagementrate", "エンゲージメント", "engagement"],
  treeBody: ["ツリー本文", "ツリー", "tree", "treebody", "thread text", "threadtext"],
  treeCount: ["ツリー数", "treecount", "tree count"],
  tag: ["tag", "タグ"],
  perfLabel: ["ナレッジ対象", "ラベル", "label", "判定", "種別", "type"],
};

// 既知の20列レイアウト（ヘッダが認識できない時の位置フォールバック）
const POSITIONAL: Partial<Record<Field, number>> = {
  threadsPostId: 0,
  postedAt: 1,
  text: 2,
  postUrl: 3,
  views: 4,
  likes: 5,
  replies: 6,
  reposts: 7,
  quotes: 8,
  er: 9,
  treeBody: 12,
  treeCount: 13,
  tag: 15,
  perfLabel: 19,
};

const normHeader = (s: string | undefined): string =>
  (s || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_　・()（）★☆]/g, "");

/** ヘッダ行を見出し別名で照合し、フィールド→列index のマップを作る */
function buildColumnMap(header: string[]): Partial<Record<Field, number>> {
  const map: Partial<Record<Field, number>> = {};
  header.forEach((cell, i) => {
    const n = normHeader(cell);
    if (!n) return;
    (Object.keys(FIELD_ALIASES) as Field[]).forEach((field) => {
      if (map[field] === undefined && FIELD_ALIASES[field].some((a) => normHeader(a) === n)) {
        map[field] = i;
      }
    });
  });
  return map;
}

/**
 * CSVテキストを HistoricalRecord[] に変換。
 *
 * 列の対応は **見出し名（日本語/英語/表記ゆれ）で自動認識**する。
 * 順番が違っても・余分な列があっても・列名がブレても拾える。
 * 見出しが認識できない場合のみ、既知の20列レイアウトとして位置で読む。
 */
export function parseAnalyticsCsv(csvText: string): HistoricalRecord[] {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return [];

  const headerMap = buildColumnMap(rows[0]);
  let map: Partial<Record<Field, number>>;
  let start: number;
  if (Object.keys(headerMap).length >= 3) {
    // 見出しを列名で認識（順番・別名・余分な列に強い）
    map = headerMap;
    start = 1;
  } else {
    // 認識できる見出しが無い → 既知の20列レイアウトとして位置で読む
    map = POSITIONAL;
    const first = (rows[0][0] || "").trim().toLowerCase();
    start = first === "id" || first === "投稿id" ? 1 : 0;
  }

  const cell = (r: string[], field: Field): string | undefined => {
    const idx = map[field];
    return idx === undefined ? undefined : r[idx];
  };

  const out: HistoricalRecord[] = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 0 || r.every((c) => (c || "").trim() === "")) continue;
    const rec: HistoricalRecord = {
      threadsPostId: cleanId(cell(r, "threadsPostId")),
      postedAt: date(cell(r, "postedAt")),
      text: (cell(r, "text") || "").trim(),
      postUrl: (cell(r, "postUrl") || "").trim() || null,
      views: intNum(cell(r, "views")),
      likes: intNum(cell(r, "likes")),
      replies: intNum(cell(r, "replies")),
      reposts: intNum(cell(r, "reposts")),
      quotes: intNum(cell(r, "quotes")),
      er: num(cell(r, "er")),
      treeBody: (cell(r, "treeBody") || "").trim() || null,
      treeCount: intNum(cell(r, "treeCount")),
      tag: (cell(r, "tag") || "").trim() || null,
      perfLabel: labelFromJa(cell(r, "perfLabel")),
    };
    // ID・本文・主要指標が全く無い行はスキップ
    if (!rec.threadsPostId && !rec.text && rec.views == null && rec.likes == null) {
      continue;
    }
    out.push(rec);
  }
  return out;
}
