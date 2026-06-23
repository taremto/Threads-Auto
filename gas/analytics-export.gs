/**
 * ぬこ式 Threads — 分析エクスポート用 Web App（表示回数TOP15 自動書き込み）
 * =====================================================================
 * これは「投稿実行用のクラウドオフロード(appscript.gs)」とは完全に別物です。
 * 投稿の仕組みには一切影響しません。
 *
 * ■ 使い方（最初の1回だけ）
 *  1. 書き込みたいスプレッドシートを開く
 *  2. 上のメニュー「拡張機能」→「Apps Script」を開く
 *  3. もとからあるコードを全部消して、このファイルの中身を全部貼り付けて保存（💾）
 *  4. 右上「デプロイ」→「新しいデプロイ」→ 種類は「ウェブアプリ」
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 全員
 *     →「デプロイ」を押す（初回はアクセス承認が出るので許可する）
 *  5. 表示された「ウェブアプリのURL」をコピー
 *  6. ぬこ式アプリの「分析」画面 →「スプレッドシート連携」にそのURLを貼り付けて保存
 *
 * 以降は分析画面の「スプレッドシートに送る」ボタンで、表示回数の上位15位が
 * このスプレッドシートの「表示回数TOP15」シートに自動で書き込まれます。
 */

// ぬこ式アプリ側と一致させる固定キー（変更しないでください）
var EXPORT_KEY = "nuko-sheet-export-v1";
// 書き込み先のシート（タブ）名。無ければ自動で作成します。
var SHEET_NAME = "表示回数TOP15";

function doPost(e) {
  try {
    var body = {};
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return _json({ status: "error", message: "リクエストの形式が不正です" });
    }

    if (body.key !== EXPORT_KEY) {
      return _json({ status: "error", message: "認証エラー: キーが一致しません" });
    }

    // 接続テスト（URL保存時にアプリが呼ぶ）
    if (body.action === "ping") {
      return _json({ status: "ok", version: "sheet-export-v1", sheet: SHEET_NAME });
    }

    var rows = body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return _json({ status: "error", message: "書き込むデータ(rows)がありません" });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET_NAME);
    if (!sh) sh = ss.insertSheet(SHEET_NAME);

    sh.clearContents();
    var cols = rows[0].length;
    sh.getRange(1, 1, rows.length, cols).setValues(rows);
    sh.setFrozenRows(1);
    // 見出し行を少しだけ装飾
    sh.getRange(1, 1, 1, cols).setFontWeight("bold");

    return _json({
      status: "ok",
      written: rows.length - 1, // 見出しを除いた件数
      sheet: SHEET_NAME,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return _json({ status: "error", message: String(err) });
  }
}

function doGet() {
  return _json({ status: "ok", version: "sheet-export-v1", hint: "このURLはPOSTで利用します" });
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
