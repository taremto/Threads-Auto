# gas/ — Web版用 Google Apps Script

threads-auto-webapp（クラウドオフロード）連携用のGASプロジェクト。1スプシ＝1Threadsアカウント。

## ファイル構成
- `appscript.gs` — メインスクリプト（v3ベース + Web連携アクション拡張）
- `appsscript.json` — manifest（TZ=Asia/Tokyo、Web App=ANYONE_ANONYMOUS）
- `.clasp.json.template` — clasp用テンプレ（実値は setup-cloud.sh が埋める）

## v3との違い
| 項目 | v3 | この版 |
|---|---|---|
| 列数 | A〜M(13) | A〜O(15) — N=Web投稿ID, O=Web取込済 を追加 |
| doPost アクション | setConfig/clear/refresh/getLastDate/TSV | + healthCheck/pushQueue/updateByPostId/cancelByPostId/pullResults/ackResults |
| 60分ガード | なし | processScheduledPosts 冒頭で直近postedから60分判定 |

## セットアップ
通常は `setup-cloud.sh`（プロジェクトルートのスクリプト）から自動実行される。
手動セットアップする場合:
```bash
cp .clasp.json.template .clasp.json
# scriptId と rootDir を埋める
clasp push
```

## Web App デプロイ
clasp ではWeb App型デプロイができないため、ブラウザで手動:
1. スプシ → 拡張機能 → Apps Script
2. デプロイ → 新しいデプロイ → ウェブアプリ
3. 実行ユーザー=自分 / アクセス=全員 → デプロイ
4. 表示されたURLをWebアプリの「クラウドオフロード設定」に貼り付け
