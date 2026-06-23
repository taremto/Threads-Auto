"use client";

import { useState, useEffect } from "react";

type AccountStats = {
  id: string;
  name: string;
  threadsUsername: string | null;
  draft: number;
  queued: number;
  posted: number;
  error: number;
  total: number;
};

type Tab = "draft" | "queued" | "posted" | "error";

type OverviewPageProps = {
  onNavigate: (accountId: string, tab: Tab) => void;
};

export default function OverviewPage({ onNavigate }: OverviewPageProps) {
  const [stats, setStats] = useState<AccountStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/accounts/stats")
      .then((r) => {
        if (!r.ok) return [];
        return r.json();
      })
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const totals = stats.reduce(
    (acc, s) => ({
      draft: acc.draft + s.draft,
      queued: acc.queued + s.queued,
      posted: acc.posted + s.posted,
      error: acc.error + s.error,
      total: acc.total + s.total,
    }),
    { draft: 0, queued: 0, posted: 0, error: 0, total: 0 }
  );

  // 最初のアカウントへのショートカット
  const firstId = stats[0]?.id;

  if (loading) {
    return (
      <div className="min-w-[720px] flex-1 p-8">
        <p className="text-gray-400">読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="min-w-[720px] flex-1 overflow-y-auto">
      <div className="px-8 pt-6 pb-4">
        <h2 className="text-xl font-bold text-gray-800">全体概要</h2>
      </div>

      {/* 全体サマリ */}
      <div className="px-8 grid grid-cols-4 gap-4 mb-8">
        <StatCard
          label="下書き"
          value={totals.draft}
          color="#ff9800"
          onClick={firstId ? () => onNavigate(firstId, "draft") : undefined}
        />
        <StatCard
          label="キュー"
          value={totals.queued}
          color="#2196f3"
          onClick={firstId ? () => onNavigate(firstId, "queued") : undefined}
        />
        <StatCard
          label="投稿済み"
          value={totals.posted}
          color="#4caf50"
          onClick={firstId ? () => onNavigate(firstId, "posted") : undefined}
        />
        <StatCard
          label="エラー"
          value={totals.error}
          color="#f44336"
          onClick={firstId ? () => onNavigate(firstId, "error") : undefined}
        />
      </div>

      {/* アカウント別 */}
      <div className="px-8 pb-8">
        <h3 className="text-sm font-bold text-gray-600 mb-3">
          アカウント別（{stats.length}件）
        </h3>
        {stats.length === 0 ? (
          <p className="text-gray-400 text-sm">
            アカウントがまだありません。左サイドバーから追加してください。
          </p>
        ) : (
          <div className="space-y-3">
            {stats.map((s) => (
              <div
                key={s.id}
                className="bg-white rounded-xl p-5 shadow-sm border border-gray-100"
              >
                <div className="flex items-center justify-between mb-3">
                  <button
                    onClick={() => onNavigate(s.id, "draft")}
                    className="hover:opacity-70 transition-opacity text-left"
                  >
                    <span className="font-bold text-gray-800">{s.name}</span>
                    {s.threadsUsername && (
                      <span className="ml-2 text-xs text-gray-400">
                        @{s.threadsUsername}
                      </span>
                    )}
                  </button>
                  <span className="text-xs text-gray-400">
                    合計 {s.total} 件
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <MiniStat
                    label="下書き"
                    value={s.draft}
                    color="#ff9800"
                    onClick={() => onNavigate(s.id, "draft")}
                  />
                  <MiniStat
                    label="キュー"
                    value={s.queued}
                    color="#2196f3"
                    onClick={() => onNavigate(s.id, "queued")}
                  />
                  <MiniStat
                    label="投稿済み"
                    value={s.posted}
                    color="#4caf50"
                    onClick={() => onNavigate(s.id, "posted")}
                  />
                  <MiniStat
                    label="エラー"
                    value={s.error}
                    color="#f44336"
                    onClick={() => onNavigate(s.id, "error")}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={`bg-white rounded-xl p-5 shadow-sm border border-gray-100 ${onClick ? "cursor-pointer hover:shadow-md transition-shadow" : ""}`}
      onClick={onClick}
    >
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className="text-2xl font-bold" style={{ color }}>
        {value}
      </p>
    </div>
  );
}

function MiniStat({
  label,
  value,
  color,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  onClick?: () => void;
}) {
  return (
    <div
      className={`text-center ${onClick ? "cursor-pointer hover:opacity-70 transition-opacity" : ""}`}
      onClick={onClick}
    >
      <p className="text-xs text-gray-400">{label}</p>
      <p className="text-lg font-bold" style={{ color }}>
        {value}
      </p>
    </div>
  );
}
