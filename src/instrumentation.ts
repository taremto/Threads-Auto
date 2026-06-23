export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const cron = await import("node-cron");

    // 毎分: キューチェック → publishAtが到来した投稿をThreads APIで投稿
    // ※ クラウドオフロード（executor="gas"）は scheduler 側でフィルタされ拾わない
    cron.default.schedule("* * * * *", () => {
      import("@/lib/scheduler")
        .then(({ processQueue }) => processQueue())
        .catch((e) => console.error("[cron] processQueue error:", e));
    });

    // 毎朝5時: 自動生成（autoGenerate=trueのアカウント分）
    // ※ クラウドオフロード関係なくWeb側で実行（GASにClaude Codeはないため）
    cron.default.schedule(
      "0 5 * * *",
      () => {
        import("@/lib/auto-generate")
          .then(({ runAutoGenerate }) => runAutoGenerate())
          .catch((e) => console.error("[cron] autoGenerate error:", e));
      },
      { timezone: "Asia/Tokyo" }
    );

    // 5分おき: クラウドオフロード結果の同期（GAS→SQLite取込 + ack）
    cron.default.schedule("*/5 * * * *", () => {
      import("@/lib/gas-sync")
        .then(({ syncAllCloudAccounts }) => syncAllCloudAccounts())
        .catch((e) => console.error("[cron] cloud-sync error:", e));
    });

    // 起動直後は初回ページ表示を優先し、停止中にGASが行った投稿結果の同期は少し遅らせる。
    setTimeout(() => {
      import("@/lib/gas-sync")
        .then(({ syncAllCloudAccounts }) => syncAllCloudAccounts())
        .catch((e) => console.error("[startup] cloud-sync error:", e));
    }, 15_000);

    // 毎朝4時: 全アカウントの直近投稿Insights更新（views/likes等）。
    // 深夜帯でAPI負荷を分散。insights権限なし判定済みアカウントはスキップ。
    cron.default.schedule(
      "0 4 * * *",
      () => {
        import("@/lib/insights/fetch-runner")
          .then(({ fetchAllAccountsInsights }) => fetchAllAccountsInsights())
          .catch((e) => console.error("[cron] insights error:", e));
      },
      { timezone: "Asia/Tokyo" }
    );

    console.log("[scheduler] Background jobs started:");
    console.log("  - Queue processor: every 1 min");
    console.log("  - Auto-generate: daily at 05:00");
    console.log("  - Cloud sync: every 5 min + delayed startup");
    console.log("  - Insights refresh: daily at 04:00");
  }
}
