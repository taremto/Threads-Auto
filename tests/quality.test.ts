import assert from "node:assert/strict";
import {
  billingRiskEnvNames,
  describeClaudeCliError,
  estimateClaudeGenerationTimeoutMs,
  parseClaudeAuthStatus,
  parseClaudeRateLimitCache,
  parseClaudeUsageCommandOutput,
  parseClaudeUsageOutput,
} from "../src/lib/claude-cli";
import { gasVersionUpgradeMessage, toJstString } from "../src/lib/gas-bridge";
import {
  applyMinuteJitter,
  buildJstSlots,
  hasPostIntervalConflict,
  selectSafeSlots,
} from "../src/lib/schedule";
import {
  buildRecommendedPostingPlan,
  normalizePostingHours,
} from "../src/lib/recommended-times";
import {
  buildGenerationCountOptions,
  dailyPostCountFromPostingHours,
  generationCountLabel,
  normalizeAccountPostingHours,
} from "../src/lib/account-posting";
import { calcEr, percentile, timeBandFromHour } from "../src/lib/insights/metrics";
import { labelPost, knowledgeThreshold } from "../src/lib/insights/knowledge-label";
import { parseAnalyticsCsv, parseCsv } from "../src/lib/insights/csv-import";
import { rankPostingHoursByPerformance } from "../src/lib/insights/rank-hours";
import {
  buildExtendThreadPrompt,
  buildRewriteThreadPrompt,
} from "../src/lib/extend-thread-prompt";

let pass = 0;

function test(name: string, fn: () => void) {
  fn();
  pass++;
  console.log(`  ✓ ${name}`);
}

console.log("============================================");
console.log("  Quality Regression Test");
console.log("============================================");

test("billing guard detects API-key based metered mode", () => {
  assert.deepEqual(
    billingRiskEnvNames({
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "",
    }),
    ["ANTHROPIC_API_KEY"]
  );
});

test("billing guard ignores false-like toggles", () => {
  assert.deepEqual(
    billingRiskEnvNames({
      CLAUDE_CODE_USE_BEDROCK: "false",
      CLAUDE_CODE_USE_VERTEX: "0",
    }),
    []
  );
});

test("billing guard ignores Anthropic official default base URL", () => {
  assert.deepEqual(
    billingRiskEnvNames({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    }),
    []
  );
  assert.deepEqual(
    billingRiskEnvNames({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com/",
    }),
    []
  );
});

test("billing guard still blocks custom Anthropic base URL", () => {
  assert.deepEqual(
    billingRiskEnvNames({
      ANTHROPIC_BASE_URL: "https://proxy.example/v1",
    }),
    ["ANTHROPIC_BASE_URL"]
  );
});

test("usage-limit message keeps beginner wording and wait time", () => {
  const msg = describeClaudeCliError(
    "usage limit reached. try again in 5 hours",
    {}
  );
  assert.match(msg, /Claudeの利用上限/);
  assert.match(msg, /あと約5時間/);
});

test("Claude auth status parser detects CLI logout", () => {
  const auth = parseClaudeAuthStatus(JSON.stringify({
    loggedIn: false,
    authMethod: "none",
    apiProvider: "firstParty",
  }));
  assert(auth);
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.authMethod, "none");
});

test("Claude usage parser reads Japanese session and weekly percentages", () => {
  const usage = parseClaudeUsageOutput(`
現在のセッション
4時間4分後にリセット
3% 使用済み

週間制限
9:00（金）にリセット
0% 使用済み
`);
  assert.equal(usage.status, "safe");
  assert.equal(usage.fiveHour.usedPercentage, 3);
  assert.equal(usage.sevenDay.usedPercentage, 0);
});

test("Claude usage parser limits large generations near usage cap", () => {
  const usage = parseClaudeUsageOutput(`
Current session
Resets in 1 hour
92% used
Weekly limit
12% used
`);
  assert.equal(usage.status, "danger");
  assert.equal(usage.maxRecommendedPosts, 2);
});

test("Claude usage parser allows fallback when output is not readable", () => {
  const usage = parseClaudeUsageOutput("Claude usage is not available in this environment.");
  assert.equal(usage.status, "unknown");
  assert.equal(usage.maxRecommendedPosts, null);
});

