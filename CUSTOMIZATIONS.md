# カスタマイズ一覧（バージョンアップ時に再適用が必要）

このファイルは、製品版に含まれない独自カスタマイズを記録しています。

**バージョンアップ後、画面上部にオレンジの警告バナーが出たら**、Claude に以下を伝えるだけでOK:

```
@CUSTOMIZATIONS.md この内容を新バージョンに再適用して
```

---

## 自動検知の仕組み

- カスタマイズ情報は **データベース内** に保存されている（`AppSetting` テーブル `key=customizations`）
- DBはバージョンアップ時に自動で引き継がれる
- アプリ起動時に「DBにカスタマイズ登録があるのにコードが無い」状態を検知 → 画面上部にオレンジの警告バナーが出る
- つまり **忘れていても画面が教えてくれる**

---

## 1. ナレッジ ON/OFF トグル機能

**目的**: 生成テスト時に、使うナレッジを選択的にON/OFFできる

**変更箇所**:
- `prisma/schema.prisma` — Knowledge モデルに `enabled Boolean @default(true)` 追加
- `src/app/api/generate/route.ts` — ナレッジ取得クエリに `enabled: true` フィルタ追加
- `src/components/SettingsPage.tsx` — Knowledge型に `enabled` 追加、トグルUI追加、`handleToggleEnabled` 関数追加

**DBマイグレーション**:
```sql
ALTER TABLE "Knowledge" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
```

---

## 2.5 コンセプトシート AI 編集機能

**目的**: アカウント編集画面からAIに指示してコンセプトシートを編集できる

**変更箇所**:
- `src/app/api/accounts/concept-ai-edit/route.ts` — 新規作成
- `src/components/SettingsPage.tsx` — AccountsSection にAI編集ボタン・指示入力・プレビュー追加

---

## 2. ナレッジ AI 編集機能

**目的**: ダッシュボードからAIに指示してナレッジを編集できる

**変更箇所**:
- `src/app/api/knowledge/ai-edit/route.ts` — 新規作成（AI編集APIエンドポイント）
- `src/components/SettingsPage.tsx` — AI編集ボタン・指示入力・プレビュー・保存UI追加

---

## 3. カスタマイズ自動検知システム

**目的**: バージョンアップ後にカスタマイズが消えたことを自動で警告する

**変更箇所**:
- `src/app/api/customizations/route.ts` — 新規作成（カスタマイズ登録・チェックAPI）
- `src/components/Dashboard.tsx` — 起動時チェック＋警告バナー表示

**DB内データ**: `AppSetting` テーブルに `key=customizations` でJSON保存済み

---

## 3. 投稿 AI 修正機能

**目的**: 生成した投稿を編集モード中にAIへ指示して修正できる

**変更箇所**:
- `src/app/api/posts/ai-edit/route.ts` — 新規作成（投稿AI修正APIエンドポイント）
- `src/components/PostCard.tsx` — 編集モード内にAI修正パネル追加（紫色エリア）

**使い方**: 投稿カードの「編集」ボタン → 下部の🤖 AI修正欄に指示を入力 → 「修正」ボタン → プレビュー確認 → 「適用」で本文に反映 → 「保存」

---

## 4. ナレッジ・コンセプト全文プレビュー欄

**目的**: ナレッジやアカウントコンセプトの入力欄だけでは全体を見渡しづらいため、設定画面の右側に全文を確認できる欄を表示する

**変更箇所**:
- `src/components/SettingsPage.tsx` — 設定画面の横幅を `max-w-7xl` に拡張
- `src/components/SettingsPage.tsx` — アカウント編集時に右側へ「コンセプト全文」プレビュー欄を追加
- `src/components/SettingsPage.tsx` — ナレッジ管理画面に右側全文プレビュー欄を追加
- `src/components/SettingsPage.tsx` — ナレッジカード選択時・新規作成時・編集中・AI編集プレビュー時に右側欄の内容を切り替える
- `src/components/SettingsPage.tsx` — `ContentPreviewPanel` コンポーネント追加
- `src/components/SettingsPage.tsx` — 右側全文プレビュー欄を `sticky` 追従表示にし、下へスクロールしても見失わないよう調整
- `src/components/SettingsPage.tsx` — 設定画面ラッパーの `overflow-y-auto` を外し、実際のページスクロールに追従できるよう調整

**使い方**:
- ナレッジ画面でカードをクリックすると、右側にそのナレッジ全文が表示される
- ナレッジを新規作成・編集している間は、入力中の本文が右側に表示される
- アカウント編集画面では、コンセプトシートの全文が右側に表示される
- AI編集結果がある場合は、右側にもAIプレビュー内容が表示される
- 下へスクロールしても、右側の全文プレビュー欄は画面内に追従して表示される

---

## 5. AI投稿生成の追加指示欄

**目的**: 通常のコンセプト・ナレッジに加えて、今回の生成だけに効かせたいテーマ縛り・CTA指定・禁止表現などを指定できる

**変更箇所**:
- `src/components/GenerateModal.tsx` — 追加指示 textarea、モーダル幅拡張、スクロール対応を追加
- `src/app/api/generate/route.ts` — `extraInstructions` を受け取り、生成プロンプトの冒頭と末尾に最優先指示として挿入