test("Claude usage parser does not treat per-run CLI summary as account usage", () => {
  const usage = parseClaudeUsageOutput(`
Total cost:            $0.0000
Total duration (API):  0s
Total duration (wall): 0s
Usage:                 0 input, 0 output, 0 cache read, 0 cache write
`);
  assert.equal(usage.status, "unknown");
  assert.equal(usage.fiveHour.usedPercentage, null);
  assert.equal(usage.sevenDay.usedPercentage, null);
});

test("Claude usage command parser reads status-line plan usage without using context as a limit", () => {
  const usage = parseClaudeUsageCommandOutput("Usage: context 31%, plan 4%");
  assert.equal(usage.status, "safe");
  assert.equal(usage.contextWindow?.usedPercentage, 31);
  assert.equal(usage.plan?.usedPercentage, 4);
  assert.equal(usage.fiveHour.usedPercentage, null);
  assert.equal(usage.sevenDay.usedPercentage, null);
});

test("Claude usage command parser reads slash-context output as context only", () => {
  const usage = parseClaudeUsageCommandOutput(`
## Context Usage

**Model:** claude-opus-4-7[1m]
**Tokens:** 41k / 1m (4%)
`);
  assert.equal(usage.status, "safe");
  assert.equal(usage.available, true);
  assert.equal(usage.contextWindow?.usedPercentage, 4);
  assert.equal(usage.fiveHour.usedPercentage, null);
  assert.equal(usage.sevenDay.usedPercentage, null);
  assert.equal(usage.maxRecommendedPosts, null);
  assert.doesNotMatch(usage.message, /4%/);
  assert.match(usage.message, /セッション使用量はClaude Code CLIから取得できません/);
});

test("Claude usage command parser reads compact five-hour and seven-day values", () => {
  const usage = parseClaudeUsageCommandOutput("5h: 83% 7d: 3%");
  assert.equal(usage.status, "caution");
  assert.equal(usage.fiveHour.usedPercentage, 83);
  assert.equal(usage.sevenDay.usedPercentage, 3);
  assert.equal(usage.maxRecommendedPosts, 4);
});

test("Claude usage command parser reads JSON rate limit values", () => {
  const usage = parseClaudeUsageCommandOutput(JSON.stringify({
    context_window: { used_percentage: 31 },
    rate_limits: {
      five_hour: { used_percentage: 14 },
      seven_day: { used_percentage: 3 },
    },
  }));
  assert.equal(usage.status, "safe");
  assert.equal(usage.contextWindow?.usedPercentage, 31);
  assert.equal(usage.fiveHour.usedPercentage, 14);
  assert.equal(usage.sevenDay.usedPercentage, 3);
});

test("Claude rate-limit cache parser reads local five-hour usage only", () => {
  const reset = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const usage = parseClaudeRateLimitCache(JSON.stringify({
    timestamp: Date.now() / 1000,
    data: {
      five_hour: { utilization: 0.12, resets_at: reset },
      seven_day: { utilization: 0.03, resets_at: reset },
    },
  }));
  assert(usage);
  assert.equal(usage.source, "claude-cache");
  assert.equal(usage.status, "safe");
  assert.equal(usage.fiveHour.usedPercentage, 12);
  assert.equal(usage.sevenDay.usedPercentage, 3);
  assert.equal(usage.maxRecommendedPosts, null);
});

test("Claude rate-limit cache parser reads weekly usage dynamically", () => {
  const reset = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const usage = parseClaudeRateLimitCache(JSON.stringify({
    timestamp: Date.now() / 1000,
    data: {
      five_hour: { utilization: 17, resets_at: null },
      seven_day: { utilization: 5, resets_at: reset },
    },
  }));
  assert(usage);
  assert.equal(usage.status, "safe");
  assert.equal(usage.fiveHour.usedPercentage, 17);
  assert.equal(usage.sevenDay.usedPercentage, 5);
  assert.equal(usage.maxRecommendedPosts, null);
});

test("Claude rate-limit cache parser limits fresh high session usage without hard-blocking", () => {
  const reset = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const usage = parseClaudeRateLimitCache(JSON.stringify({
    timestamp: Date.now() / 1000,
    data: {
      five_hour: { utilization: 1, resets_at: reset },
      seven_day: { utilization: 0, resets_at: null },
    },
  }));
  assert(usage);
  assert.equal(usage.status, "danger");
  assert.equal(usage.maxRecommendedPosts, 2);
});

test("Claude rate-limit cache parser ignores stale cache", () => {
  const usage = parseClaudeRateLimitCache(JSON.stringify({
    timestamp: Date.now() / 1000 - 60 * 60,
    data: {
      five_hour: { utilization: 0.5, resets_at: null },
      seven_day: { utilization: 1, resets_at: null },
    },
  }));
  assert.equal(usage, null);
});

test("Claude rate-limit cache parser ignores broken cache", () => {
  assert.equal(parseClaudeRateLimitCache("{not json"), null);
  assert.equal(parseClaudeRateLimitCache(JSON.stringify({ data: {} })), null);
});

test("Claude usage parser does not present context usage as session usage", () => {
  const usage = parseClaudeUsageCommandOutput(`
## Context Usage

**Tokens:** 41k / 1m (4%)
`);
  assert.equal(usage.status, "safe");
  assert.equal(usage.fiveHour.usedPercentage, null);
  assert.equal(usage.sevenDay.usedPercentage, null);
  assert.equal(usage.plan?.usedPercentage, null);
  assert.equal(usage.contextWindow?.usedPercentage, 4);
  assert.doesNotMatch(usage.message, /現在の使用量は約4%/);
});

test("Claude generation timeout scales with large prompts and counts", () => {
  assert.equal(
    estimateClaudeGenerationTimeoutMs({ promptChars: 10_000, count: 2 }),
    5 * 60 * 1000
  );
  assert(
    estimateClaudeGenerationTimeoutMs({ promptChars: 78_000, count: 16 }) >
      5 * 60 * 1000
  );
  assert.equal(
    estimateClaudeGenerationTimeoutMs({ promptChars: 200_000, count: 40 }),
    15 * 60 * 1000
  );
});

test("GAS upgrade message separates app and Google-side versions", () => {
  const msg = gasVersionUpgradeMessage("webapp-v1.1.7");
  assert.match(msg, /アプリ本体は更新済み/);
  assert.match(msg, /Google側の現在版: v1\.1\.7/);
  assert.match(msg, /最新版: v1\.1\.11/);
});

test("JST slots stay in Japan time regardless of host timezone", () => {
  // 2026-05-14 08:20 JST. First slot should be 12:00 JST, not host-local 12:00.
  const now = new Date("2026-05-13T23:20:00.000Z");
  const slots = buildJstSlots(now, [6, 12, 18, 21], 5);
  assert.deepEqual(slots.map(toJstString), [
    "2026-05-14T12:00",
    "2026-05-14T18:00",
    "2026-05-14T21:00",
    "2026-05-15T06:00",
    "2026-05-15T12:00",
  ]);
});

test("JST slots enforce minimum 65 minute gap", () => {
  const now = new Date("2026-05-13T23:20:00.000Z");
  const slots = buildJstSlots(now, [9, 10, 12], 3);
  assert.deepEqual(slots.map(toJstString), [
    "2026-05-14T09:00",
    "2026-05-14T12:00",
    "2026-05-15T09:00",
  ]);
});

test("minute jitter only moves slots later within configured range", () => {
  const now = new Date("2026-05-13T23:20:00.000Z");
  const slots = buildJstSlots(now, [12, 18], 2);
  const jittered = applyMinuteJitter(slots, 15, () => 1);
  assert.deepEqual(jittered.map(toJstString), [
    "2026-05-14T12:15",
    "2026-05-14T18:15",
  ]);
});

test("30 accounts can each receive independent JST slots", () => {
  const now = new Date("2026-05-13T23:20:00.000Z");
  const accounts = Array.from({ length: 30 }, (_, i) => `account-${i + 1}`);
  const firstSlots = accounts.map(() => buildJstSlots(now, [6, 12, 18, 21], 1)[0]);
  assert.equal(firstSlots.length, 30);
  assert(firstSlots.every((slot) => toJstString(slot) === "2026-05-14T12:00"));
});