**使い方**:
- 投稿画面の「AI生成」ボタン → 「追加指示（任意）」に今回だけの条件を書く → 生成
- 空欄なら従来どおり生成される

---

## 6. スマホ表示対応

**目的**: スマホ幅でも投稿一覧・キュー・設定を操作しやすくする

**変更箇所**:
- `src/app/layout.tsx` — viewport 設定を追加し、モバイルでの拡大縮小ずれを抑制
- `src/components/Sidebar.tsx` — デスクトップのみ左サイドバー表示に変更
- `src/components/Dashboard.tsx` — モバイル上部バー、下部ナビゲーション、余白・ボタン文言・警告文のモバイル最適化を追加

**使い方**:
- PCでは従来どおり左サイドバー
- スマホでは下部ナビから「下書き / キュー / 投稿済み / 設定」を切り替える

---

## 7. ナレッジ md 編集・DB同期ワークフロー

**目的**: Web画面だけでなく、`knowledge/` フォルダ内のMarkdownをClaude CodeやVSCodeで編集し、DBへ同期できるようにする

**変更箇所**:
- `knowledge/` — DB内ナレッジをMarkdown化した作業フォルダを追加
- `knowledge/README.md` — フロントマター、編集手順、同期時の注意を追加
- `knowledge-sync.js` — `knowledge/` のMarkdown差分をDBへ同期するスクリプトを追加
- `CLAUDE.md` — ナレッジ編集時の作業ルールを追加

**使い方**:
- `knowledge/カスタム-raito_tenshoku/` 配下のmdを編集
- 反映前確認: `node knowledge-sync.js`
- DBへ反映: `node knowledge-sync.js --apply`
- `id:` はDB同期キーなので絶対に変更しない

---

## 8. Claude CLI 課金モード誤検知の安全化

**目的**: Claude Code が自動設定する公式 `ANTHROPIC_BASE_URL` を、危険なAPI課金モードとして誤検知しないようにする

**変更箇所**:
- `src/lib/claude-cli.ts` — `ANTHROPIC_BASE_URL=https://api.anthropic.com` と末尾スラッシュ付き公式URLを安全値として扱う

**補足**:
- `ANTHROPIC_API_KEY` など実際にAPI課金へ切り替わる環境変数は引き続き警告対象
- 生成エラー対応時に、公式デフォルトURLだけで不要な再ログイン案内を出さないための調整

---

## 9. AI投稿生成の類似チェック・投稿タイプローテーション

**目的**: 生成される投稿内容が似通うのを抑え、毎回ちがう切り口・場面・感情で下書きを作る

**変更箇所**:
- `src/lib/generation-diversity.ts` — 投稿タイプ、具体場面、読者感情のローテーション生成、過去投稿のグルーピング、n-gram 類似度チェックを追加
- `src/app/api/generate/route.ts` — 生成前に直近投稿を取得してプロンプトへ類似回避指示を挿入、生成後に過去投稿・同一バッチ内の類似投稿を保存対象から除外、保存時に `memo` へ生成タイプ情報を記録
- `src/components/GenerateModal.tsx` — 類似投稿をスキップした場合、生成完了メッセージに件数を表示

**使い方**:
- 通常どおり「AI生成」を押すだけで、直近投稿との類似回避と投稿タイプのローテーションが自動で効く
- 生成結果がすべて似すぎている場合は保存せず、別の場面・悩み・結論を追加指示で指定するよう案内する

---

## 再適用時に Claude がやること

1. スキーマに `enabled` カラムがなければ追加してマイグレーション実行
2. 生成APIに `enabled: true` フィルタがなければ追加
3. `src/app/api/knowledge/ai-edit/route.ts` がなければ作成
4. `src/app/api/customizations/route.ts` がなければ作成
5. UIにトグルとAI編集ボタンがなければ追加
6. Dashboardに警告バナーチェックがなければ追加
7. `npx prisma generate` 実行
8. `src/app/api/posts/ai-edit/route.ts` がなければ作成
9. `PostCard.tsx` の編集モードにAI修正パネル（紫色エリア）がなければ追加
10. `SettingsPage.tsx` に右側全文プレビュー欄（`ContentPreviewPanel`）がなければ追加
11. 設定画面のコンテンツ幅が `max-w-7xl` でなければ拡張
12. ナレッジ管理・アカウント編集フォームが `lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.82fr)]` 相当の2カラム表示でなければ調整
13. 設定画面ラッパーが `overflow-visible` で、`ContentPreviewPanel` が `lg:sticky lg:top-6` 相当の追従表示になっているか確認
14. `GenerateModal.tsx` と生成APIに `extraInstructions` がなければ追加
15. モバイル用の上部バー・下部ナビ・viewport設定・デスクトップ専用サイドバーがなければ追加
16. `knowledge/` フォルダ、`knowledge-sync.js`、ナレッジ編集ルールがなければ追加
17. `src/lib/claude-cli.ts` で公式 `ANTHROPIC_BASE_URL` を安全値として扱っていなければ追加
18. `src/lib/generation-diversity.ts` と生成APIの類似チェック・投稿タイプローテーションがなければ追加

データ（ナレッジのON/OFF状態・カスタマイズ登録情報）はDB経由で引き継がれるので消えません。