test("posting interval guard blocks anything under 60 minutes", () => {
  const busy = [new Date("2026-05-14T03:00:00.000Z")]; // 12:00 JST
  assert.equal(
    hasPostIntervalConflict(new Date("2026-05-14T03:59:00.000Z"), busy),
    true
  );
  assert.equal(
    hasPostIntervalConflict(new Date("2026-05-14T04:00:00.000Z"), busy),
    false
  );
});

test("safe slot selector skips existing queued or posted slots", () => {
  const candidates = [
    new Date("2026-05-14T03:00:00.000Z"), // busy
    new Date("2026-05-14T03:30:00.000Z"), // too close
    new Date("2026-05-14T04:00:00.000Z"), // exactly 60 minutes later
    new Date("2026-05-14T05:00:00.000Z"),
  ];
  const selected = selectSafeSlots(candidates, [new Date("2026-05-14T03:00:00.000Z")], 2);
  assert.deepEqual(selected.map(toJstString), [
    "2026-05-14T13:00",
    "2026-05-14T14:00",
  ]);
});

test("recommended posting plan follows business persona active windows", () => {
  const plan = buildRecommendedPostingPlan(
    "副業とSNS運用に関心がある会社員向け。仕事終わりに読む人が多い。",
    [7, 12, 18, 21],
    4,
    { rng: () => 0 }
  );
  assert(plan.every((p) => [7, 12, 18, 21].includes(p.hour)));
  assert.match(plan[0].reason, /会社員・ビジネス層/);
});

test("recommended posting plan stays inside configured account hours", () => {
  const plan = buildRecommendedPostingPlan(
    "育児中のママ向け。子育てと暮らしの悩みを扱う。",
    [6, 12, 18, 21],
    4,
    { rng: () => 0 }
  );
  assert(plan.every((p) => [6, 12, 18, 21].includes(p.hour)));
  assert(plan.every((p) => p.label === `${p.hour.toString().padStart(2, "0")}:00前後`));
});

test("recommended posting plan uses post content when choosing time", () => {
  const plan = buildRecommendedPostingPlan(
    "占いと暮らしの悩みを扱うアカウント。",
    [7, 12, 18, 21],
    2,
    {
      postTexts: [
        "寝る前にモヤモヤして眠れない人へ。夜に氣を整える話。",
        "朝起きたら冷たい水で顔を洗う。今日からできる習慣の話。",
      ],
      rng: () => 0,
    }
  );
  assert.equal(plan[0].hour, 21);
  assert.equal(plan[1].hour, 7);
  assert.match(plan[0].reason, /夜/);
  assert.match(plan[1].reason, /朝/);
});

test("best-hours ranker scores configured slots by real performance with ±1h window", () => {
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    avgEr: 0,
    avgViews: 0,
    count: 0,
  }));
  hourly[6] = { hour: 6, avgEr: 9.9, avgViews: 500, count: 2 }; // 高ERだがサンプル不足→除外
  hourly[12] = { hour: 12, avgEr: 5.0, avgViews: 1000, count: 5 };
  hourly[19] = { hour: 19, avgEr: 4.0, avgViews: 1500, count: 4 }; // 18枠の近傍（±1窓で拾う）
  hourly[21] = { hour: 21, avgEr: 3.0, avgViews: 2000, count: 4 };

  const result = rankPostingHoursByPerformance(hourly, [6, 12, 18, 21]);
  assert(result);
  assert.deepEqual(result!.hours, [12, 18]); // ER順トップ2。18は近傍19時から採用
  assert.equal(result!.stats[6], undefined); // サンプル<3は除外（ERが高くても）
  assert.equal(result!.stats[12].avgEr, 5);
  assert.equal(result!.stats[18].avgEr, 4); // 近傍19時の値
  assert.equal(result!.stats[21].avgEr, 3);
});

test("best-hours ranker returns null when no slot has enough data", () => {
  const hourly = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    avgEr: 0,
    avgViews: 0,
    count: 0,
  }));
  hourly[12] = { hour: 12, avgEr: 8, avgViews: 100, count: 1 }; // サンプル不足
  assert.equal(rankPostingHoursByPerformance(hourly, [6, 12, 18, 21]), null);
});

test("recommended posting plan prefers real-data hours over content keywords", () => {
  const plan = buildRecommendedPostingPlan(
    "占いと暮らしの悩みを扱うアカウント。",
    [6, 12, 18, 21],
    4,
    {
      // 本文は夜寄せワードだが、実データは昼(12)・夕(18)が最良
      postTexts: ["寝る前に氣を整える話。", "石と浄化の話。", "占いの話。", "癒しの話。"],
      preferred: {
        hours: [12, 18],
        stats: {
          12: { avgEr: 5, avgViews: 1000, count: 5 },
          18: { avgEr: 4, avgViews: 1500, count: 4 },
        },
      },
      rng: () => 0,
    }
  );
  assert(plan.every((p) => [12, 18].includes(p.hour))); // 夜(21)に寄らず実データ枠
  assert.match(plan[0].reason, /実データ/);
  assert.match(plan[0].reason, /平均ER/);
});

test("extend-thread prompt embeds existing items and asks for one continuation post", () => {
  const p = buildExtendThreadPrompt({
    conceptSheet: "スピ系。占いと浄化の話。",
    rules: "ルールX：断言しすぎない",
    structures: "",
    customKnowledges: ["追加ナレッジY"],
    existingItems: ["1コマ目の本文だよ", "2コマ目の本文だよ"],
  });
  assert.match(p, /1コマ目の本文だよ/); // 既存ツリー本文を文脈に含む
  assert.match(p, /2コマ目の本文だよ/);
  assert.match(p, /スピ系。占いと浄化の話。/); // concept
  assert.match(p, /ルールX：断言しすぎない/); // rules
  assert.match(p, /追加ナレッジY/); // custom knowledge
  assert.match(p, /続き|次の1投稿|1投稿のみ|1投稿だけ/); // 続きの1投稿だけを指示
  assert.match(p, /200〜500字/); // 文字数制約
});

test("rewrite-thread prompt asks to recompose into exactly targetCount posts on same theme", () => {
  const p = buildRewriteThreadPrompt({
    conceptSheet: "スピ系。占いと浄化の話。",
    rules: "ルールX",
    structures: "",
    customKnowledges: [],
    existingItems: ["1コマ目の本文だよ", "2コマ目の本文だよ"],
    targetCount: 3,
  });
  assert.match(p, /1コマ目の本文だよ/); // 元ツリーを提示
  assert.match(p, /2コマ目の本文だよ/);
  assert.match(p, /ちょうど3投稿/); // ちょうどtargetCountに作り直す
  assert.match(p, /■1/); // ■フォーマット
  assert.match(p, /■3/);
  assert.match(p, /同じテーマ|テーマ・主張/); // 同テーマ維持
});

test("posting hour normalization rejects invalid values", () => {
  assert.deepEqual(normalizePostingHours(["21", -1, 24, 12.5, 7]), [7, 21]);
  assert.deepEqual(normalizePostingHours([]), [7, 12, 18, 21]);
});

test("account daily post count follows posting hour count", () => {
  assert.deepEqual(normalizeAccountPostingHours("[21,6,12,18]"), [6, 12, 18, 21]);
  assert.equal(dailyPostCountFromPostingHours("[6,12,18,21]"), 4);
  assert.equal(dailyPostCountFromPostingHours("[8,20,22]"), 3);
});

test("generation count options put account daily count first then 1 to 30", () => {
  assert.deepEqual(buildGenerationCountOptions(4, 30).slice(0, 6), [4, 1, 2, 3, 5, 6]);
  assert.equal(buildGenerationCountOptions(4, 30).length, 30);
  assert.deepEqual(buildGenerationCountOptions(4, 2), [1, 2]);
});

test("generation count labels explain only account day multiples", () => {
  assert.equal(generationCountLabel(4, 4), "4投稿（1日分・このアカウントの設定本数）");
  assert.equal(generationCountLabel(8, 4), "8投稿（2日分）");
  assert.equal(generationCountLabel(5, 4), "5投稿");
});

test("insights calcEr computes engagement rate and guards zero views", () => {
  assert.equal(calcEr(1000, 50, 10, 5, 0), 6.5);
  assert.equal(calcEr(0, 10, 0, 0, 0), null);
  assert.equal(calcEr(null, 1, 1, 1, 1), null);
});

test("insights percentile80 matches GAS ceil algorithm", () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.8), 40);
  assert.equal(percentile([], 0.8), 0);
  assert.equal(percentile([5], 0.8), 5);
});

test("insights time band buckets follow morning/noon/evening/late", () => {
  assert.equal(timeBandFromHour(6), "朝");
  assert.equal(timeBandFromHour(12), "昼");
  assert.equal(timeBandFromHour(21), "夜");
  assert.equal(timeBandFromHour(3), "深夜");
});

test("insights knowledge label uses MAX(10000,P80) threshold and P80_ER", () => {
  assert.equal(knowledgeThreshold(3885), 10000);
  assert.equal(knowledgeThreshold(15000), 15000);
  assert.equal(labelPost(5000, 10, 3885, 3.0), null);
  assert.equal(labelPost(12000, 5, 3885, 3.0), "engage");
  assert.equal(labelPost(12000, 1, 3885, 3.0), "reach");
});

test("CSV parser handles quoted fields with embedded commas and newlines", () => {
  const rows = parseCsv('a,b,c\n"x,y","l1\nl2",z\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ["a", "b", "c"]);
  assert.deepEqual(rows[1], ["x,y", "l1\nl2", "z"]);
});

test("analytics CSV import keeps big IDs as strings and maps label", () => {
  const csv = [
    "ID,投稿日時,投稿テキスト,投稿URL,閲覧,いいね,返信,リポスト,引用,CVR,取得日時,投稿時間,ツリー本文,ツリー数,取得日,Tag,月,P80_閲覧,P80_ER,ナレッジ対象",
    '18449886445116373,2026-05-21T09:21:39+0000,"本文,カンマ",https://e.com/p,1650,59,3,0,0,3.76,2026/05/28,夜,,1,2026/05/28,,2026-05,3885,3.02,リーチ型',
  ].join("\n");
  const recs = parseAnalyticsCsv(csv);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].threadsPostId, "18449886445116373");
  assert.equal(recs[0].views, 1650);
  assert.equal(recs[0].er, 3.76);
  assert.equal(recs[0].perfLabel, "reach");
});

test("analytics CSV import auto-detects columns by header (reordered + 表記ゆれ)", () => {
  // 列順を入れ替え＋「閲覧数」「いいね数」「パーマリンク」など表記ゆれ
  const csv = [
    "いいね数,閲覧数,投稿日時,ID,投稿テキスト,パーマリンク,ナレッジ対象",
    '59,1650,2026-05-21T09:21:39+0000,18449886445116373,"やったぜ",https://e.com/p,エンゲージ型',
  ].join("\n");
  const recs = parseAnalyticsCsv(csv);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].threadsPostId, "18449886445116373");
  assert.equal(recs[0].views, 1650);
  assert.equal(recs[0].likes, 59);
  assert.equal(recs[0].text, "やったぜ");
  assert.equal(recs[0].perfLabel, "engage");
});

test("analytics CSV import auto-detects English headers", () => {
  const csv = [
    "id,timestamp,text,permalink,views,likes,replies,reposts,quotes",
    "17900000000000001,2026-05-01T00:00:00+0000,hello,https://e.com/x,2000,40,3,1,0",
  ].join("\n");
  const recs = parseAnalyticsCsv(csv);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].threadsPostId, "17900000000000001");
  assert.equal(recs[0].views, 2000);
  assert.equal(recs[0].replies, 3);
  assert.equal(recs[0].reposts, 1);
});

test("analytics CSV import tolerates empty-insight rows", () => {
  const csv = [
    "ID,投稿日時,投稿テキスト,投稿URL,閲覧,いいね,返信,リポスト,引用,CVR,取得日時,投稿時間,ツリー本文,ツリー数,取得日,Tag,月,P80_閲覧,P80_ER,ナレッジ対象",
    "18098659565143741,2026-05-25T06:08:49+0000,,https://e.com/q,,,,,,,2026/05/28,昼,,1,2026/05/28,,2026-05,3885,3.02,",
  ].join("\n");
  const recs = parseAnalyticsCsv(csv);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].views, null);
  assert.equal(recs[0].perfLabel, null);
  assert.equal(recs[0].threadsPostId, "18098659565143741");
});

console.log(`\n✅ ${pass} passed`);
