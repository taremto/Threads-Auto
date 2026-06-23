/**
 * Threads予約投稿ツール — Web版ハイブリッド連携用 GAS
 *
 * ベース: nuko-threads-v3 appscript.gs (スプシ単体運用版)
 * 拡張: threads-auto-webapp（Next.js+SQLite）から呼び出される連携アクション群
 *   - pushQueue: Web側からの予約投稿Push
 *   - updateByPostId: Post.id をキーに行更新（編集競合対応）
 *   - cancelByPostId: Post.id をキーにキャンセル
 *   - healthCheck: Web側からの疎通確認
 *   - pullResults / ackResults: M3で追加（Web側に投稿結果を返却 + ack）
 *
 * 新規列: WEB_POST_ID(N=14), SYNCED(O=15)
 *   WEB_POST_ID は Webアプリ側 Post.id を保持し、行物理移動に強い検索キーとする
 *   SYNCED は Web側へpullResults返却済みかどうかのフラグ（"1"=ack済）
 *
 * 60分ガード: processScheduledPosts 冒頭で「同一スプシ内の直近 posted から60分」を判定し、
 * Webからの一括Push後の凍結事故を二段防御する
 */

// ============================================
// カラム定義
// ============================================
// A:グループ B:投稿テキスト C:タイプ D:予約日 E:時 F:分 G:文字数
// H:ステータス I:投稿ID J:投稿日時 K:投稿URL L:メモ M:エラー
// N:Web投稿ID（Webアプリ側 Post.id） O:Web取込済（"1"=ack済）

var COL = {
  GROUP:        1,   // A: グループ
  TEXT:         2,   // B: 投稿テキスト
  TYPE:         3,   // C: タイプ
  DATE:         4,   // D: 予約日
  HOUR:         5,   // E: 時
  MINUTE:       6,   // F: 分
  CHAR_COUNT:   7,   // G: 文字数
  STATUS:       8,   // H: ステータス
  POST_ID:      9,   // I: 投稿ID
  DONE_AT:     10,   // J: 投稿日時
  POST_URL:    11,   // K: 投稿URL
  MEMO:        12,   // L: メモ
  ERROR:       13,   // M: エラー
  WEB_POST_ID: 14,   // N: Webアプリ側 Post.id（Push時に書き込み）
  SYNCED:      15,   // O: Web取込済 ("1"=ack済)
  MEDIA:       16,   // P: 添付メディアURL（JSON配列。画像カルーセル対応。空=テキスト投稿）
};
var TOTAL_COLS = 13;       // v3互換: TSV書き込み等の既存パスはここまで
var TOTAL_COLS_V2 = 16;    // Web連携拡張カラム含む（N:WebID O:取込済 P:メディア）
var API_BASE_ = 'https://graph.threads.net/v1.0/';
var GAS_VERSION = 'webapp-v1.1.12';
var POST_INTERVAL_MIN = 60; // 凍結対策: 直近postedから60分以内なら投稿スキップ
// 予約時刻からの猶予分数。GAS の時間ベーストリガーは「分の中で誤差を持って発火」する仕様
// （例: 12:13 トリガーが 12:13:58 に走り、スプシ判定時には 12:14:01 になることがある）。
// 旧値 1 分だと58秒で発火した場合に構造的にスキップが発生していた。WebUI 側 scheduler.ts の
// 同等ガード（15分）と統一し、誤差を吸収する。
var PAST_DUE_GRACE_MIN = 15;
var PENDING_SUCCESS_PREFIX = 'POST_SUCCESS_PENDING_';
var PENDING_SUCCESS_TTL_DAYS = 30;

// ============================================
// セキュリティ & 設定
// ============================================

/** 実行内キャッシュ（PropertiesService呼び出し最小化） */
var _cfgCache = null;

function getConfig_() {
  if (_cfgCache) return _cfgCache;
  var props = PropertiesService.getScriptProperties();
  _cfgCache = {
    token: props.getProperty('THREADS_ACCESS_TOKEN') || '',
    userId: props.getProperty('THREADS_USER_ID') || '',
  };
  return _cfgCache;
}

function isConfigured_() {
  var c = getConfig_();
  return c.token !== '' && c.userId !== '';
}

/** エラーメッセージからトークンらしき文字列をマスク */
function maskToken_(str) {
  return String(str).replace(/[A-Za-z0-9_-]{20,}/g, '***');
}

function tokenFingerprint_(token) {
  return token ? token.substring(0, 8) + '…' + token.substring(token.length - 4) : null;
}

function getTokenState_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('THREADS_ACCESS_TOKEN') || '';
  var refreshedAt = parseInt(props.getProperty('TOKEN_REFRESHED_AT') || '0', 10);
  var expiresInSec = parseInt(props.getProperty('TOKEN_EXPIRES_IN_SEC') || '5184000', 10);
  var lastError = props.getProperty('TOKEN_LAST_ERROR') || null;
  var expiresAt = refreshedAt
    ? new Date(refreshedAt + expiresInSec * 1000).toISOString()
    : null;
  var status = 'ok';
  if (lastError) {
    status = 'failed';
  } else if (expiresAt) {
    var msLeft = new Date(expiresAt).getTime() - Date.now();
    if (msLeft < 7 * 24 * 60 * 60 * 1000) status = 'expiring_soon';
  }
  return {
    status: status,
    expiresAt: expiresAt,
    lastError: lastError,
    fingerprint: tokenFingerprint_(token),
  };
}

/** HTML特殊文字エスケープ（XSS防止） */
function escapeHtml_(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================
// API ヘルパー（トークンは常にAuthorizationヘッダー）
// ============================================

/**
 * GET リクエスト
 * - トークンはAuthorizationヘッダー優先
 * - カンマ等の特殊文字はエンコードしない（Graph API互換）
 */
function apiGet_(path, params) {
  var c = getConfig_();
  if (!c.token) throw new Error('トークン未設定');
  var url = API_BASE_ + path;
  if (params) {
    var qs = Object.keys(params).map(function(k) {
      return k + '=' + params[k];
    }).join('&');
    url += '?' + qs;
  }
  // Bearer優先、フォールバック用にURLパラメータも付与
  url += (url.indexOf('?') === -1 ? '?' : '&') + 'access_token=' + c.token;
  var resp = UrlFetchApp.fetch(url, {
    headers: { 'Authorization': 'Bearer ' + c.token },
    muteHttpExceptions: true,
  });
  return parseApiResponse_(resp);
}

/**
 * POST リクエスト
 * - トークンはAuthorizationヘッダー + payloadフォールバック
 */
function apiPost_(path, payload) {
  var c = getConfig_();
  if (!c.token) throw new Error('トークン未設定');
  payload = payload || {};
  payload.access_token = c.token; // フォールバック
  var resp = UrlFetchApp.fetch(API_BASE_ + path, {
    method: 'post',
    headers: { 'Authorization': 'Bearer ' + c.token },
    payload: payload,
    muteHttpExceptions: true,
  });
  return parseApiResponse_(resp);
}

/** レスポンス解析（エラー時はトークンマスク済み） */
function parseApiResponse_(resp) {
  var code = resp.getResponseCode();
  var body;
  try {
    // 投稿IDが2^53を超えるとJSON.parseで精度損失が発生するため、
    // "id" フィールドの数値を文字列に変換してからパースする
    var raw = resp.getContentText();
    raw = raw.replace(/"id"\s*:\s*(\d{16,})/g, '"id": "$1"');
    body = JSON.parse(raw);
  } catch (e) {
    throw new Error('APIレスポンス解析失敗 (HTTP ' + code + ')');
  }
  if (code !== 200) {
    var msg = 'HTTP ' + code;
    if (body.error) {
      msg += ': ' + (body.error.message || '不明');
      if (body.error.type) msg += ' [' + body.error.type + ']';
      if (body.error.code) msg += ' (code:' + body.error.code + ')';
    }
    throw new Error(maskToken_(msg));
  }
  return body;
}

// ============================================
// メニュー
// ============================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('自動投稿')
    .addItem('全件承認', 'approveAllDrafts')
    .addSeparator()
    .addItem('トリガー ON（1分間隔）', 'setupTrigger')
    .addItem('トリガー OFF', 'removeTrigger')
    .addSeparator()
    .addItem('接続テスト', 'testConnection')
    .addItem('テスト投稿', 'testScheduledPost')
    .addSeparator()
    .addItem('📱 プレビュー', 'openPreview')
    .addSeparator()
    .addItem('🖼 画像投稿のDrive権限を承認', 'authorizeDrive')
    .addToUi();

  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿管理')) {
    showWelcome();
  }
}

/** ポスト文が編集されたら文字数を自動更新、グループ番号変更時にタイプを自動設定 */
function onEdit(e) {
  if (!e || !e.range) return;
  var sheet = e.range.getSheet();
  if (sheet.getName() !== '投稿管理') return;

  var col = e.range.getColumn();
  var row = e.range.getRow();
  if (row <= 1) return;

  if (col === COL.TEXT) {
    var text = e.range.getValue();
    sheet.getRange(row, COL.CHAR_COUNT).setValue(text ? String(text).length : 0);
  }

  // グループ番号が変更されたらタイプを自動設定
  if (col === COL.GROUP) {
    updateTypeColumn_(sheet, row);
  }

  // タイプ列: 英語値を日本語に自動変換
  if (col === COL.TYPE) {
    var typeVal = String(e.range.getValue()).toUpperCase();
    var typeMap = { 'NEW': '単体', 'REPLY': 'スレッド', 'SINGLE': '単体', 'THREAD': 'スレッド' };
    if (typeMap[typeVal]) e.range.setValue(typeMap[typeVal]);
  }

  // ステータス列: 英語値を日本語に自動変換
  if (col === COL.STATUS) {
    var statusVal = String(e.range.getValue()).toLowerCase();
    var statusMap = { 'pending': '待機中', 'published': '投稿済', 'error': 'エラー', 'draft': '下書き' };
    if (statusMap[statusVal]) e.range.setValue(statusMap[statusVal]);
  }
}

/** グループ番号に基づいてタイプ列を自動設定 */
function updateTypeColumn_(sheet, editedRow) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var groupVal = sheet.getRange(editedRow, COL.GROUP).getValue();
  if (!groupVal && groupVal !== 0) {
    sheet.getRange(editedRow, COL.TYPE).setValue('');
    return;
  }

  // 同じグループ番号が他の行にもあるか確認
  var allGroups = sheet.getRange(2, COL.GROUP, lastRow - 1, 1).getValues();
  var count = 0;
  for (var i = 0; i < allGroups.length; i++) {
    if (allGroups[i][0] == groupVal) count++;
  }

  var type = count > 1 ? 'スレッド' : '単体';
  sheet.getRange(editedRow, COL.TYPE).setValue(type);

  // 同じグループ番号の他の行もスレッドに更新
  if (count > 1) {
    for (var j = 0; j < allGroups.length; j++) {
      if (allGroups[j][0] == groupVal) {
        sheet.getRange(j + 2, COL.TYPE).setValue('スレッド');
      }
    }
  }
}

// ============================================
// ウェルカム
// ============================================

function showWelcome() {
  var html = HtmlService.createHtmlOutput(
    '<style>' +
    '  body{font-family:-apple-system,sans-serif;padding:28px 32px;text-align:center;color:#1a1a1a;background:#fafafa}' +
    '  h2{margin:0 0 4px;font-size:22px;font-weight:700;letter-spacing:-0.3px}' +
    '  .sub{color:#666;font-size:13px;margin-bottom:28px}' +
    '  .steps{text-align:left;max-width:340px;margin:0 auto 28px}' +
    '  .step{display:flex;align-items:flex-start;gap:14px;margin-bottom:16px}' +
    '  .num{background:#4FC3F7;color:#fff;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex-shrink:0}' +
    '  .txt{font-size:14px;line-height:1.6;padding-top:2px;color:#333}' +
    '  .btn{padding:13px 36px;background:#4FC3F7;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .15s}' +
    '  .btn:hover{background:#039BE5}' +
    '</style>' +
    '<h2>Auto Post</h2>' +
    '<p class="sub">予約投稿 / スレッド投稿 / 自動管理</p>' +
    '<div class="steps">' +
    '  <div class="step"><div class="num">1</div><div class="txt">下の「初期設定を開始」をクリック</div></div>' +
    '  <div class="step"><div class="num">2</div><div class="txt">Threads API の User ID と Access Token を入力</div></div>' +
    '  <div class="step"><div class="num">3</div><div class="txt">投稿を入力して自動投稿スタート</div></div>' +
    '</div>' +
    '<button class="btn" onclick="google.script.run.withSuccessHandler(function(){google.script.host.close()}).showSettingsDialog()">初期設定を開始</button>'
  ).setWidth(440).setHeight(350);
  SpreadsheetApp.getUi().showModalDialog(html, 'Auto Post');
}

// ============================================
// シート初期化
// ============================================

function initSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // スプレッドシートのタイムゾーンをAsia/Tokyoに強制設定
  // （GASプロジェクトのTZとは別。ユーザーのGoogleアカウント設定に依存するため明示的に設定する）
  ss.setSpreadsheetTimeZone('Asia/Tokyo');

  initPostSheet(ss);

  // 不要なシートを削除
  var toDelete = ['シート1', 'Sheet1', 'インサイト'];
  toDelete.forEach(function(name) {
    var s = ss.getSheetByName(name);
    if (s && ss.getSheets().length > 1) {
      try { ss.deleteSheet(s); } catch(e) {}
    }
  });

  // トークン自動更新トリガーをセット（トリガーON/OFFに関係なく常に有効）
  setupTokenRefreshTrigger_();

  ss.setActiveSheet(ss.getSheetByName('投稿管理'));
}

function initPostSheet(ss) {
  var sheet = ss.getSheetByName('投稿管理');
  if (!sheet) sheet = ss.insertSheet('投稿管理');

  applyPostSheetFormat_(sheet, 300);

  // 空のシートで開始

  sheet.setTabColor('#29B6F6');
}

// ============================================
// シート書式共通（init と refresh で再利用）
// ============================================

function applyPostSheetFormat_(sheet, R) {
  // --- ヘッダー（テーブル風チップデザイン） ---
  var headers = [
    'No.', '投稿テキスト', 'タイプ', '予約日',
    '時', '分', '文字数',
    'ステータス', '', '投稿日時', '投稿URL', 'メモ', 'エラー'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // ヘッダー行: 水色背景＋白文字＋丸ゴシック
  var hr = sheet.getRange(1, 1, 1, headers.length);
  hr.setBackground('#4FC3F7');
  hr.setFontColor('#ffffff');
  hr.setFontWeight('bold');
  hr.setFontSize(10);
  hr.setFontFamily('Arial');
  hr.setHorizontalAlignment('center');
  hr.setVerticalAlignment('middle');
  sheet.setRowHeight(1, 36);

  // ヘッダーの上下左右に薄い白ボーダー（チップ区切り風）
  hr.setBorder(true, true, true, true, true, true, '#81D4FA', SpreadsheetApp.BorderStyle.SOLID);

  // --- 全体のデフォルト ---
  var dataRange = sheet.getRange(2, 1, R, TOTAL_COLS);
  dataRange.setFontFamily('Arial').setFontSize(10).setVerticalAlignment('middle');
  dataRange.setBackground('#ffffff');

  // --- 列幅 ---
  sheet.setColumnWidth(COL.GROUP, 48);
  sheet.setColumnWidth(COL.TEXT, 520);
  sheet.setColumnWidth(COL.TYPE, 65);
  sheet.setColumnWidth(COL.DATE, 95);
  sheet.setColumnWidth(COL.HOUR, 36);
  sheet.setColumnWidth(COL.MINUTE, 36);
  sheet.setColumnWidth(COL.CHAR_COUNT, 48);
  sheet.setColumnWidth(COL.STATUS, 78);
  sheet.setColumnWidth(COL.POST_ID, 10);   // 非表示レベルに狭く
  sheet.setColumnWidth(COL.DONE_AT, 120);
  sheet.setColumnWidth(COL.POST_URL, 220);
  sheet.setColumnWidth(COL.MEMO, 140);
  sheet.setColumnWidth(COL.ERROR, 180);

  // 投稿ID列を非表示
  sheet.hideColumns(COL.POST_ID);

  // --- No.列 ---
  var groupRange = sheet.getRange(2, COL.GROUP, R, 1);
  groupRange.setHorizontalAlignment('center');
  groupRange.setFontWeight('bold');
  groupRange.setFontSize(11);
  groupRange.setFontColor('#4FC3F7');

  // --- 投稿テキスト ---
  var textRange = sheet.getRange(2, COL.TEXT, R, 1);
  textRange.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
  textRange.setVerticalAlignment('top');
  textRange.setFontSize(10);
  textRange.setFontColor('#222222');

  // --- タイプ列（チップ風） ---
  sheet.getRange(2, COL.TYPE, R, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['単体', 'スレッド']).setAllowInvalid(false).build())
    .setHorizontalAlignment('center').setFontSize(9).setFontColor('#555555');

  // --- 予約日 ---
  sheet.getRange(2, COL.DATE, R, 1).setNumberFormat('yyyy/mm/dd');
  sheet.getRange(2, COL.DATE, R, 1).setHorizontalAlignment('center');
  sheet.getRange(2, COL.DATE, R, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()
  );

  // --- 時 ドロップダウン ---
  var hours = [];
  for (var h = 0; h <= 23; h++) hours.push(String(h));
  sheet.getRange(2, COL.HOUR, R, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(hours).setAllowInvalid(false).build()
  ).setHorizontalAlignment('center').setFontSize(9);

  // --- 分 ドロップダウン ---
  var mins = [];
  for (var m = 0; m < 60; m++) mins.push(String(m));
  sheet.getRange(2, COL.MINUTE, R, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(mins).setAllowInvalid(false).build()
  ).setHorizontalAlignment('center').setFontSize(9);

  // --- 文字数 ---
  sheet.getRange(2, COL.CHAR_COUNT, R, 1)
    .setHorizontalAlignment('center').setFontColor('#aaaaaa').setFontSize(9);

  // --- ステータス（チップ風に丸みのあるデザインは条件付き書式で表現） ---
  sheet.getRange(2, COL.STATUS, R, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['下書き', '待機中', '投稿済', 'エラー']).setAllowInvalid(false).build())
    .setHorizontalAlignment('center').setFontWeight('bold').setFontSize(9);

  // --- ステータスのデフォルト（データがある行のみ） ---
  var lastDataRow = sheet.getLastRow();
  if (lastDataRow >= 2) {
    var dataRows = lastDataRow - 1;
    var statusValues = sheet.getRange(2, COL.STATUS, dataRows, 1).getValues();
    var textValues = sheet.getRange(2, COL.TEXT, dataRows, 1).getValues();
    for (var si = 0; si < statusValues.length; si++) {
      if (textValues[si][0] && !statusValues[si][0]) statusValues[si][0] = '下書き';
    }
    sheet.getRange(2, COL.STATUS, dataRows, 1).setValues(statusValues);
  }

  // --- 結果列 ---
  sheet.getRange(2, COL.POST_ID, R, 1).setNumberFormat('@').setFontColor('#ffffff').setFontSize(8);
  sheet.getRange(2, COL.DONE_AT, R, 1).setNumberFormat('yyyy/mm/dd hh:mm').setFontColor('#888888').setFontSize(9).setHorizontalAlignment('center');
  sheet.getRange(2, COL.POST_URL, R, 1).setFontColor('#4FC3F7').setFontSize(9);
  sheet.getRange(2, COL.ERROR, R, 1).setFontColor('#ef5350').setFontSize(9);

  // --- メモ列 ---
  sheet.getRange(2, COL.MEMO, R, 1)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP)
    .setFontSize(9).setFontColor('#777777');

  // --- 条件付き書式 ---
  var charRange = [sheet.getRange(2, COL.CHAR_COUNT, R, 1)];
  var statusRange = [sheet.getRange(2, COL.STATUS, R, 1)];
  var rowRange = [sheet.getRange(2, 1, R, TOTAL_COLS)];
  var typeRange = [sheet.getRange(2, COL.TYPE, R, 1)];

  var rules = [];

  // 文字数オーバー
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberGreaterThan(500).setBackground('#fff0f0').setFontColor('#e53935')
    .setRanges(charRange).build());

  // ステータス: 投稿済（ミントグリーン）
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('投稿済').setBackground('#e0f7fa').setFontColor('#00838f')
    .setRanges(statusRange).build());
  // ステータス: 下書き（黄色 — 未承認）
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('下書き').setBackground('#fff9c4').setFontColor('#f9a825')
    .setRanges(statusRange).build());
  // ステータス: 待機中（ソフトブルー — 承認済み・投稿待ち）
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('待機中').setBackground('#e8f0fe').setFontColor('#1967d2')
    .setRanges(statusRange).build());
  // ステータス: エラー
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('エラー').setBackground('#fce8e6').setFontColor('#d93025')
    .setRanges(statusRange).build());

  // タイプ: スレッド（薄紫チップ風）
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('スレッド').setBackground('#f3e8fd').setFontColor('#7b1fa2')
    .setRanges(typeRange).build());
  // タイプ: 単体（薄グレー）
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('単体').setBackground('#f1f3f4').setFontColor('#5f6368')
    .setRanges(typeRange).build());

  // 投稿済行をグレーアウト
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$H2="投稿済"')
    .setBackground('#f8f9fa').setFontColor('#dadce0')
    .setRanges(rowRange).build());

  sheet.setConditionalFormatRules(rules);

  // --- 罫線 ---
  // 全セルの罫線をリセット
  sheet.getRange(1, 1, R + 1, TOTAL_COLS).setBorder(false, false, false, false, false, false);
  // データ行に薄いグリッド線（テーブル感を出す）
  sheet.getRange(2, 1, R, TOTAL_COLS).setBorder(null, null, null, null, null, true, '#e8eaed', SpreadsheetApp.BorderStyle.SOLID);
  // ヘッダー下線
  sheet.getRange(1, 1, 1, TOTAL_COLS).setBorder(null, null, true, null, null, null, '#29B6F6', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  sheet.setFrozenRows(1);
}

// ============================================
// Threads API
// ============================================

function testConnection() {
  var ui = SpreadsheetApp.getUi();
  var config = getConfig_();
  if (!config.token) {
    ui.alert('Access Token が未設定です。\n「自動投稿」>「API設定」から設定してください。');
    return;
  }

  var results = [];
  try {
    var body = apiGet_('me', { fields: 'id,username' });
    results.push('プロフィール取得: OK');
    results.push('User ID: ' + body.id);
    results.push('ユーザー名: @' + (body.username || '不明'));

    if (config.userId && config.userId !== body.id) {
      var fix = ui.alert('User ID 不一致',
        '設定中: ' + config.userId + '\n正しい: ' + body.id + '\n\n自動修正しますか？',
        ui.ButtonSet.YES_NO);
      if (fix === ui.Button.YES) {
        PropertiesService.getScriptProperties().setProperty('THREADS_USER_ID', body.id);
        _cfgCache = null; // キャッシュクリア
        results.push('→ 修正しました');
      }
    } else {
      results.push('User ID: OK');
    }
  } catch (e) {
    results.push('エラー: ' + e.message);
    results.push('原因: トークン期限切れ or テスター未承認');
  }
  ui.alert('接続テスト', results.join('\n'), ui.ButtonSet.OK);
}

/**
 * Threadsに投稿（Bearer認証）
 * @param {string} text
 * @param {string} imageUrl
 * @param {string} replyToId - スレッド投稿時の親投稿ID
 * @return {object} { id: 公開ポストID, containerId: コンテナID }
 */
/** media引数(配列 / JSON文字列 / 単一URL文字列 / 空)を URL配列に正規化 */
function normalizeMedia_(media) {
  if (!media) return [];
  if (Array.isArray(media)) return media.filter(function(u){ return u; });
  var s = String(media).trim();
  if (s === '') return [];
  if (s.charAt(0) === '[') {
    try {
      var arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.filter(function(u){ return u; });
    } catch (e) {}
  }
  return [s];
}

/** 画像ホスティング用のDriveフォルダを取得（無ければ作成）。
 *  drive.file スコープでも確実に再利用できるよう、作成したフォルダIDをProperties保存する。 */
function getOrCreateMediaFolder_() {
  var props = PropertiesService.getScriptProperties();
  var saved = props.getProperty('MEDIA_FOLDER_ID');
  if (saved) {
    try {
      return DriveApp.getFolderById(saved);
    } catch (e) { /* 削除された等 → 作り直す */ }
  }
  var name = 'ThreadsAutoMedia';
  var folder;
  try {
    var it = DriveApp.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  } catch (e2) {
    folder = DriveApp.createFolder(name);
  }
  props.setProperty('MEDIA_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * 画像投稿に必要な Google Drive 権限を承認するための関数。
 * メニュー「🖼 画像投稿のDrive権限を承認」or エディタから一度実行すると Drive の承認画面が出る。
 * 許可すると以降の画像アップロード(uploadMedia)が通る。ついでにメディア用フォルダも作っておく。
 */
function authorizeDrive() {
  var folder = getOrCreateMediaFolder_();
  try {
    SpreadsheetApp.getUi().alert('✅ 画像投稿のGoogle Drive権限が承認されました。\n保存先フォルダ: ' + folder.getName());
  } catch (e) {
    Logger.log('Drive権限の承認OK / folder=' + folder.getName());
  }
}

/**
 * Threadsへ投稿する。
 * @param {string} text
 * @param {string|string[]} media - 画像の公開URL（空=テキスト, 1枚=IMAGE, 2枚以上=CAROUSEL）
 * @param {string} replyToId
 */
function postToThreads_(text, media, replyToId) {
  var c = getConfig_();
  if (!c.token || !c.userId) {
    throw new Error('API未設定。「自動投稿」>「API設定」から設定してください。');
  }

  var urls = normalizeMedia_(media);
  var created;

  if (urls.length >= 2) {
    // カルーセル: is_carousel_item の子コンテナをN個作り、親CAROUSELでまとめる
    var children = [];
    for (var ci = 0; ci < urls.length; ci++) {
      var child = apiPost_(c.userId + '/threads', {
        media_type: 'IMAGE',
        image_url: urls[ci],
        is_carousel_item: true,
      });
      children.push(child.id);
      Utilities.sleep(2000); // 子コンテナの準備待ち
    }
    var carouselPayload = {
      media_type: 'CAROUSEL',
      children: children.join(','),
      text: text,
    };
    if (replyToId) carouselPayload.reply_to_id = replyToId;
    created = apiPost_(c.userId + '/threads', carouselPayload);
    Utilities.sleep(3000);
  } else {
    var imageUrl = urls.length === 1 ? urls[0] : '';
    var payload = {
      media_type: imageUrl ? 'IMAGE' : 'TEXT',
      text: text,
    };
    if (imageUrl) payload.image_url = imageUrl;
    if (replyToId) payload.reply_to_id = replyToId;

    // Step1: コンテナ作成
    created = apiPost_(c.userId + '/threads', payload);
    if (imageUrl) Utilities.sleep(3000);
  }

  // Step2: 公開
  var published = apiPost_(c.userId + '/threads_publish', { creation_id: created.id });

  return {
    id: published.id,               // 公開ポストID（reply_to_id に使う）
    containerId: created.id,        // コンテナID（ステータス確認に使う）
  };
}

/**
 * コンテナIDのステータスが PUBLISHED になるまで待機
 * ※失敗してもフォールバックスリープで続行（中断しない）
 * @param {string} containerId - threads_publish ではなく threads で返った ID
 */
function waitForReady_(containerId) {
  var maxWait = 30000;
  var interval = 3000;
  var elapsed = 0;
  var confirmed = false;

  while (elapsed < maxWait) {
    Utilities.sleep(interval);
    elapsed += interval;
    try {
      var data = apiGet_(String(containerId), { fields: 'status' });
      if (data.status === 'PUBLISHED') {
        console.log('公開確認OK (ID: ' + containerId + ', ' + elapsed + 'ms)');
        confirmed = true;
        break;
      }
      if (data.status === 'ERROR' || data.status === 'EXPIRED') {
        console.log('ステータス異常: ' + data.status);
        break;
      }
      // IN_PROGRESS → 待ち続ける
    } catch (e) {
      console.log('ステータス確認エラー: ' + e.message);
      break;
    }
  }

  // PUBLISHED確認できてもAPI伝播に時間がかかる場合があるため
  // reply_to_id として使えるまでの追加バッファを入れる
  var buffer = confirmed ? 5000 : 10000;
  console.log((confirmed ? '伝播バッファ' : 'フォールバック') + ': ' + (buffer / 1000) + '秒待機');
  Utilities.sleep(buffer);
}

function isReplyPropagationError_(msg) {
  var s = String(msg || '').toLowerCase();
  return s.indexOf('requested resource does not exist') !== -1 ||
    s.indexOf('code:24') !== -1 ||
    s.indexOf('code: 24') !== -1;
}

function beginnerReplyPropagationMessage_(msg) {
  return 'Threads側で直前の投稿がまだ反映されていなかったため、続きの投稿に失敗しました。' +
    '時間を置いて、Webアプリのエラー画面から「失敗分だけ再試行」してください。' +
    '詳細: ' + maskToken_(msg);
}

function waitForReplyTargetReady_(postId, maxWaitMs) {
  if (!postId) return true;
  var started = new Date().getTime();
  var interval = 10000;
  while (new Date().getTime() - started < maxWaitMs) {
    try {
      var data = apiGet_(String(postId), { fields: 'id,permalink' });
      if (data && data.id) return true;
    } catch (e) {
      if (!isReplyPropagationError_(e.message)) {
        console.log('返信先投稿の確認エラー: ' + e.message);
        return false;
      }
    }
    Utilities.sleep(interval);
  }
  return false;
}

/**
 * リトライ付き投稿（一時的なAPI障害に対応）
 * "The requested resource does not exist" 等のエラーを最大3回リトライ
 * @param {string} text
 * @param {string} imageUrl
 * @param {string} replyToId
 * @return {object} { id, containerId }
 */
function postWithRetry_(text, imageUrl, replyToId) {
  var waits = replyToId ? [30000, 60000, 120000] : [5000, 10000];
  var maxAttempts = waits.length + 1;
  var lastErr;

  if (replyToId) {
    waitForReplyTargetReady_(replyToId, 30000);
  }

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return postToThreads_(text, imageUrl, replyToId);
    } catch (e) {
      lastErr = e;
      console.log('投稿リトライ ' + attempt + '/' + maxAttempts + ': ' + e.message);

      if (attempt < maxAttempts) {
        var wait = waits[attempt - 1];
        console.log(wait / 1000 + '秒待機後にリトライ...');
        Utilities.sleep(wait);
      }
    }
  }
  // 全リトライ失敗 → エラーメッセージにリトライ回数を付記
  var retries = maxAttempts - 1;
  var lastMsg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
  if (replyToId && isReplyPropagationError_(lastMsg)) {
    throw new Error(beginnerReplyPropagationMessage_(lastMsg) + '（' + retries + '回リトライ失敗）');
  }
  throw new Error(lastMsg + '（' + retries + '回リトライ失敗）');
}

/** 投稿IDからpermalinkを取得 */
function getPostPermalink_(postId) {
  try {
    var data = apiGet_(postId, { fields: 'permalink' });
    return data.permalink || '';
  } catch (e) {
    console.log('permalink取得エラー: ' + e.message);
    return '';
  }
}

// ============================================
// 投稿処理
// ============================================

/** 行データを読み取る */
function readRow_(sheet, row) {
  var vals = sheet.getRange(row, 1, 1, TOTAL_COLS).getValues()[0];
  return {
    group:    vals[COL.GROUP - 1],
    text:     vals[COL.TEXT - 1],
    type:     vals[COL.TYPE - 1],
    date:     vals[COL.DATE - 1],
    hour:     vals[COL.HOUR - 1],
    minute:   vals[COL.MINUTE - 1],
    status:   vals[COL.STATUS - 1],
    postId:   vals[COL.POST_ID - 1],
  };
}

/** 選択行を単体投稿 */
function postSelectedRow() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getPostSheet_(); if (!sheet) return;
  if (!checkConfig_(ui)) return;

  var row = SpreadsheetApp.getActiveRange().getRow();
  if (row <= 1) { ui.alert('2行目以降を選択してください。'); return; }

  var d = readRow_(sheet, row);
  if (!d.text) { ui.alert('ポスト文が空です。'); return; }
  if (d.status === '投稿済') { ui.alert('既に投稿済みです。'); return; }

  var preview = String(d.text).length > 60 ? String(d.text).substring(0, 60) + '...' : d.text;
  if (ui.alert('投稿確認', preview, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  try {
    var result = postToThreads_(d.text, '', null);
    markPostSuccessAfterPublish_(sheet, row, result.id);
    ui.alert('投稿完了！');
  } catch (e) {
    writeError_(sheet, row, e.message);
    ui.alert('投稿失敗:\n' + e.message);
  }
}

/** 選択スレッドをまとめて投稿 */
function postSelectedThread() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getPostSheet_(); if (!sheet) return;
  if (!checkConfig_(ui)) return;

  var row = SpreadsheetApp.getActiveRange().getRow();
  if (row <= 1) { ui.alert('スレッドの行を選択してください。'); return; }

  var groupNo = sheet.getRange(row, COL.GROUP).getValue();
  if (!groupNo && groupNo !== 0) {
    ui.alert('選択行にグループ番号がありません。\n単体投稿は「選択行を投稿」を使ってください。');
    return;
  }

  // 選択行の日付を取得（グループ番号＋日付でグルーピング）
  var groupDate = sheet.getRange(row, COL.DATE).getValue();

  // 同じグループNo＋同じ日付の行を収集
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var allData = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  var threadRows = [];

  for (var i = 0; i < allData.length; i++) {
    if (allData[i][COL.GROUP - 1] == groupNo && isSameDate_(allData[i][COL.DATE - 1], groupDate)) {
      threadRows.push({
        idx: i,
        row: i + 2,
        text: allData[i][COL.TEXT - 1],
        status: allData[i][COL.STATUS - 1],
        postId: allData[i][COL.POST_ID - 1],
      });
    }
  }

  var pending = threadRows.filter(function(r) { return r.status !== '投稿済'; });
  if (pending.length === 0) { ui.alert('グループ ' + groupNo + ' は全て投稿済みです。'); return; }

  // 確認
  var msg = 'グループ ' + groupNo + '（' + threadRows.length + '件）を投稿しますか？\n\n';
  threadRows.forEach(function(r, i) {
    var mark = r.status === '投稿済' ? '✓' : '○';
    var txt = String(r.text).length > 35 ? String(r.text).substring(0, 35) + '...' : r.text;
    msg += mark + ' ' + (i + 1) + '. ' + txt + '\n';
  });
  if (ui.alert('スレッド投稿確認', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

  // 実行: 各投稿は前の投稿への返信としてチェーンする
  var prevPostId = null;
  var okCount = 0, ngCount = 0;
  for (var j = 0; j < threadRows.length; j++) {
    var tr = threadRows[j];

    if (tr.status === '投稿済') {
      if (tr.postId) prevPostId = String(tr.postId);
      okCount++;
      continue;
    }
    if (!tr.text) { writeError_(sheet, tr.row, 'テキスト空'); ngCount++; continue; }

    try {
      var replyTo = prevPostId ? String(prevPostId) : null;
      var result = postWithRetry_(tr.text, '', replyTo);
      markPostSuccessAfterPublish_(sheet, tr.row, result.id);

      // 次の投稿はこの投稿への返信にする（チェーン）
      prevPostId = String(result.id);
      okCount++;

      // 次の投稿がある場合、公開完了を待ってから進む
      if (j < threadRows.length - 1) {
        waitForReady_(result.containerId);
      }
    } catch (e) {
      writeError_(sheet, tr.row, e.message);
      ngCount++;
      for (var rest = j + 1; rest < threadRows.length; rest++) {
        if (threadRows[rest].status !== '投稿済') {
          writeError_(sheet, threadRows[rest].row, '前の投稿が失敗したため、続きの投稿を停止しました。Webアプリのエラー画面から「失敗分だけ再試行」してください。');
          ngCount++;
        }
      }
      // スレッドのチェーンが切れるため残りは中断
      ui.alert('スレッド投稿中にエラー（リトライ後も失敗）:\n' + e.message + '\n\n残り ' + (threadRows.length - j - 1) + ' 件は中断しました。');
      return;
    }
  }

  var summary = 'グループ ' + groupNo + ' の投稿が完了しました！\n' + okCount + '件成功';
  if (ngCount > 0) summary += '、' + ngCount + '件エラー';
  ui.alert(summary);
}

/** 予約投稿（トリガーから自動実行） */
function processScheduledPosts() {
  var runProps = PropertiesService.getScriptProperties();
  runProps.setProperty('LAST_PROCESS_ATTEMPT_AT', new Date().toISOString());
  // 二重実行防止: 前のトリガーがまだ実行中なら即スキップ
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    runProps.setProperty('LAST_PROCESS_SKIPPED_AT', new Date().toISOString());
    runProps.setProperty('LAST_PROCESS_SUMMARY', '別のトリガーが実行中のためスキップ');
    console.log('別のトリガーが実行中のためスキップ');
    return;
  }

  try {

  var sheet = getPostSheet_();
  if (!sheet || !isConfigured_()) return;

  // タイムゾーン安全チェック: Asia/Tokyo以外なら投稿しない
  var tz = Session.getScriptTimeZone();
  if (tz !== 'Asia/Tokyo') {
    console.error('タイムゾーンエラー: ' + tz + '（Asia/Tokyoが必要です）。投稿を中止しました。GASエディタ > プロジェクトの設定 でタイムゾーンを Asia/Tokyo に変更してください。');
    return;
  }

  var now = new Date();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  // 前回「Threads投稿は成功したが、スプシ記録だけ失敗した」行があれば先に復旧する。
  // 復旧できない場合も、その行は投稿済み扱いでスキップし、二重投稿を防ぐ。
  recoverPendingSuccesses_(sheet);

  // 連携拡張カラム(N,O)も含めて読む（v3互換のため getLastColumn で物理範囲を尊重）
  var readCols = Math.max(TOTAL_COLS, Math.min(sheet.getLastColumn(), TOTAL_COLS_V2));
  var allData = sheet.getRange(2, 1, lastRow - 1, readCols).getValues();

  // 60分ガード: 同一スプシ内の直近postedから60分以内なら今回はスキップ（凍結二段防御）
  // Webからの一括Push後にトリガーが連投するのを防ぐ。J列(DONE_AT)を権威とする
  var lastPostedAt = null;
  for (var p = 0; p < allData.length; p++) {
    if (allData[p][COL.STATUS - 1] === '投稿済') {
      var doneAt = allData[p][COL.DONE_AT - 1];
      if (doneAt) {
        var dt = doneAt instanceof Date ? doneAt : new Date(doneAt);
        if (!lastPostedAt || dt.getTime() > lastPostedAt.getTime()) lastPostedAt = dt;
      }
    }
  }
  var pendingForInterval = listPendingSuccesses_();
  for (var pp = 0; pp < pendingForInterval.length; pp++) {
    if (!pendingForInterval[pp].postedAt) continue;
    var pendingDt = new Date(pendingForInterval[pp].postedAt);
    if (!isNaN(pendingDt.getTime()) && (!lastPostedAt || pendingDt.getTime() > lastPostedAt.getTime())) {
      lastPostedAt = pendingDt;
    }
  }
  if (lastPostedAt) {
    var sinceMs = now.getTime() - lastPostedAt.getTime();
    if (sinceMs < POST_INTERVAL_MIN * 60 * 1000) {
      console.log('60分ガード: 直近投稿から ' + Math.round(sinceMs / 60000) + '分 < ' + POST_INTERVAL_MIN + '分。スキップ');
      return;
    }
  }

  // 分類
  var singles = [];
  var threads = {};

  for (var i = 0; i < allData.length; i++) {
    var status = allData[i][COL.STATUS - 1];
    var text = allData[i][COL.TEXT - 1];
    var date = allData[i][COL.DATE - 1];
    if (status !== '待機中' || !text || !date) continue;
    if (hasPendingSuccess_(i + 2, allData[i][COL.WEB_POST_ID - 1])) {
      console.log('投稿成功記録の復旧待ちのため再投稿をスキップ: 行' + (i + 2));
      continue;
    }

    var h = parseInt(allData[i][COL.HOUR - 1], 10) || 0;
    var m = parseInt(allData[i][COL.MINUTE - 1], 10) || 0;
    var scheduled = new Date(date);
    scheduled.setHours(h, m, 0, 0);
    if (scheduled > now) continue;
    // 予約時刻の分を過ぎた投稿は自動投稿しない。
    // 10:00予約は10:00台だけ許可し、10:01以降はキューに残してWeb側で時刻変更してもらう。
    var delayMs = now.getTime() - scheduled.getTime();
    var webPostId = allData[i][COL.WEB_POST_ID - 1];
    if (delayMs >= PAST_DUE_GRACE_MIN * 60 * 1000) {
      var delayMsg = '予約時刻を' + PAST_DUE_GRACE_MIN + '分以上過ぎたため自動投稿を止めています。必要ならWebアプリのキュー画面で「時刻変更」してください。予約=' + Utilities.formatDate(scheduled, 'Asia/Tokyo', 'MM/dd HH:mm') + ' 遅延=' + Math.round(delayMs / 60000) + '分';
      console.log('スキップ(期限超過): 行' + (i + 2) + ' ' + delayMsg);
      // メモ列だけでなく status も「エラー」に切り替える。これで次回 pullResults が WebUI 側へ
      // 「error」として通知し、ユーザーがエラータブで気付ける。旧実装は status を「待機中」のまま放置していたため、
      // WebUI 側 DB が永遠に queued のままになり、ユーザーが気付けない不整合があった。
      writeError_(sheet, i + 2, delayMsg);
      continue;
    }

    var groupNo = allData[i][COL.GROUP - 1];
    var entry = {
      row: i + 2,
      text: text,
      groupNo: groupNo,
      date: date,
      media: allData[i][COL.MEDIA - 1], // P列: 添付メディアURL(JSON配列)。空ならテキスト投稿
    };

    if (!groupNo && groupNo !== 0) {
      singles.push(entry);
    } else {
      // グループ番号＋日付でグルーピング（日付違いは別スレッド）
      var key = groupNo + '_' + dateKey_(date);
      if (!threads[key]) threads[key] = [];
      threads[key].push(entry);
    }
  }

  var ok = 0, ng = 0;
  var workItems = [];
  singles.forEach(function(s) {
    workItems.push({ kind: 'single', row: s.row, single: s });
  });
  Object.keys(threads).forEach(function(key) {
    var group = threads[key];
    var firstRow = group[0] ? group[0].row : 999999;
    workItems.push({ kind: 'thread', row: firstRow, threadKey: key });
  });
  workItems.sort(function(a, b) { return a.row - b.row; });

  // 暴発防止: 1回のGAS起動では、同一アカウント内の予約グループを1つだけ処理する。
  // 次の予約は毎分トリガーで拾われるが、冒頭の60分ガードにより直近投稿から1時間未満なら投稿されない。
  var item = workItems[0];
  if (item && item.kind === 'single') {
    var s = item.single;
    try {
      var singleResult = postWithRetry_(s.text, s.media, null);
      markPostSuccessAfterPublish_(sheet, s.row, singleResult.id);
      ok++;
    } catch (e) {
      writeError_(sheet, s.row, e.message);
      ng++;
    }
  } else if (item && item.kind === 'thread') {
    var group = threads[item.threadKey];
    var prevId = null;
    var gNo = group[0].groupNo;

    // 同じグループNoの既投稿から最後の投稿IDを探す（チェーンの続き／日付不問）
    // 旧: 同一日付条件があったが、深夜帯の再試行で翌日に押し出されるとスレッドが分断されるため撤去。
    // ローカル投稿側（scheduler.ts）の挙動と統一。スプシは1スプシ=1Threadsアカウントなのでアカウント分離は構造的に担保。
    for (var k = 0; k < allData.length; k++) {
      if (allData[k][COL.GROUP - 1] == gNo && allData[k][COL.STATUS - 1] === '投稿済' && allData[k][COL.POST_ID - 1]) {
        prevId = String(allData[k][COL.POST_ID - 1]);
      }
    }

    for (var gi = 0; gi < group.length; gi++) {
      var g = group[gi];
      try {
        var reply = prevId ? String(prevId) : null;
        var r = postWithRetry_(g.text, g.media, reply);
        markPostSuccessAfterPublish_(sheet, g.row, r.id);
        prevId = String(r.id);
        ok++;
        // 次の投稿がある場合、公開完了を待ってから進む
        if (gi < group.length - 1) {
          waitForReady_(r.containerId);
        }
      } catch (e) {
        writeError_(sheet, g.row, e.message);
        ng++;
        for (var restGi = gi + 1; restGi < group.length; restGi++) {
          writeError_(sheet, group[restGi].row, '前の投稿が失敗したため、続きの投稿を停止しました。Webアプリのエラー画面から「失敗分だけ再試行」してください。');
          ng++;
        }
        break;
      }
    }
  }

  if (workItems.length > 1) {
    console.log('暴発防止: 今回は先頭の1予約だけ処理。残り ' + (workItems.length - 1) + ' 予約は次回以降に確認します。');
  }

  if (ok > 0 || ng > 0) console.log('予約投稿: ' + ok + '件成功, ' + ng + '件エラー');
  runProps.setProperty('LAST_PROCESS_FINISH_AT', new Date().toISOString());
  runProps.setProperty('LAST_PROCESS_SUMMARY', '予約投稿: ' + ok + '件成功, ' + ng + '件エラー / 対象予約グループ=' + workItems.length);
  runProps.deleteProperty('LAST_PROCESS_ERROR');
  runProps.deleteProperty('LAST_PROCESS_ERROR_AT');

  // 1日1回: 古い完了行（Web側にack済み・30日以上前の「投稿済」「エラー」）を削除してスプシ肥大化を防ぐ
  maybeArchiveOldRows_(sheet);

  } catch (e) {
    var errMsg = maskToken_(e && e.message ? e.message : e);
    runProps.setProperty('LAST_PROCESS_ERROR_AT', new Date().toISOString());
    runProps.setProperty('LAST_PROCESS_ERROR', errMsg);
    console.error('processScheduledPosts エラー: ' + errMsg);
  } finally {
    lock.releaseLock();
  }
}

/** 1日1回だけ archiveOldRows_ を実行（LAST_ARCHIVE_AT で間引き）。processScheduledPosts から呼ばれる（スクリプトロック保持中） */
function maybeArchiveOldRows_(sheet) {
  try {
    var props = PropertiesService.getScriptProperties();
    var last = parseInt(props.getProperty('LAST_ARCHIVE_AT') || '0', 10);
    var now = new Date().getTime();
    if (now - last < 24 * 60 * 60 * 1000) return; // 24時間経っていなければスキップ
    archiveOldRows_(sheet);
    props.setProperty('LAST_ARCHIVE_AT', String(now));
  } catch (e) {
    console.error('archiveOldRows エラー: ' + (e && e.message ? e.message : e));
  }
}

/**
 * 古い完了行を削除してスプレッドシートの肥大化を防ぐ。
 * 削除条件: STATUS が「投稿済」または「エラー」 かつ SYNCED == "1"（Web側に取り込み済み）
 *           かつ DONE_AT（無ければ予約日）が ARCHIVE_DAYS 日以上前。
 * 未取込（SYNCED != "1"）の行は、Web側がまだ結果を見ていないので絶対に消さない。
 * 連続範囲をまとめて、行番号の大きい方（下）から削除して行ずれを回避する。
 */
function archiveOldRows_(sheet) {
  var ARCHIVE_DAYS = 30;
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var readCols = Math.max(TOTAL_COLS, Math.min(sheet.getLastColumn(), TOTAL_COLS_V2));
  if (readCols < COL.SYNCED) return; // SYNCED列が無い旧フォーマットのシートは対象外（安全側）
  var data = sheet.getRange(2, 1, lastRow - 1, readCols).getValues();
  var cutoff = new Date().getTime() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

  var toDelete = [];
  for (var i = 0; i < data.length; i++) {
    var status = data[i][COL.STATUS - 1];
    if (status !== '投稿済' && status !== 'エラー') continue;
    var synced = String(data[i][COL.SYNCED - 1] || '');
    if (synced !== '1') continue;
    var ref = data[i][COL.DONE_AT - 1] || data[i][COL.DATE - 1];
    if (!ref) continue;
    var refMs = (ref instanceof Date) ? ref.getTime() : new Date(ref).getTime();
    if (isNaN(refMs)) continue;
    if (refMs >= cutoff) continue;
    toDelete.push(i + 2); // シート行番号（2始まり）
  }
  if (toDelete.length === 0) return;

  toDelete.sort(function(a, b) { return b - a; }); // 降順
  var removed = 0, idx = 0;
  while (idx < toDelete.length) {
    var end = toDelete[idx];
    var start = end;
    while (idx + 1 < toDelete.length && toDelete[idx + 1] === start - 1) {
      start = toDelete[idx + 1];
      idx++;
    }
    sheet.deleteRows(start, end - start + 1);
    removed += (end - start + 1);
    idx++;
  }
  console.log('古い完了行を ' + removed + ' 件削除（' + ARCHIVE_DAYS + '日以上前・Web取込済み）');
}

// ============================================
// シート更新（データを残して書式を再適用）
// ============================================

function refreshSheet() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('投稿管理');
  if (!sheet) {
    // 「投稿管理」シートがなければ自動作成（初回セットアップ漏れ対応）
    sheet = ss.getActiveSheet();
    sheet.setName('投稿管理');
  }

  var lastRow = Math.max(sheet.getLastRow(), 2);
  var R = Math.max(lastRow + 100, 300);

  // 共通書式を適用
  applyPostSheetFormat_(sheet, R);
  sheet.setTabColor('#4FC3F7');

  // --- 既存データの文字数を再計算 ---
  if (lastRow > 1) {
    var texts = sheet.getRange(2, COL.TEXT, lastRow - 1, 1).getValues();
    var counts = texts.map(function(r) { return [r[0] ? String(r[0]).length : '']; });
    sheet.getRange(2, COL.CHAR_COUNT, lastRow - 1, 1).setValues(counts);
  }

  ui.alert('書式リセット完了！\n書式・ドロップダウン・条件付き書式を再適用しました。\nデータはそのままです。');
}

// ============================================
// ヘルパー
// ============================================

/** 日付部分（年月日）が同じか比較。両方空なら一致扱い */
function isSameDate_(d1, d2) {
  if (!d1 && !d2) return true;
  if (!d1 || !d2) return false;
  var a = d1 instanceof Date ? d1 : new Date(d1);
  var b = d2 instanceof Date ? d2 : new Date(d2);
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

/** 日付からグルーピング用キー文字列を生成 */
function dateKey_(d) {
  if (!d) return '_nodate';
  var dt = d instanceof Date ? d : new Date(d);
  return dt.getFullYear() + '/' + (dt.getMonth() + 1) + '/' + dt.getDate();
}

// ============================================
// Web版ハイブリッド連携ヘルパー
// ============================================

/**
 * webPostId でシート行を検索する（行物理移動に強い検索キー）
 * 見つかれば 1-indexed の行番号、見つからなければ -1 を返す
 */
function findRowByWebPostId_(sheet, webPostId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  // N列(WEB_POST_ID)が物理的に存在しない場合（v3スプシ）は -1 を返す
  if (sheet.getLastColumn() < COL.WEB_POST_ID) return -1;
  var values = sheet.getRange(2, COL.WEB_POST_ID, lastRow - 1, 1).getValues();
  var target = String(webPostId);
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === target) return i + 2;
  }
  return -1;
}

/**
 * JST文字列 "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD HH:mm" を分解して
 * { date: Date(GAS TZ), hour, minute } を返す。秒は無視（v3 TZガードと整合）
 */
function parseJstDateTime_(s) {
  if (!s) throw new Error('publishAtJst is required');
  var str = String(s).replace('T', ' ').trim();
  var m = str.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) throw new Error('publishAtJst must be "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD HH:mm" — got: ' + s);
  var y = parseInt(m[1], 10);
  var mo = parseInt(m[2], 10);
  var d = parseInt(m[3], 10);
  var h = parseInt(m[4], 10);
  var mi = parseInt(m[5], 10);
  // GASスプシのTZがAsia/Tokyoであること前提（setSpreadsheetTimeZone で強制済み）
  // 日付のみのDateを作って D列へ書き、H/M は別列で持つ（v3スキーマ互換）
  var date = new Date(y, mo - 1, d, 0, 0, 0, 0);
  return { date: date, hour: h, minute: mi };
}

/**
 * Web連携用の N/O 列ヘッダーが無ければ追加する（既存スプシ向けの自動マイグレーション）
 * 既存セットアップ済みスプシでも pushQueue が初回実行時に N/O 列を確保する
 */
function ensureWebColumnsHeader_(sheet) {
  var lastCol = sheet.getLastColumn();
  // 1行目（ヘッダー）が空なら applyPostSheetFormat_ がまだ走ってないので何もしない
  if (sheet.getLastRow() === 0) return;
  if (lastCol < COL.WEB_POST_ID) {
    sheet.getRange(1, COL.WEB_POST_ID).setValue('Web投稿ID');
  }
  if (lastCol < COL.SYNCED) {
    sheet.getRange(1, COL.SYNCED).setValue('Web取込済');
  }
  if (lastCol < COL.MEDIA) {
    sheet.getRange(1, COL.MEDIA).setValue('メディア');
  }
}

function pendingSuccessKey_(webPostId, row) {
  if (webPostId) return PENDING_SUCCESS_PREFIX + 'WEB_' + String(webPostId);
  return PENDING_SUCCESS_PREFIX + 'ROW_' + String(row);
}

function listPendingSuccesses_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var out = [];
  var nowMs = new Date().getTime();
  var ttlMs = PENDING_SUCCESS_TTL_DAYS * 24 * 60 * 60 * 1000;
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(PENDING_SUCCESS_PREFIX) !== 0) return;
    try {
      var item = JSON.parse(all[key]);
      item.key = key;
      var postedMs = item.postedAt ? new Date(item.postedAt).getTime() : 0;
      if (postedMs && nowMs - postedMs > ttlMs) {
        props.deleteProperty(key);
        return;
      }
      out.push(item);
    } catch (e) {
      props.deleteProperty(key);
    }
  });
  return out;
}

function getWebPostIdForRow_(sheet, row) {
  try {
    if (!sheet || sheet.getLastColumn() < COL.WEB_POST_ID) return '';
    return String(sheet.getRange(row, COL.WEB_POST_ID).getValue() || '');
  } catch (e) {
    return '';
  }
}

function diagnoseScheduler_(sheet) {
  var now = new Date();
  var props = PropertiesService.getScriptProperties();
  var result = {
    version: GAS_VERSION,
    nowJst: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'),
    configured: isConfigured_(),
    scriptTimeZone: Session.getScriptTimeZone(),
    spreadsheetTimeZone: SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(),
    hasSheet: !!sheet,
    hasTrigger: hasTrigger_('processScheduledPosts'),
    hasTokenRefreshTrigger: hasTrigger_('refreshAccessToken'),
    lastRow: sheet ? sheet.getLastRow() : 0,
    lastColumn: sheet ? sheet.getLastColumn() : 0,
    lastPostedAtJst: null,
    intervalBlocked: false,
    intervalMinutesLeft: 0,
    pendingSuccessCount: 0,
    triggerResetAt: props.getProperty('TRIGGER_RESET_AT') || null,
    lastProcessAttemptAt: props.getProperty('LAST_PROCESS_ATTEMPT_AT') || null,
    lastProcessFinishAt: props.getProperty('LAST_PROCESS_FINISH_AT') || null,
    lastProcessSkippedAt: props.getProperty('LAST_PROCESS_SKIPPED_AT') || null,
    lastProcessSummary: props.getProperty('LAST_PROCESS_SUMMARY') || null,
    lastProcessErrorAt: props.getProperty('LAST_PROCESS_ERROR_AT') || null,
    lastProcessError: props.getProperty('LAST_PROCESS_ERROR') || null,
    dueCount: 0,
    dueGroups: [],
    rows: []
  };
  if (!sheet || result.lastRow <= 1) return result;

  var readCols = Math.max(TOTAL_COLS, Math.min(sheet.getLastColumn(), TOTAL_COLS_V2));
  var allData = sheet.getRange(2, 1, result.lastRow - 1, readCols).getValues();

  var lastPostedAt = null;
  for (var p = 0; p < allData.length; p++) {
    if (allData[p][COL.STATUS - 1] === '投稿済') {
      var doneAt = allData[p][COL.DONE_AT - 1];
      if (doneAt) {
        var dt = doneAt instanceof Date ? doneAt : new Date(doneAt);
        if (!isNaN(dt.getTime()) && (!lastPostedAt || dt.getTime() > lastPostedAt.getTime())) {
          lastPostedAt = dt;
        }
      }
    }
  }
  var pending = listPendingSuccesses_();
  result.pendingSuccessCount = pending.length;
  for (var pp = 0; pp < pending.length; pp++) {
    if (!pending[pp].postedAt) continue;
    var pendingDt = new Date(pending[pp].postedAt);
    if (!isNaN(pendingDt.getTime()) && (!lastPostedAt || pendingDt.getTime() > lastPostedAt.getTime())) {
      lastPostedAt = pendingDt;
    }
  }
  if (lastPostedAt) {
    result.lastPostedAtJst = Utilities.formatDate(lastPostedAt, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    var sinceMs = now.getTime() - lastPostedAt.getTime();
    if (sinceMs < POST_INTERVAL_MIN * 60 * 1000) {
      result.intervalBlocked = true;
      result.intervalMinutesLeft = Math.ceil((POST_INTERVAL_MIN * 60 * 1000 - sinceMs) / 60000);
    }
  }

  var dueGroupMap = {};
  for (var i = 0; i < allData.length; i++) {
    var status = allData[i][COL.STATUS - 1];
    var text = allData[i][COL.TEXT - 1];
    var date = allData[i][COL.DATE - 1];
    var webPostId = allData[i][COL.WEB_POST_ID - 1];
    var h = parseInt(allData[i][COL.HOUR - 1], 10) || 0;
    var m = parseInt(allData[i][COL.MINUTE - 1], 10) || 0;
    var scheduled = date ? new Date(date) : null;
    if (scheduled) scheduled.setHours(h, m, 0, 0);
    var delayMs = scheduled ? now.getTime() - scheduled.getTime() : null;
    var rowInfo = {
      row: i + 2,
      webPostId: webPostId ? String(webPostId) : '',
      groupNo: allData[i][COL.GROUP - 1],
      type: String(allData[i][COL.TYPE - 1] || ''),
      status: String(status || ''),
      textLength: text ? String(text).length : 0,
      scheduledJst: scheduled ? Utilities.formatDate(scheduled, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss') : null,
      delayMinutes: delayMs == null ? null : Math.floor(delayMs / 60000),
      maxOverdueMinutes: PAST_DUE_GRACE_MIN,
      due: false,
      reason: ''
    };
    if (status !== '待機中') {
      rowInfo.reason = '対象外: ステータスが待機中ではありません';
    } else if (!text) {
      rowInfo.reason = '対象外: 投稿文が空です';
    } else if (!date) {
      rowInfo.reason = '対象外: 予約日が空です';
    } else if (hasPendingSuccess_(i + 2, webPostId)) {
      rowInfo.reason = '対象外: 投稿成功記録の復旧待ちです';
    } else if (scheduled > now) {
      rowInfo.reason = '対象外: まだ予約時刻前です';
    } else if (delayMs >= PAST_DUE_GRACE_MIN * 60 * 1000) {
      rowInfo.reason = '対象外: 予約時刻を過ぎたため自動投稿しません';
    } else if (result.intervalBlocked) {
      rowInfo.reason = '待機: 直近投稿から60分以内の安全間隔です';
    } else {
      rowInfo.due = true;
      rowInfo.reason = '投稿対象です';
      var groupNo = allData[i][COL.GROUP - 1];
      var groupKey = (!groupNo && groupNo !== 0) ? 'single_row_' + (i + 2) : String(groupNo) + '_' + dateKey_(date);
      dueGroupMap[groupKey] = true;
    }
    if (status === '待機中' || webPostId || status === '投稿済' || status === 'エラー') {
      result.rows.push(rowInfo);
    }
  }
  result.dueGroups = Object.keys(dueGroupMap);
  result.dueCount = result.dueGroups.length;
  return result;
}

function savePendingSuccess_(sheet, row, postId, postUrl, reason) {
  var props = PropertiesService.getScriptProperties();
  var webPostId = getWebPostIdForRow_(sheet, row);
  var payload = {
    row: row,
    webPostId: webPostId || null,
    postId: String(postId),
    postUrl: postUrl || '',
    postedAt: new Date().toISOString(),
    reason: maskToken_(reason || 'spreadsheet write failed'),
  };
  props.setProperty(pendingSuccessKey_(webPostId, row), JSON.stringify(payload));
  console.error('Threads投稿は成功しましたが、スプシ記録に失敗しました。二重投稿防止のため成功メモを保存: row=' + row + ' postId=' + postId);
}

function hasPendingSuccess_(row, webPostId) {
  var pending = listPendingSuccesses_();
  var targetWebId = webPostId ? String(webPostId) : '';
  for (var i = 0; i < pending.length; i++) {
    if (targetWebId && pending[i].webPostId && String(pending[i].webPostId) === targetWebId) return true;
    if (Number(pending[i].row) === Number(row)) return true;
  }
  return false;
}

function retrySheetWrite_(label, fn) {
  var lastErr = null;
  for (var i = 0; i < 3; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      console.log(label + ' リトライ ' + (i + 1) + '/3: ' + (e && e.message ? e.message : e));
      Utilities.sleep((i + 1) * 700);
    }
  }
  throw lastErr;
}

function recoverPendingSuccesses_(sheet) {
  var props = PropertiesService.getScriptProperties();
  var pending = listPendingSuccesses_();
  for (var i = 0; i < pending.length; i++) {
    var item = pending[i];
    var row = -1;
    if (item.webPostId) row = findRowByWebPostId_(sheet, item.webPostId);
    if (row <= 0 && item.row) row = Number(item.row);
    if (!row || row <= 1 || row > sheet.getLastRow()) continue;

    try {
      var currentStatus = sheet.getRange(row, COL.STATUS).getValue();
      if (currentStatus === '投稿済') {
        props.deleteProperty(item.key);
        continue;
      }
      writeSuccess_(sheet, row, item.postId, item.postUrl || '');
      props.deleteProperty(item.key);
      console.log('投稿成功記録を復旧しました: row=' + row + ' postId=' + item.postId);
    } catch (e) {
      console.error('投稿成功記録の復旧に失敗: row=' + row + ' postId=' + item.postId + ' ' + (e && e.message ? e.message : e));
    }
  }
}

function markPendingSuccessAcked_(webPostId) {
  if (!webPostId) return false;
  var props = PropertiesService.getScriptProperties();
  var pending = listPendingSuccesses_();
  for (var i = 0; i < pending.length; i++) {
    if (pending[i].webPostId && String(pending[i].webPostId) === String(webPostId)) {
      pending[i].ackedAt = new Date().toISOString();
      props.setProperty(pending[i].key, JSON.stringify(pending[i]));
      return true;
    }
  }
  return false;
}

function markPostSuccessAfterPublish_(sheet, row, postId) {
  var postUrl = getPostPermalink_(postId);
  try {
    writeSuccess_(sheet, row, postId, postUrl);
    PropertiesService.getScriptProperties().deleteProperty(pendingSuccessKey_(getWebPostIdForRow_(sheet, row), row));
  } catch (e) {
    try {
      savePendingSuccess_(sheet, row, postId, postUrl, e && e.message ? e.message : String(e));
    } catch (pendingErr) {
      try {
        writeError_(sheet, row, 'Threads投稿は成功しましたが、スプレッドシートへの記録に失敗しました。再投稿しないでください。投稿ID=' + postId);
      } catch (ignored) {
        // ここまで失敗した場合のみ、次回の自動復旧材料が残らない。ログに残して調査対象にする。
      }
      throw pendingErr;
    }
  }
}

function getPostSheet_() {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿管理');
  if (!s) SpreadsheetApp.getUi().alert('「投稿管理」シートがありません。初期設定を実行してください。');
  return s;
}

function checkConfig_(ui) {
  if (!isConfigured_()) { ui.alert('API未設定。「自動投稿」>「API設定」から設定してください。'); return false; }
  return true;
}

/** 投稿成功をバッチ書き込み */
function writeSuccess_(sheet, row, postId, postUrl) {
  var permalink = (postUrl !== undefined && postUrl !== null) ? postUrl : getPostPermalink_(postId);
  retrySheetWrite_('投稿成功記録', function() {
    // postIdセルをテキスト形式にしてから書き込み（数値化による精度劣化を防止）
    sheet.getRange(row, COL.POST_ID).setNumberFormat('@');
    // STATUS(H), POST_ID(I), DONE_AT(J), POST_URL(K) の4列を一括書き込み
    sheet.getRange(row, COL.STATUS, 1, 4).setValues([
      ['投稿済', String(postId), new Date(), permalink || '']
    ]);
  });
}

function writeError_(sheet, row, msg) {
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd HH:mm');
  retrySheetWrite_('エラー記録', function() {
    sheet.getRange(row, COL.STATUS).setValue('エラー');
    sheet.getRange(row, COL.ERROR).setValue('[' + now + '] ' + maskToken_(msg));
  });
}

// ============================================
// 未投稿テキスト整形（AI感除去＋段落改行追加）
// ============================================

function formatUnpostedTexts() {
  var sheet = getPostSheet_();
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var count = 0;
  for (var i = 2; i <= lastRow; i++) {
    var status = sheet.getRange(i, COL.STATUS).getValue();
    if (status === '投稿済') continue;

    var text = sheet.getRange(i, COL.TEXT).getValue();
    if (!text || String(text).trim() === '') continue;

    var original = String(text);
    var formatted = cleanAndFormat_(original);

    if (formatted !== original) {
      sheet.getRange(i, COL.TEXT).setValue(formatted);
      count++;
    }
  }

  SpreadsheetApp.getUi().alert('整形完了: ' + count + '件のテキストを修正しました。');
}

function cleanAndFormat_(text) {
  // === Step 0: 構造マーカーの除去 ===
  text = text.replace(/■(?:CTA|\d+)\s*/g, '');

  // === Step 1: AI感のある記号を除去 ===
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/["\u201C]\u201C(.+?)["\u201D]\u201D/g, '「$1」');
  text = text.replace(/""(.+?)""/g, '「$1」');
  text = text.replace(/\u201C(.+?)\u201D/g, '「$1」');
  text = text.replace(/^【(.+?)】\n?/gm, '$1\n');
  text = text.replace(/^[※＊]\s*/gm, '');

  // === Step 2: 番号付き箇条書きを改行する ===
  text = text.replace(/([^\n])([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/g, '$1\n$2');
  text = text.replace(/([^\n])(・)/g, '$1\n$2');

  // === Step 3: 箇条書きブロック前後に空行 ===
  var lines = text.split('\n');
  var result = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var isListItem = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳・]/.test(line);
    var prevIsListItem = i > 0 && /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳・]/.test(lines[i - 1]);
    if (isListItem && !prevIsListItem && i > 0 && lines[i - 1].trim() !== '') {
      result.push('');
    }
    result.push(line);
    var nextIsListItem = i < lines.length - 1 && /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳・]/.test(lines[i + 1]);
    if (isListItem && !nextIsListItem && i < lines.length - 1) {
      result.push('');
    }
  }
  text = result.join('\n');

  // === Step 4: 段落改行を追加 ===
  if (text.indexOf('\n\n') !== -1) {
    return text.trim();
  }
  if (text.indexOf('\n') === -1) {
    text = addParagraphBreaks_(text);
  }
  return text.trim();
}

function addParagraphBreaks_(text) {
  var sentences = text.split('\u3002'); // 。
  if (sentences.length <= 1) return text;
  if (sentences[sentences.length - 1].trim() === '') sentences.pop();

  var paragraphs = [];
  var current = [];
  var sentencesInParagraph = 0;
  var isFirstParagraph = true;
  var targetSize = 1;

  for (var i = 0; i < sentences.length; i++) {
    var s = sentences[i].trim();
    if (s === '') continue;
    current.push(s + '\u3002');
    sentencesInParagraph++;

    var shouldBreak = false;
    if (isFirstParagraph && sentencesInParagraph >= targetSize) {
      shouldBreak = true;
      isFirstParagraph = false;
      targetSize = 3;
    } else if (!isFirstParagraph && sentencesInParagraph >= targetSize) {
      shouldBreak = true;
      targetSize = (targetSize === 3) ? 2 : 3;
    }

    var remaining = sentences.length - i - 1;
    if (shouldBreak && remaining <= 1 && sentencesInParagraph < 4) {
      shouldBreak = false;
    }

    if (shouldBreak || i === sentences.length - 1) {
      paragraphs.push(current.join(''));
      current = [];
      sentencesInParagraph = 0;
    }
  }
  return paragraphs.join('\n\n');
}

// ============================================
// 承認（下書き → 待機中）
// ============================================

/** 選択した行の「下書き」を「待機中」に変更 */
function approveSelectedRows() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getPostSheet_();
  if (!sheet) return;

  var selection = sheet.getActiveRange();
  if (!selection) { ui.alert('承認したい行を選択してください。'); return; }

  var startRow = selection.getRow();
  var numRows = selection.getNumRows();
  var count = 0;

  for (var i = 0; i < numRows; i++) {
    var row = startRow + i;
    if (row < 2) continue; // ヘッダー行スキップ
    var status = sheet.getRange(row, COL.STATUS).getValue();
    if (status === '下書き') {
      sheet.getRange(row, COL.STATUS).setValue('待機中');
      count++;
    }
  }

  if (count === 0) {
    ui.alert('選択範囲に「下書き」の行がありませんでした。');
  } else {
    ui.alert(count + '件を承認しました（下書き → 待機中）。\nトリガーONなら予約時刻に自動投稿されます。');
  }
}

/** 全ての「下書き」を「待機中」に一括変更 */
function approveAllDrafts() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getPostSheet_();
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) { ui.alert('データがありません。'); return; }

  // 先にカウントして確認ダイアログ
  var statuses = sheet.getRange(2, COL.STATUS, lastRow - 1, 1).getValues();
  var draftCount = statuses.filter(function(r) { return r[0] === '下書き'; }).length;

  if (draftCount === 0) { ui.alert('「下書き」の投稿がありません。'); return; }

  var confirm = ui.alert('全件承認',
    '「下書き」' + draftCount + '件を全て「待機中」に変更します。\nよろしいですか？',
    ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  var count = 0;
  for (var i = 0; i < statuses.length; i++) {
    if (statuses[i][0] === '下書き') {
      statuses[i][0] = '待機中';
      count++;
    }
  }
  sheet.getRange(2, COL.STATUS, lastRow - 1, 1).setValues(statuses);

  ui.alert(count + '件を承認しました（下書き → 待機中）。\nトリガーONなら予約時刻に自動投稿されます。');
}

// ============================================
// テスト投稿
// ============================================

/**
 * アップデート後の動作確認用。
 * スプシにテスト行を1行追加（予約＝1分後）し、トリガーが正常に投稿するか確認する。
 * 投稿テキストは「テスト投稿（自動削除OK）」。
 * 結果はスプシのステータス列で確認できる。
 */
function testScheduledPost() {
  var ui = SpreadsheetApp.getUi();
  if (!isConfigured_()) { ui.alert('先にAPI設定を行ってください。'); return; }

  // タイムゾーンチェック
  var tz = Session.getScriptTimeZone();
  if (tz !== 'Asia/Tokyo') {
    ui.alert('タイムゾーンエラー\n\n現在: ' + tz + '\n必要: Asia/Tokyo\n\nGASエディタ > プロジェクトの設定 でタイムゾーンを変更してください。');
    return;
  }

  var sheet = getPostSheet_();
  if (!sheet) return;

  // 1分後の時刻を計算
  var now = new Date();
  now.setMinutes(now.getMinutes() + 1);
  var testDate = new Date(now);
  testDate.setHours(0, 0, 0, 0);
  var h = now.getHours();
  var m = now.getMinutes();

  // テスト行を最終行に追加
  var lastRow = Math.max(sheet.getLastRow(), 1) + 1;
  var row = [];
  for (var c = 0; c < TOTAL_COLS; c++) row.push('');
  row[COL.TEXT - 1] = 'テスト投稿（自動削除OK）';
  row[COL.TYPE - 1] = '単体';
  row[COL.DATE - 1] = testDate;
  row[COL.HOUR - 1] = h;
  row[COL.MINUTE - 1] = m;
  row[COL.CHAR_COUNT - 1] = 14;
  row[COL.STATUS - 1] = '待機中';
  row[COL.MEMO - 1] = 'アップデート動作確認';
  sheet.getRange(lastRow, 1, 1, TOTAL_COLS).setValues([row]);

  // トリガーが動いているか確認、なければ一時的にセット
  var triggers = ScriptApp.getProjectTriggers();
  var hasTrigger = triggers.some(function(t) { return t.getHandlerFunction() === 'processScheduledPosts'; });
  if (!hasTrigger) {
    ScriptApp.newTrigger('processScheduledPosts').timeBased().everyMinutes(1).create();
  }

  ui.alert('テスト投稿を予約しました！\n\n'
    + '予約時刻: ' + h + '時' + m + '分（約1分後）\n'
    + '行番号: ' + lastRow + '\n\n'
    + '1〜2分後にスプレッドシートを確認して、\n'
    + 'ステータスが「投稿済」になっていればOKです。\n\n'
    + '投稿後、テスト投稿はThreadsから手動で削除してください。');
}

// ============================================
// トリガー
// ============================================

/** 指定ハンドラのトリガーが既にあるか */
function hasTrigger_(handlerName) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handlerName) return true;
  }
  return false;
}

function deleteAutomationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'processScheduledPosts' || fn === 'refreshAccessToken' || fn === 'watchdog') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/** 投稿実行トリガー（processScheduledPosts, 毎分）が無ければ作る。UIなし。作ったら true */
function ensureMainTrigger_() {
  if (hasTrigger_('processScheduledPosts')) return false;
  ScriptApp.newTrigger('processScheduledPosts').timeBased().everyMinutes(1).create();
  try { var sh = getPostSheet_(); if (sh) sh.setTabColor('#4ade80'); } catch (e) {}
  return true;
}

/** 監視トリガー（watchdog, 6時間おき）が無ければ作る。UIなし。作ったら true */
function ensureWatchdog_() {
  if (hasTrigger_('watchdog')) return false;
  ScriptApp.newTrigger('watchdog').timeBased().everyHours(6).create();
  return true;
}

/** トークン更新トリガー（refreshAccessToken, 1日おき）が無ければ作る。UIなし。作ったら true */
function ensureTokenRefreshTrigger_() {
  if (hasTrigger_('refreshAccessToken')) return false;
  ScriptApp.newTrigger('refreshAccessToken').timeBased().everyDays(1).create();
  return true;
}

/** 必要なトリガー（投稿実行・トークン更新・監視）を一括で揃える。UIなし */
function ensureAllTriggers_() {
  ensureMainTrigger_();
  ensureTokenRefreshTrigger_();
  ensureWatchdog_();
}

/** クラウド修復時は既存トリガーが見えていても死んでいる可能性があるため、必ず作り直す */
function resetAllTriggers_() {
  deleteAutomationTriggers_();
  ScriptApp.newTrigger('processScheduledPosts').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('refreshAccessToken').timeBased().everyDays(1).create();
  ScriptApp.newTrigger('watchdog').timeBased().everyHours(6).create();
  PropertiesService.getScriptProperties().setProperty('TRIGGER_RESET_AT', new Date().toISOString());
  try { var sh = getPostSheet_(); if (sh) sh.setTabColor('#4ade80'); } catch (e) {}
}

function setupTrigger() {
  if (!isConfigured_()) { SpreadsheetApp.getUi().alert('先にAPI設定を行ってください。'); return; }
  resetAllTriggers_();
  // シートタブを緑に（ON状態を視覚化）
  var sheet = getPostSheet_();
  if (sheet) sheet.setTabColor('#4ade80');
  SpreadsheetApp.getUi().alert('🟢 トリガー ON\n\n予約時刻になると自動投稿されます。\n「待機中」の投稿が対象です。\n\n止めたい時は「自動投稿」→「トリガー OFF」');
}

function removeTrigger() {
  // watchdog も一緒に消す（残すと watchdog が processScheduledPosts を自動復活させて OFF が効かない）
  deleteAutomationTriggers_();
  // シートタブを赤に（OFF状態を視覚化）
  var sheet = getPostSheet_();
  if (sheet) sheet.setTabColor('#f87171');
  SpreadsheetApp.getUi().alert('🔴 トリガー OFF\n\n自動投稿を停止しました。\n「待機中」の投稿も投稿されません。');
}

// ============================================
// トークン自動更新（60日期限切れ防止）
// ============================================

/**
 * Threads長期トークンを更新する。
 * 長期トークンは60日で期限切れ。トリガーは毎日走らせ、通常時は20日ごとに更新する。
 * 前回失敗していれば毎日リトライ。手動実行も可能（メニューから or clasp run）。
 */
function refreshAccessToken() {
  return refreshAccessToken_(false);
}

function isTooEarlyRefreshError_(message) {
  var lower = String(message || '').toLowerCase();
  return lower.indexOf('24') !== -1 && (
    lower.indexOf('hour') !== -1 ||
    lower.indexOf('時間') !== -1 ||
    lower.indexOf('too soon') !== -1 ||
    lower.indexOf('cannot refresh') !== -1 ||
    lower.indexOf('refresh') !== -1
  );
}

function refreshAccessToken_(force) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('THREADS_ACCESS_TOKEN');
  if (!token) {
    console.log('トークン未設定のためスキップ');
    return;
  }

  // 間引き: 前回エラーが無い かつ 直近20日以内にリフレッシュ済み なら今回はスキップ。
  // （トリガーは毎日走るが、正常時は実質20日おき。前回失敗していれば毎日リトライ＝60日の失効までに十分な再試行回数）
  var lastTokenError = props.getProperty('TOKEN_LAST_ERROR');
  var lastRefreshedAt = parseInt(props.getProperty('TOKEN_REFRESHED_AT') || '0', 10);
  var refreshAgeMs = new Date().getTime() - lastRefreshedAt;
  var REFRESH_INTERVAL_MS = 20 * 24 * 60 * 60 * 1000; // 20日
  if (!force && !lastTokenError && refreshAgeMs >= 0 && refreshAgeMs < REFRESH_INTERVAL_MS) {
    console.log('トークンは最近更新済み（約' + Math.round(refreshAgeMs / 86400000) + '日前）。今回はスキップ');
    return;
  }

  var url = 'https://graph.threads.net/refresh_access_token'
    + '?grant_type=th_refresh_token'
    + '&access_token=' + token;

  try {
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(resp.getContentText());

    if (body.access_token) {
      props.setProperty('THREADS_ACCESS_TOKEN', body.access_token);
      // トークン状態の追跡（pullResultsで返却するため）
      props.setProperty('TOKEN_REFRESHED_AT', String(new Date().getTime()));
      props.setProperty('TOKEN_EXPIRES_IN_SEC', String(body.expires_in || 5184000));
      props.deleteProperty('TOKEN_LAST_ERROR');
      _cfgCache = null;
      console.log('トークン更新成功（有効期限: ' + body.expires_in + '秒）');
    } else {
      var errMsg = body.error ? body.error.message : '不明なエラー';
      var safeErrMsg = maskToken_(errMsg);
      if (isTooEarlyRefreshError_(safeErrMsg)) {
        // Meta仕様: 長期トークンは発行から24時間未満だと更新できない。
        // このケースは失敗扱いにせず、翌日の自動更新で再試行する。
        props.setProperty('TOKEN_REFRESHED_AT', String(new Date().getTime()));
        props.setProperty('TOKEN_EXPIRES_IN_SEC', String(body.expires_in || 5184000));
        props.deleteProperty('TOKEN_LAST_ERROR');
        console.log('トークンは発行直後のため更新を延期（翌日以降に自動再試行）');
      } else {
        props.setProperty('TOKEN_LAST_ERROR', safeErrMsg);
        console.error('トークン更新失敗: ' + safeErrMsg);
      }
    }
  } catch (e) {
    var catchMsg = maskToken_(e && e.message ? e.message : String(e));
    props.setProperty('TOKEN_LAST_ERROR', catchMsg);
    console.error('トークン更新エラー: ' + catchMsg);
  }
}

/** トークン更新トリガーをセット（1日おき。実際のリフレッシュは refreshAccessToken 内で間引く） */
function setupTokenRefreshTrigger_() {
  // 既存の更新トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refreshAccessToken') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshAccessToken').timeBased().everyDays(1).create();
}

// ============================================
// 設定ダイアログ
// ============================================

function showSettingsDialog() {
  var config = getConfig_();
  var safeUserId = escapeHtml_(config.userId);
  var tokenPlaceholder = config.token ? '********（設定済み）' : '';

  var html = HtmlService.createHtmlOutput(
    '<style>' +
    '  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px 28px;color:#1a1a1a;background:#fafafa}' +
    '  h3{margin:0 0 4px;font-size:19px;font-weight:700;color:#000;letter-spacing:-0.3px}' +
    '  .sub{color:#666;font-size:12px;margin-bottom:22px}' +
    '  label{display:block;margin-top:18px;font-weight:600;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:0.5px}' +
    '  input{width:100%;padding:11px 12px;margin-top:6px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;box-sizing:border-box;background:#fff;transition:border .15s}' +
    '  input:focus{outline:none;border-color:#4FC3F7;box-shadow:0 0 0 2px rgba(79,195,247,0.15)}' +
    '  .hint{font-size:11px;color:#aaa;margin-top:4px}' +
    '  .btn{width:100%;margin-top:28px;padding:13px;background:#4FC3F7;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .15s}' +
    '  .btn:hover{background:#039BE5}.btn:disabled{background:#ccc;cursor:wait}' +
    '  .ok{text-align:center;margin-top:14px;font-size:13px;color:#2e7d32;display:none}' +
    '  .err{color:#c62828;font-size:12px;margin-top:10px;display:none}' +
    '</style>' +
    '<h3>API 設定</h3>' +
    '<p class="sub">Meta Developer Portal で取得した値を入力</p>' +
    '<label>User ID</label>' +
    '<input type="text" id="userId" placeholder="例: 12345678901234567" value="' + safeUserId + '">' +
    '<div class="hint">API Explorer に表示される数値ID</div>' +
    '<label>Access Token</label>' +
    '<input type="text" id="token" placeholder="例: THQWF1a2b3c..." value="' + tokenPlaceholder + '" onfocus="if(this.value.includes(\'設定済み\'))this.value=\'\'">' +
    '<div class="hint">Generate Token で生成したトークン</div>' +
    '<div class="err" id="err"></div>' +
    '<button class="btn" id="b" onclick="save()">保存してシート初期化</button>' +
    '<div class="ok" id="ok">保存しました！</div>' +
    '<script>' +
    'function save(){' +
    '  var u=document.getElementById("userId").value.trim();' +
    '  var t=document.getElementById("token").value.trim();' +
    '  var e=document.getElementById("err");' +
    '  e.style.display="none";' +
    '  if(!u||!t||t.includes("設定済み")){showErr("両方入力してください");return}' +
    '  if(!/^\\d+$/.test(u)){showErr("User IDは数字のみです");return}' +
    '  if(t.length<10){showErr("Access Tokenが短すぎます");return}' +
    '  var b=document.getElementById("b");b.disabled=true;b.textContent="保存中...";' +
    '  google.script.run.withSuccessHandler(function(){' +
    '    document.getElementById("ok").style.display="block";b.textContent="完了！";' +
    '    setTimeout(function(){google.script.host.close()},1500)' +
    '  }).withFailureHandler(function(err){showErr(err.message);b.disabled=false;b.textContent="保存してシート初期化"})' +
    '  .saveSettings(u,t)}' +
    'function showErr(m){var e=document.getElementById("err");e.textContent=m;e.style.display="block"}' +
    '</script>'
  ).setWidth(440).setHeight(430);
  SpreadsheetApp.getUi().showModalDialog(html, 'API 設定');
}

function saveSettings(userId, token) {
  // サーバーサイドバリデーション
  if (!/^\d+$/.test(userId)) throw new Error('User IDは数字のみです');
  if (!token || token.length < 10) throw new Error('Access Tokenが無効です');

  var props = PropertiesService.getScriptProperties();
  props.setProperty('THREADS_USER_ID', userId);
  props.setProperty('THREADS_ACCESS_TOKEN', token);
  _cfgCache = null; // キャッシュクリア
  initSheet();
}

// ============================================
// ウォッチドッグ（監視アラート）
// ============================================

function createWatchdog() {
  deleteWatchdogSilent_();
  ScriptApp.newTrigger('watchdog')
    .timeBased()
    .everyHours(6)
    .create();
  SpreadsheetApp.getUi().alert(
    '監視アラートを有効にしました（6時間おき）。\n\n' +
    '以下の異常を検知するとメールで通知します:\n' +
    '・自動投稿トリガーが消えている\n' +
    '・3時間以上前に投稿予定だったのに待機中のまま'
  );
}

function deleteWatchdog() {
  var count = deleteWatchdogSilent_();
  SpreadsheetApp.getUi().alert(
    count > 0
      ? '監視アラートを停止しました。'
      : '監視アラートは設定されていませんでした。'
  );
}

function deleteWatchdogSilent_() {
  var triggers = ScriptApp.getProjectTriggers();
  var count = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'watchdog') {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  return count;
}

function watchdog() {
  var issues = [];
  var props = PropertiesService.getScriptProperties();

  // チェック1: 必要なトリガーが消えていたら自動で作り直す（検知だけでなく自己修復）
  if (!hasTrigger_('processScheduledPosts')) {
    if (isConfigured_()) {
      ensureMainTrigger_();
      issues.push('自動投稿トリガーが消えていたので自動で復旧しました（投稿は再開しています）。');
    } else {
      issues.push('自動投稿トリガーが存在せず、API設定も未完了です。クラウドオフロードのセットアップをやり直してください。');
    }
  }
  if (isConfigured_() && !hasTrigger_('refreshAccessToken')) {
    ensureTokenRefreshTrigger_();
    issues.push('トークン更新トリガーが消えていたので自動で復旧しました。');
  }

  // チェック1.5: トークン更新が失敗していないか（失敗が続くと60日でトークン失効）
  var tokenLastError = props.getProperty('TOKEN_LAST_ERROR');
  if (tokenLastError) {
    issues.push('Threadsトークンの自動更新が失敗しています（' + tokenLastError + '）。'
      + 'このまま放置するとトークンが失効して投稿できなくなります。'
      + 'Webアプリの「設定 → アカウント編集 → アクセストークン」でトークンを取り直してください。');
  }

  // チェック2: 3時間以上前に予定されていたのに待機中の行がないか
  var sheet = getPostSheet_();
  var now = new Date();
  var threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  var overdueCount = 0;

  if (sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var allData = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
      for (var j = 0; j < allData.length; j++) {
        var status = allData[j][COL.STATUS - 1];
        if (status !== '待機中') continue;

        var date = allData[j][COL.DATE - 1];
        if (!date) continue;

        var h = parseInt(allData[j][COL.HOUR - 1], 10) || 0;
        var m = parseInt(allData[j][COL.MINUTE - 1], 10) || 0;
        var scheduled = new Date(date);
        scheduled.setHours(h, m, 0, 0);

        if (scheduled < threeHoursAgo) {
          overdueCount++;
        }
      }
    }
  }

  if (overdueCount > 0) {
    issues.push('投稿予定時刻を3時間以上過ぎた待機中が ' + overdueCount + ' 件あります。');
  }

  // 問題があれば(1) Properties に最新issuesを保存（WebUI 側 pullResults などで取り出し可能） →
  // (2) メール送信を試みる。Session.getActiveUser は userinfo.email スコープが未許可だと throw するため、
  // 権限不足時もメール失敗だけで watchdog 全体は落とさない（issues は Properties に残るので可視性は保つ）。
  if (issues.length > 0) {
    try {
      props.setProperty('LAST_WATCHDOG_ISSUES', JSON.stringify({
        at: now.toISOString(),
        issues: issues,
      }));
    } catch (e) {
      Logger.log('LAST_WATCHDOG_ISSUES 保存失敗: ' + (e && e.message));
    }
    try {
      var email = Session.getActiveUser().getEmail();
      if (email) {
        var ssUrl = SpreadsheetApp.getActiveSpreadsheet().getUrl();
        var subject = '【自動投稿】異常検知アラート';
        var body = '自動投稿システムで問題が検出されました。\n\n' +
          issues.join('\n') +
          '\n\n■ 対処方法\n' +
          '1. スプレッドシートを開く: ' + ssUrl + '\n' +
          '2.「自動投稿」メニュー →「トリガー ON（1分間隔）」で再設定\n' +
          '3. 必要に応じて「日付リスケ」で日程を調整\n\n' +
          '検知時刻: ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
        MailApp.sendEmail(email, subject, body);
        Logger.log('アラートメール送信: ' + email + ' / ' + issues.join(', '));
      } else {
        Logger.log('アラートメール送信スキップ（メールアドレス取得不可）: ' + issues.join(', '));
      }
    } catch (e) {
      // 権限不足や送信失敗時は Logger に残して継続。Properties の LAST_WATCHDOG_ISSUES から
      // WebUI 側でも検知可能なので、watchdog 全体は健全終了させる。
      Logger.log('アラートメール送信失敗（権限不足の可能性）: ' + (e && e.message) + ' / issues=' + issues.join(', '));
    }
  } else {
    Logger.log('ウォッチドッグ: 異常なし');
  }
}

// ============================================
// 未投稿リスケジュール
// ============================================

function showRescheduleDialog() {
  var today = new Date();
  var tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  var defaultDate = Utilities.formatDate(tomorrow, Session.getScriptTimeZone(), 'yyyy/MM/dd');

  var html = HtmlService.createHtmlOutput(
    '<style>' +
    '  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px 28px;color:#1a1a1a;background:#fafafa}' +
    '  h3{margin:0 0 4px;font-size:19px;font-weight:700;letter-spacing:-0.3px}' +
    '  .sub{color:#666;font-size:12px;margin-bottom:22px}' +
    '  label{display:block;margin-top:18px;font-weight:600;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:0.5px}' +
    '  input{width:100%;padding:11px 12px;margin-top:6px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px;box-sizing:border-box;background:#fff;transition:border .15s}' +
    '  input:focus{outline:none;border-color:#4FC3F7;box-shadow:0 0 0 2px rgba(79,195,247,0.15)}' +
    '  .hint{font-size:11px;color:#aaa;margin-top:4px}' +
    '  .btn{width:100%;margin-top:28px;padding:13px;background:#4FC3F7;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .15s}' +
    '  .btn:hover{background:#039BE5}.btn:disabled{background:#ccc;cursor:wait}' +
    '</style>' +
    '<h3>日付リスケ</h3>' +
    '<p class="sub">待機中の全行を指定日から順に詰め直します</p>' +
    '<label>再開日</label>' +
    '<input type="text" id="startDate" value="' + defaultDate + '" placeholder="2026/03/27">' +
    '<div class="hint">この日の朝から順に詰め直します</div>' +
    '<label>1日の投稿時間帯</label>' +
    '<input type="text" id="hours" value="7,9,12,15,19,21" placeholder="7,9,12,15,19,21">' +
    '<div class="hint">カンマ区切りで時間を指定</div>' +
    '<button class="btn" onclick="run()">リスケ実行</button>' +
    '<script>' +
    'function run(){' +
    '  var d=document.getElementById("startDate").value;' +
    '  var h=document.getElementById("hours").value;' +
    '  var b=document.querySelector(".btn");b.disabled=true;b.textContent="処理中...";' +
    '  google.script.run.withSuccessHandler(function(msg){alert(msg);google.script.host.close()}).rescheduleUnposted(d,h);' +
    '}' +
    '</script>'
  ).setWidth(440).setHeight(380);

  SpreadsheetApp.getUi().showModalDialog(html, '日付リスケ');
}

function rescheduleUnposted(startDateStr, hoursStr) {
  var sheet = getPostSheet_();
  if (!sheet) return '投稿管理シートが見つかりません。';

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return '待機中データがありません。';

  // 開始日パース
  var parts = startDateStr.split(/[\/\-]/);
  if (parts.length !== 3) return '日付フォーマットエラー: ' + startDateStr;
  var baseDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));

  // 時間帯パース
  var hours = hoursStr.split(',').map(function(h) { return parseInt(h.trim()); }).sort(function(a, b) { return a - b; });
  if (hours.length === 0) return '時間帯が指定されていません。';

  // 待機中行を収集
  var allData = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  var unpostedRows = [];
  for (var i = 0; i < allData.length; i++) {
    if (allData[i][COL.STATUS - 1] === '待機中') {
      unpostedRows.push(i + 2); // シート行番号
    }
  }

  if (unpostedRows.length === 0) return '待機中の行がありません。';

  // 日付・時間を順番に割り当て
  var dayOffset = 0;
  var hourIndex = 0;
  var count = 0;

  for (var j = 0; j < unpostedRows.length; j++) {
    var rowNum = unpostedRows[j];

    var postDate = new Date(baseDate);
    postDate.setDate(postDate.getDate() + dayOffset);

    var postHour = hours[hourIndex];
    var postMinute = Math.floor(Math.random() * 50) + 5;

    var dateFormatted = Utilities.formatDate(postDate, Session.getScriptTimeZone(), 'yyyy/MM/dd');
    sheet.getRange(rowNum, COL.DATE).setValue(dateFormatted);
    sheet.getRange(rowNum, COL.HOUR).setValue(postHour);
    sheet.getRange(rowNum, COL.MINUTE).setValue(postMinute);

    count++;
    hourIndex++;
    if (hourIndex >= hours.length) {
      hourIndex = 0;
      dayOffset++;
    }
  }

  var endDate = new Date(baseDate);
  endDate.setDate(endDate.getDate() + dayOffset);
  var endFormatted = Utilities.formatDate(endDate, Session.getScriptTimeZone(), 'yyyy/MM/dd');

  return 'リスケ完了！\n' + count + '件の待機中を ' + startDateStr + ' 〜 ' + endFormatted + ' に再配置しました。';
}

// ============================================
// Web App（データ受信 → 書き込み → 書式適用）
// ============================================

/**
 * POST でTSVデータを受け取り、シートに書き込み、書式を適用する。
 * connector.py / Selenium 不要で完全自動転記が可能。
 *
 * リクエスト例:
 *   POST { "tsv": "1\t\"テキスト\"\t単体\t2026/04/01\t7\t0\t200\t下書き\n..." }
 *   POST { "action": "clear" }      // データ消去 + 書式リセット
 *   POST { "action": "refresh" }     // 書式リセットのみ
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // APIキー検証（ScriptPropertiesに WEBAPP_KEY が設定されている場合のみ）
    var props = PropertiesService.getScriptProperties();
    var storedKey = props.getProperty('WEBAPP_KEY');
    if (storedKey && body.key !== storedKey) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', message: '認証エラー: keyが無効です'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('投稿管理');
    if (!sheet) {
      sheet = ss.insertSheet('投稿管理');
    }

    // --- アクション処理 ---

    // uploadMedia: 画像をDriveに保存して公開直リンクを返す（webappの画像添付用）
    // body: { base64, mimeType, fileName, webPostId? }
    if (body.action === 'uploadMedia') {
      if (!body.base64 || !body.mimeType) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: 'base64 と mimeType が必要です'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      try {
        var mediaBytes = Utilities.base64Decode(body.base64);
        var mediaName = body.fileName || ('media_' + new Date().getTime());
        var mediaBlob = Utilities.newBlob(mediaBytes, body.mimeType, mediaName);
        var mediaFolder = getOrCreateMediaFolder_();
        var mediaFile = mediaFolder.createFile(mediaBlob);
        mediaFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        var mediaFileId = mediaFile.getId();
        return ContentService.createTextOutput(JSON.stringify({
          status: 'ok',
          driveFileId: mediaFileId,
          // Threads が fetch 可能な画像直リンク（googleusercontent CDN）
          publicUrl: 'https://lh3.googleusercontent.com/d/' + mediaFileId,
          altUrl: 'https://drive.google.com/uc?export=view&id=' + mediaFileId
        })).setMimeType(ContentService.MimeType.JSON);
      } catch (mediaErr) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: '画像のアップロードに失敗しました: ' + mediaErr.message
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // deleteMedia: 指定したDriveメディアをゴミ箱へ（webappの画像×削除/投稿削除時のクリーンアップ用）
    // body: { fileIds: [...] }  ※ゴミ箱なので30日間は復元可能
    if (body.action === 'deleteMedia') {
      var delIds = body.fileIds || (body.driveFileId ? [body.driveFileId] : []);
      var delTrashed = 0;
      var delFailed = [];
      for (var di = 0; di < delIds.length; di++) {
        var fid = delIds[di];
        if (!fid) continue;
        try {
          DriveApp.getFileById(fid).setTrashed(true);
          delTrashed++;
        } catch (delErr) {
          delFailed.push(String(fid)); // 既に消えている等は無視
        }
      }
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok', trashed: delTrashed, failed: delFailed
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // pruneMedia: メディアフォルダ内で keepIds に無いファイル（＝どの投稿にも紐づかない孤立画像）をゴミ箱へ
    // body: { keepIds: [...] }  ※既存の溜まり分を一掃する手動整理用
    if (body.action === 'pruneMedia') {
      var keep = {};
      var keepIds = body.keepIds || [];
      for (var ki = 0; ki < keepIds.length; ki++) {
        if (keepIds[ki]) keep[String(keepIds[ki])] = true;
      }
      var pruneTrashed = 0;
      var pruneKept = 0;
      try {
        var pruneFolder = getOrCreateMediaFolder_();
        var files = pruneFolder.getFiles();
        while (files.hasNext()) {
          var f = files.next();
          if (keep[f.getId()]) {
            pruneKept++;
          } else {
            try { f.setTrashed(true); pruneTrashed++; } catch (pErr) { /* skip */ }
          }
        }
      } catch (pruneErr) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: '画像の整理に失敗しました: ' + pruneErr.message
        })).setMimeType(ContentService.MimeType.JSON);
      }
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok', trashed: pruneTrashed, kept: pruneKept
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // setConfig: トークン設定 + USER ID自動取得 + 検証 + シート初期化（一発完結）
    if (body.action === 'setConfig') {
      if (!body.token || String(body.token).length < 10) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: 'tokenが無効です（必須・10文字以上）'
        })).setMimeType(ContentService.MimeType.JSON);
      }

      // Threads API でトークン検証 + USER ID自動取得
      var verifyResp;
      try {
        verifyResp = UrlFetchApp.fetch(API_BASE_ + 'me?fields=id,username', {
          headers: { 'Authorization': 'Bearer ' + body.token },
          muteHttpExceptions: true,
        });
      } catch (fetchErr) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: 'Threads APIに接続できません: ' + maskToken_(fetchErr.message)
        })).setMimeType(ContentService.MimeType.JSON);
      }

      var verifyCode = verifyResp.getResponseCode();
      var verifyBody;
      try {
        verifyBody = JSON.parse(verifyResp.getContentText());
      } catch (parseErr) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: 'APIレスポンス解析失敗 (HTTP ' + verifyCode + ')'
        })).setMimeType(ContentService.MimeType.JSON);
      }

      if (verifyCode !== 200 || !verifyBody.id) {
        var errMsg = 'トークンが無効です';
        if (verifyBody.error && verifyBody.error.message) {
          errMsg += ': ' + maskToken_(verifyBody.error.message);
        }
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: errMsg
        })).setMimeType(ContentService.MimeType.JSON);
      }

      // ScriptProperties に保存
      var configProps = PropertiesService.getScriptProperties();
      configProps.setProperty('THREADS_ACCESS_TOKEN', body.token);
      configProps.setProperty('THREADS_USER_ID', verifyBody.id);
      // トークン状態の初期値。直後に強制更新を試み、古い長期トークンなら60日に延長する。
      // 発行24時間未満でMeta側が拒否した場合だけ、翌日以降の自動更新に任せる。
      configProps.setProperty('TOKEN_REFRESHED_AT', String(new Date().getTime()));
      configProps.setProperty('TOKEN_EXPIRES_IN_SEC', '5184000'); // 60日
      configProps.deleteProperty('TOKEN_LAST_ERROR');
      if (body.webapp_key) {
        configProps.setProperty('WEBAPP_KEY', body.webapp_key);
      }
      // プレビュー用にWeb App URLを保存（doGetアクセスに使用）
      if (body.webapp_url) {
        configProps.setProperty('WEBAPP_URL', body.webapp_url);
      }
      _cfgCache = null; // キャッシュクリア

      // シート初期化（書式適用 + 不要シート削除）
      var cfgSs = SpreadsheetApp.getActiveSpreadsheet();
      // スプレッドシートのタイムゾーンをAsia/Tokyoに強制設定
      cfgSs.setSpreadsheetTimeZone('Asia/Tokyo');
      var cfgSheet = cfgSs.getSheetByName('投稿管理');
      if (!cfgSheet) cfgSheet = cfgSs.insertSheet('投稿管理');
      var cfgR = Math.max(cfgSheet.getLastRow() + 100, 300);
      applyPostSheetFormat_(cfgSheet, cfgR);
      cfgSheet.setTabColor('#29B6F6');

      // 不要なデフォルトシートを削除
      var defaultNames = ['シート1', 'Sheet1'];
      defaultNames.forEach(function(name) {
        var s = cfgSs.getSheetByName(name);
        if (s && cfgSs.getSheets().length > 1) {
          try { cfgSs.deleteSheet(s); } catch(e) {}
        }
      });

      // 必要なトリガーを一括セット（投稿実行=processScheduledPosts 毎分 / トークン更新=refreshAccessToken 1日おき / 監視=watchdog 6時間おき）
      // ※ ここで投稿実行トリガーを作らないと、クラウドオフロードが「有効」でも GAS が一切投稿しない
      // 既存トリガーが存在しても実際には発火していないことがあるため、クラウド修復時は必ず作り直す
      resetAllTriggers_();
      refreshAccessToken_(true);

      // スクリプトプロジェクトのタイムゾーン（マニフェスト appsscript.json の "timeZone"）
      // を返却。Asia/Tokyo 以外だと processScheduledPosts が安全のため投稿停止するので、
      // 呼び出し側（setup-cloud.sh / web の cloud/setup）で必ずチェックすること。
      var cfgScriptTz = Session.getScriptTimeZone();
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok',
        message: 'API設定完了 + シート初期化 + トリガー設定済み',
        user_id: verifyBody.id,
        username: verifyBody.username || '',
        hasTrigger: hasTrigger_('processScheduledPosts'),
        scriptTimeZone: cfgScriptTz,
        spreadsheetTimeZone: cfgSs.getSpreadsheetTimeZone()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ============================================
    // Web版ハイブリッド連携アクション
    // ============================================

    // healthCheck: Web側からの疎通確認。設定済みかどうかとトリガー有無を返す
    if (body.action === 'healthCheck') {
      var hcConfigured = isConfigured_();
      if (hcConfigured) {
        // クラウドオフロードではトリガーが消えている状態が最も危険なので、
        // Web UIの自動チェックが来た時点で自己修復する。
        ensureAllTriggers_();
      }
      var hcTriggers = ScriptApp.getProjectTriggers();
      var hcHasTrigger = hcTriggers.some(function(t) {
        return t.getHandlerFunction() === 'processScheduledPosts';
      });
      var hcHasTokenRefreshTrigger = hcTriggers.some(function(t) {
        return t.getHandlerFunction() === 'refreshAccessToken';
      });
      var hcCfg = getConfig_();
      var hcTokenState = getTokenState_();
      var hcProps = PropertiesService.getScriptProperties();
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok',
        version: GAS_VERSION,
        configured: hcConfigured,
        hasTrigger: hcHasTrigger,
        hasTokenRefreshTrigger: hcHasTokenRefreshTrigger,
        userId: hcCfg.userId || null,
        tokenFingerprint: hcTokenState.fingerprint,
        tokenStatus: hcTokenState.status,
        tokenExpiresAt: hcTokenState.expiresAt,
        tokenLastError: hcTokenState.lastError,
        scriptTimeZone: Session.getScriptTimeZone(),
        spreadsheetTimeZone: ss.getSpreadsheetTimeZone(),
        triggerResetAt: hcProps.getProperty('TRIGGER_RESET_AT') || null,
        lastProcessAttemptAt: hcProps.getProperty('LAST_PROCESS_ATTEMPT_AT') || null,
        lastProcessFinishAt: hcProps.getProperty('LAST_PROCESS_FINISH_AT') || null,
        lastProcessSkippedAt: hcProps.getProperty('LAST_PROCESS_SKIPPED_AT') || null,
        lastProcessSummary: hcProps.getProperty('LAST_PROCESS_SUMMARY') || null,
        lastProcessErrorAt: hcProps.getProperty('LAST_PROCESS_ERROR_AT') || null,
        lastProcessError: hcProps.getProperty('LAST_PROCESS_ERROR') || null
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // diagnoseScheduler: 投稿は実行せず、時間トリガーが現在の待機行を
    // 投稿対象として見るか、どの安全弁で待っているかだけ返す。
    if (body.action === 'diagnoseScheduler') {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok',
        diagnostics: diagnoseScheduler_(sheet)
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // pushQueue: Web側からの予約投稿一括Push
    // body.posts = [{ webPostId, groupNo, text, postType, publishAtJst(YYYY-MM-DDTHH:mm), sortOrder }]
    if (body.action === 'pushQueue') {
      if (!Array.isArray(body.posts) || body.posts.length === 0) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: 'postsフィールドが必要です（配列）'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      // 投稿トリガー(processScheduledPosts)と同じスクリプトロックで直列化（行操作の競合防止）
      var pqLock = LockService.getScriptLock();
      if (!pqLock.tryLock(15000)) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: '他の処理が実行中です。数秒待ってからもう一度試してください'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      try {
        // シート初期化保証（書式・ヘッダーなし状態でも append できるように）
        ensureWebColumnsHeader_(sheet);
        // 必要トリガーが（消えていたら）必ず存在するようにする
        // ＝ Webから queue を push する度に自己修復。Google投稿の修復後にトリガーが無い状態でも次の push で復活
        ensureAllTriggers_();

        var pushRows = [];        // 新規 append 用バッファ
        var pushPostIds = [];
        var upsertedCount = 0;    // 既存行を上書きした件数
        for (var pi = 0; pi < body.posts.length; pi++) {
          var pp = body.posts[pi];
          if (!pp.webPostId || !pp.text || !pp.publishAtJst) {
            return ContentService.createTextOutput(JSON.stringify({
              status: 'error', message: 'posts[' + pi + '] に必須フィールド欠落（webPostId/text/publishAtJst）'
            })).setMimeType(ContentService.MimeType.JSON);
          }
          var parsed = parseJstDateTime_(pp.publishAtJst);
          var row = new Array(TOTAL_COLS_V2);
          for (var c = 0; c < TOTAL_COLS_V2; c++) row[c] = '';
          row[COL.GROUP - 1] = pp.groupNo != null ? pp.groupNo : '';
          row[COL.TEXT - 1] = pp.text;
          row[COL.TYPE - 1] = pp.postType === 'thread' ? 'スレッド' : '単体';
          row[COL.DATE - 1] = parsed.date;
          row[COL.HOUR - 1] = parsed.hour;
          row[COL.MINUTE - 1] = parsed.minute;
          row[COL.CHAR_COUNT - 1] = String(pp.text).length;
          row[COL.STATUS - 1] = '待機中';
          row[COL.MEMO - 1] = pp.memo || 'Web連携';
          row[COL.WEB_POST_ID - 1] = pp.webPostId;
          row[COL.SYNCED - 1] = '';
          row[COL.MEDIA - 1] = (Array.isArray(pp.imageUrls) && pp.imageUrls.length > 0)
            ? JSON.stringify(pp.imageUrls)
            : '';
          // 同じ webPostId の行が既にあれば（＝下書きに戻した行・エラー行が残っている）
          // エラーにせず、その行を上書きして再キュー扱いにする（in-place なので行ずれなし）
          var existingRow = findRowByWebPostId_(sheet, pp.webPostId);
          if (existingRow > 0) {
            var existingStatus = String(sheet.getRange(existingRow, COL.STATUS).getValue() || '');
            if (existingStatus === '投稿済') {
              return ContentService.createTextOutput(JSON.stringify({
                status: 'error',
                message: 'この予約はGoogle側では既に投稿済みです。Web画面で「今すぐ同期」を押して投稿結果を取り込んでください。（webPostId=' + pp.webPostId + '）'
              })).setMimeType(ContentService.MimeType.JSON);
            }
            sheet.getRange(existingRow, 1, 1, TOTAL_COLS_V2).setValues([row]);
            sheet.getRange(existingRow, COL.POST_ID, 1, 1).setNumberFormat('@');
            sheet.getRange(existingRow, COL.WEB_POST_ID, 1, 1).setNumberFormat('@');
            upsertedCount++;
          } else {
            pushRows.push(row);
          }
          pushPostIds.push(pp.webPostId);
        }
        var appendStartRow = 0;
        if (pushRows.length > 0) {
          appendStartRow = Math.max(sheet.getLastRow() + 1, 2);
          sheet.getRange(appendStartRow, 1, pushRows.length, TOTAL_COLS_V2).setValues(pushRows);
          // POST_ID列はテキスト形式に固定（投稿後の数値精度損失防止）
          sheet.getRange(appendStartRow, COL.POST_ID, pushRows.length, 1).setNumberFormat('@');
          sheet.getRange(appendStartRow, COL.WEB_POST_ID, pushRows.length, 1).setNumberFormat('@');
        }
        // 書式適用
        var pqTotalRows = Math.max(sheet.getLastRow() + 100, 300);
        applyPostSheetFormat_(sheet, pqTotalRows);

        return ContentService.createTextOutput(JSON.stringify({
          status: 'ok',
          message: (pushRows.length + upsertedCount) + '件をシートに反映しました（新規' + pushRows.length + ' / 上書き' + upsertedCount + '）',
          rows: pushRows.length + upsertedCount,
          startRow: appendStartRow,
          webPostIds: pushPostIds
        })).setMimeType(ContentService.MimeType.JSON);
      } finally {
        pqLock.releaseLock();
      }
    }

    // verifyQueueByPostIds: Web側が「予約済み」と記録する前に、
    // Googleシート側へ本当に入ったかを確認する。ここで missing があれば
    // Web側は queued にしない（クラウド予約の空振り防止）。
    if (body.action === 'verifyQueueByPostIds') {
      if (!Array.isArray(body.webPostIds) || body.webPostIds.length === 0) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'ok', present: [], missing: [], rows: []
        })).setMimeType(ContentService.MimeType.JSON);
      }
      ensureWebColumnsHeader_(sheet);
      var vqLastRow = sheet.getLastRow();
      var vqIndex = {};
      if (vqLastRow >= 2 && sheet.getLastColumn() >= COL.WEB_POST_ID) {
        var vqData = sheet.getRange(2, 1, vqLastRow - 1, TOTAL_COLS_V2).getValues();
        for (var vqi = 0; vqi < vqData.length; vqi++) {
          var vqWebId = vqData[vqi][COL.WEB_POST_ID - 1];
          if (!vqWebId) continue;
          vqIndex[String(vqWebId)] = {
            webPostId: String(vqWebId),
            status: String(vqData[vqi][COL.STATUS - 1] || ''),
            row: vqi + 2
          };
        }
      }
      var vqPresent = [];
      var vqMissing = [];
      var vqRows = [];
      for (var vqj = 0; vqj < body.webPostIds.length; vqj++) {
        var vqTarget = String(body.webPostIds[vqj]);
        if (vqIndex[vqTarget]) {
          vqPresent.push(vqTarget);
          vqRows.push(vqIndex[vqTarget]);
        } else {
          vqMissing.push(vqTarget);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok',
        present: vqPresent,
        missing: vqMissing,
        rows: vqRows
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // updateByPostId: webPostId をキーに行を更新（編集競合対応）
    // body = { action, key, webPostId, text?, publishAtJst?, postType? }
    if (body.action === 'updateByPostId') {
      if (!body.webPostId) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: 'webPostIdが必要です'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      var upLock = LockService.getScriptLock();
      if (!upLock.tryLock(15000)) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: '他の処理が実行中です。数秒待ってからもう一度試してください'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      try {
        var upRow = findRowByWebPostId_(sheet, body.webPostId);
        if (upRow <= 0) {
          return ContentService.createTextOutput(JSON.stringify({
            status: 'error', message: 'webPostId=' + body.webPostId + ' の行が見つかりません'
          })).setMimeType(ContentService.MimeType.JSON);
        }
        // 既に投稿済なら更新不可
        var upCurStatus = sheet.getRange(upRow, COL.STATUS).getValue();
        if (upCurStatus === '投稿済') {
          return ContentService.createTextOutput(JSON.stringify({
            status: 'error', message: '既に投稿済のため更新できません（行' + upRow + '）'
          })).setMimeType(ContentService.MimeType.JSON);
        }
        if (body.text != null) {
          sheet.getRange(upRow, COL.TEXT).setValue(body.text);
          sheet.getRange(upRow, COL.CHAR_COUNT).setValue(String(body.text).length);
        }
        if (body.publishAtJst) {
          var upParsed = parseJstDateTime_(body.publishAtJst);
          sheet.getRange(upRow, COL.DATE).setValue(upParsed.date);
          sheet.getRange(upRow, COL.HOUR).setValue(upParsed.hour);
          sheet.getRange(upRow, COL.MINUTE).setValue(upParsed.minute);
        }
        if (body.postType) {
          sheet.getRange(upRow, COL.TYPE).setValue(body.postType === 'thread' ? 'スレッド' : '単体');
        }
        return ContentService.createTextOutput(JSON.stringify({
          status: 'ok', message: '行' + upRow + 'を更新しました', row: upRow
        })).setMimeType(ContentService.MimeType.JSON);
      } finally {
        upLock.releaseLock();
      }
    }

    // pullResults: 未取込（SYNCED != "1"）の posted/error 行を返却
    // body = { action, key }
    // レスポンス: { results: [{webPostId, status, threadsPostId, postUrl, postedAt, error, row}],
    //              tokenStatus, tokenExpiresAt, tokenFingerprint, recentErrorCount24h, version }
    if (body.action === 'pullResults') {
      var pullSheet = sheet;
      ensureWebColumnsHeader_(pullSheet);
      recoverPendingSuccesses_(pullSheet);
      var pullLastRow = pullSheet.getLastRow();
      var pullResults = [];
      var pullErrorCount24h = 0;
      var pullCutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (pullLastRow >= 2) {
        var pullData = pullSheet.getRange(2, 1, pullLastRow - 1, TOTAL_COLS_V2).getValues();
        for (var pr = 0; pr < pullData.length; pr++) {
          var prRow = pullData[pr];
          var prStatus = prRow[COL.STATUS - 1];
          var prWebId = prRow[COL.WEB_POST_ID - 1];
          var prSynced = prRow[COL.SYNCED - 1];
          if (!prWebId) continue; // Web連携でない行はスキップ
          var prDoneAt = prRow[COL.DONE_AT - 1];
          // 24h以内のエラーをカウント
          if (prStatus === 'エラー' && prDoneAt) {
            var dt = prDoneAt instanceof Date ? prDoneAt : new Date(prDoneAt);
            if (dt >= pullCutoff24h) pullErrorCount24h++;
          }
          // ack済はスキップ
          if (prSynced === '1' || prSynced === 1) continue;
          // posted / エラー のみ返す
          if (prStatus !== '投稿済' && prStatus !== 'エラー') continue;
          pullResults.push({
            webPostId: String(prWebId),
            status: prStatus === '投稿済' ? 'posted' : 'error',
            threadsPostId: prRow[COL.POST_ID - 1] ? String(prRow[COL.POST_ID - 1]) : null,
            postUrl: prRow[COL.POST_URL - 1] || null,
            postedAt: prDoneAt ? (prDoneAt instanceof Date ? prDoneAt.toISOString() : new Date(prDoneAt).toISOString()) : null,
            error: prRow[COL.ERROR - 1] || null,
            row: pr + 2,
          });
        }
      }
      var pendingSuccesses = listPendingSuccesses_();
      for (var ps = 0; ps < pendingSuccesses.length; ps++) {
        var pending = pendingSuccesses[ps];
        if (!pending.webPostId || pending.ackedAt) continue;
        pullResults.push({
          webPostId: String(pending.webPostId),
          status: 'posted',
          threadsPostId: pending.postId ? String(pending.postId) : null,
          postUrl: pending.postUrl || null,
          postedAt: pending.postedAt || null,
          error: null,
          row: pending.row || 0,
        });
      }
      // トークン状態
      var pullTokenState = getTokenState_();
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok',
        version: GAS_VERSION,
        results: pullResults,
        count: pullResults.length,
        tokenStatus: pullTokenState.status,
        tokenExpiresAt: pullTokenState.expiresAt,
        tokenFingerprint: pullTokenState.fingerprint,
        tokenLastError: pullTokenState.lastError,
        recentErrorCount24h: pullErrorCount24h,
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ackResults: webPostId配列をSYNCED列に "1" マーク
    // body = { action, key, webPostIds: [...] }
    if (body.action === 'ackResults') {
      if (!Array.isArray(body.webPostIds) || body.webPostIds.length === 0) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'ok', acked: 0, message: 'webPostIds空のためスキップ'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      ensureWebColumnsHeader_(sheet);
      var ackCount = 0;
      var ackMissing = [];
      for (var ai = 0; ai < body.webPostIds.length; ai++) {
        var ackId = body.webPostIds[ai];
        var ackRow = findRowByWebPostId_(sheet, ackId);
        var ackedPending = markPendingSuccessAcked_(ackId);
        if (ackRow > 0) {
          sheet.getRange(ackRow, COL.SYNCED).setValue('1');
          ackCount++;
        } else if (ackedPending) {
          ackCount++;
        } else {
          ackMissing.push(ackId);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok',
        acked: ackCount,
        missing: ackMissing,
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // cancelByPostId: webPostId をキーにシートからその行を削除（Web側で「下書きに戻す」したとき）
    //   ・行を残すと再キュー時に「重複」になり、スプシにも下書き行が居座るので削除する
    //   ・投稿トリガーと同じスクリプトロックで直列化しているので行削除しても行ずれは起きない
    //   ・既に投稿済の行は消さない（履歴として残す）
    if (body.action === 'cancelByPostId') {
      if (!body.webPostId) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: 'webPostIdが必要です'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      var cnLock = LockService.getScriptLock();
      if (!cnLock.tryLock(15000)) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'error', message: '他の処理が実行中です。数秒待ってからもう一度試してください'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      try {
        var cnRow = findRowByWebPostId_(sheet, body.webPostId);
        if (cnRow <= 0) {
          // 既に無い＝既にキャンセル済 とみなして ok を返す（冪等）
          return ContentService.createTextOutput(JSON.stringify({
            status: 'ok', message: 'webPostId=' + body.webPostId + ' の行は既にありません（キャンセル済み扱い）', row: 0, deleted: false
          })).setMimeType(ContentService.MimeType.JSON);
        }
        var cnCurStatus = sheet.getRange(cnRow, COL.STATUS).getValue();
        if (cnCurStatus === '投稿済') {
          return ContentService.createTextOutput(JSON.stringify({
            status: 'error', message: '既に投稿済のためキャンセルできません（行' + cnRow + '）'
          })).setMimeType(ContentService.MimeType.JSON);
        }
        sheet.deleteRow(cnRow);
        return ContentService.createTextOutput(JSON.stringify({
          status: 'ok', message: '行' + cnRow + 'を削除しました（キャンセル）', row: cnRow, deleted: true
        })).setMimeType(ContentService.MimeType.JSON);
      } finally {
        cnLock.releaseLock();
      }
    }

    if (body.action === 'clear') {
      var lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).clearContent();
      }
      var R = Math.max(lastRow + 100, 300);
      applyPostSheetFormat_(sheet, R);
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok', message: 'データ消去 + 書式リセット完了'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'refresh') {
      var lastRow2 = Math.max(sheet.getLastRow(), 2);
      var R2 = Math.max(lastRow2 + 100, 300);
      applyPostSheetFormat_(sheet, R2);
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok', message: '書式リセット完了'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (body.action === 'getLastDate') {
      var lastRowD = sheet.getLastRow();
      if (lastRowD <= 1) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'ok', last_date: null, message: 'データなし'
        })).setMimeType(ContentService.MimeType.JSON);
      }
      var dates = sheet.getRange(2, COL.DATE, lastRowD - 1, 1).getValues();
      var lastDate = null;
      for (var di = dates.length - 1; di >= 0; di--) {
        if (dates[di][0]) {
          lastDate = Utilities.formatDate(new Date(dates[di][0]), Session.getScriptTimeZone(), 'yyyy-MM-dd');
          break;
        }
      }
      return ContentService.createTextOutput(JSON.stringify({
        status: 'ok', last_date: lastDate
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // --- TSVデータ書き込み ---
    if (!body.tsv) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', message: 'tsvフィールドが必要です'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 既存データの末尾を取得（追記モード）
    var startRow = Math.max(sheet.getLastRow() + 1, 2);

    // TSVパース
    var rows = parseTsv_(body.tsv);
    if (rows.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error', message: 'TSVデータが空です'
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // データ書き込み（8列 → 13列に拡張、残りは空）
    var writeData = rows.map(function(row) {
      var padded = row.slice(0, TOTAL_COLS);
      while (padded.length < TOTAL_COLS) padded.push('');
      return padded;
    });

    sheet.getRange(startRow, 1, writeData.length, TOTAL_COLS).setValues(writeData);

    // 書式適用
    var totalRows = Math.max(startRow + writeData.length + 100, 300);
    applyPostSheetFormat_(sheet, totalRows);

    return ContentService.createTextOutput(JSON.stringify({
      status: 'ok',
      message: rows.length + '件を転記しました',
      rows: rows.length,
      startRow: startRow
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error', message: maskToken_(err.message)
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * TSV文字列をパースする（ダブルクォート内の改行・タブに対応）
 */
function parseTsv_(tsv) {
  var rows = [];
  var current = [];
  var field = '';
  var inQuote = false;
  var i = 0;

  while (i < tsv.length) {
    var ch = tsv[i];

    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < tsv.length && tsv[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuote = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === '\t') {
        current.push(field);
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        current.push(field);
        field = '';
        if (ch === '\r' && i + 1 < tsv.length && tsv[i + 1] === '\n') i++;
        i++;
        if (current.length > 1 || (current.length === 1 && current[0] !== '')) {
          rows.push(current);
        }
        current = [];
      } else {
        field += ch;
        i++;
      }
    }
  }
  // 最終行
  if (field || current.length > 0) {
    current.push(field);
    if (current.length > 1 || (current.length === 1 && current[0] !== '')) {
      rows.push(current);
    }
  }

  return rows;
}

// ============================================
// プレビュー機能
// ============================================

/** メニューからプレビューを開く */
/** メニューからプレビューを開く（選択行のプレビュー） */
function openPreview() {
  var sheet = getPostSheet_();
  if (!sheet) {
    SpreadsheetApp.getUi().alert('「投稿管理」シートが見つかりません。');
    return;
  }
  var html = HtmlService.createHtmlOutput(buildPreviewHtml_())
    .setWidth(460)
    .setHeight(750);
  SpreadsheetApp.getUi().showModelessDialog(html, '📱 プレビュー');
}

/** 選択行の投稿データを取得（スレッドは同グループ全行を自動取得） */
function getPreviewData() {
  var sheet = getPostSheet_();
  if (!sheet) return [];
  var sel = SpreadsheetApp.getActiveSpreadsheet().getActiveRange();
  if (!sel) return [];

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  // 選択行を取得
  var startRow = sel.getRow();
  var numRows = sel.getNumRows();
  if (startRow <= 1) startRow = 2; // ヘッダー行を除外

  // 選択行のグループ番号を収集
  var allData = sheet.getRange(2, 1, lastRow - 1, TOTAL_COLS).getValues();
  var selectedGroups = {};
  var selectedSingleRows = [];

  for (var s = 0; s < numRows; s++) {
    var rowIdx = startRow + s - 2; // allDataの0-based index
    if (rowIdx < 0 || rowIdx >= allData.length) continue;
    var group = allData[rowIdx][COL.GROUP - 1];
    var type = allData[rowIdx][COL.TYPE - 1];
    if (type === 'スレッド' && (group || group === 0)) {
      selectedGroups[group] = true;
    } else {
      selectedSingleRows.push(rowIdx);
    }
  }

  // スレッド: 選択グループに属する全行を収集
  var posts = [];
  var addedRows = {};

  // まずスレッド行を日付順で収集
  for (var i = 0; i < allData.length; i++) {
    var g = allData[i][COL.GROUP - 1];
    if ((g || g === 0) && selectedGroups[g]) {
      if (addedRows[i]) continue;
      addedRows[i] = true;
      posts.push(makePostObj_(allData[i], i));
    }
  }

  // 単体行を追加
  for (var j = 0; j < selectedSingleRows.length; j++) {
    var idx = selectedSingleRows[j];
    if (addedRows[idx]) continue;
    addedRows[idx] = true;
    posts.push(makePostObj_(allData[idx], idx));
  }

  // 行番号順にソート
  posts.sort(function(a, b) { return a.row - b.row; });
  return posts;
}

function makePostObj_(rowData, idx) {
  var dateVal = rowData[COL.DATE - 1];
  var dateStr = '';
  if (dateVal) {
    try { dateStr = Utilities.formatDate(new Date(dateVal), 'Asia/Tokyo', 'M/d'); }
    catch(ex) { dateStr = String(dateVal); }
  }
  return {
    group: rowData[COL.GROUP - 1],
    text: String(rowData[COL.TEXT - 1] || ''),
    type: rowData[COL.TYPE - 1] || '単体',
    date: dateStr,
    hour: parseInt(rowData[COL.HOUR - 1], 10) || 0,
    minute: parseInt(rowData[COL.MINUTE - 1], 10) || 0,
    status: rowData[COL.STATUS - 1] || '下書き',
    charCount: parseInt(rowData[COL.CHAR_COUNT - 1], 10) || 0,
    row: idx + 2
  };
}

/** プレビューHTML生成（サイドバー用） */
function buildPreviewHtml_() {
  return '<!DOCTYPE html>\
<html lang="ja">\
<head>\
<meta charset="UTF-8">\
<meta name="viewport" content="width=device-width,initial-scale=1.0">\
<title>プレビュー</title>\
<style>\
*{margin:0;padding:0;box-sizing:border-box}\
body{background:#000;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN",sans-serif;color:#fff;padding:0;margin:0;overflow-x:hidden}\
.toolbar{position:sticky;top:0;z-index:10;background:#111;padding:10px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #222}\
.toolbar button{background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer}\
.toolbar button:hover{background:#333}\
.toolbar .info{color:#666;font-size:11px;margin-left:auto}\
.feed{padding:0}\
.post{padding:14px 16px 10px;border-top:.5px solid #1a1a1a}\
.post.no-bt{border-top:none}\
.p-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}\
.ava{width:38px;height:38px;border-radius:50%;background:#222;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}\
.p-name{color:#fff;font-size:14px;font-weight:700}\
.p-time{color:#666;font-size:14px}\
.p-text{color:#f5f5f5;font-size:14px;line-height:1.5;word-break:break-all;overflow-wrap:break-word;white-space:pre-wrap;padding-left:48px}\
.p-meta{display:flex;gap:14px;margin-top:10px;color:#555;font-size:11px;padding-left:48px}\
.thread-line{margin-left:34px}\
.thread-line .bar{width:2px;height:18px;background:#333}\
.badge{display:inline-block;padding:2px 7px;border-radius:8px;font-size:9px;font-weight:700;margin-left:6px}\
.b-draft{background:#2a2000;color:#facc15}\
.b-wait{background:#0a1a2a;color:#60a5fa}\
.b-done{background:#0f2a0f;color:#4ade80}\
.b-err{background:#2a0f0f;color:#f87171}\
.char-count{color:#555;font-size:10px;margin-top:4px;padding-left:48px}\
.char-over{color:#f87171}\
.date-sep{padding:8px 14px;color:#555;font-size:11px;font-weight:600;border-top:1px solid #1a1a1a;text-align:center}\
.empty{padding:40px 14px;text-align:center;color:#555;font-size:13px;line-height:1.6}\
.loading{padding:40px 14px;text-align:center;color:#666;font-size:13px}\
</style>\
</head>\
<body>\
<div class="toolbar">\
  <button onclick="loadData()">🔄 再読み込み</button>\
  <span class="info" id="info"></span>\
</div>\
<div class="feed" id="feed"><div class="loading">読み込み中...</div></div>\
<script>\
function loadData(){\
  document.getElementById("feed").innerHTML=\'<div class="loading">読み込み中...</div>\';\
  google.script.run.withSuccessHandler(render).withFailureHandler(function(e){\
    document.getElementById("feed").innerHTML=\'<div class="empty">エラー: \'+e.message+\'</div>\';\
  }).getPreviewData();\
}\
function render(posts){\
  if(!posts||!posts.length){\
    document.getElementById("feed").innerHTML=\'<div class="empty">スプシで投稿の行を選択してから<br>「📱 プレビュー」を押してください</div>\';\
    document.getElementById("info").textContent="";\
    return;\
  }\
  var grouped=[];var i=0;\
  while(i<posts.length){\
    var p=posts[i];\
    if(p.type==="スレッド"&&(p.group||p.group===0)){\
      var th={type:"thread",date:p.date,hour:p.hour,minute:p.minute,status:p.status,items:[p]};\
      var g=p.group;\
      for(var j=i+1;j<posts.length;j++){\
        if(posts[j].group==g&&posts[j].date===p.date){th.items.push(posts[j]);i=j;}else break;\
      }\
      grouped.push(th);i++;\
    }else{\
      grouped.push({type:"single",date:p.date,hour:p.hour,minute:p.minute,status:p.status,text:p.text,charCount:p.charCount||0});\
      i++;\
    }\
  }\
  var totalPosts=0;\
  var html="";var lastDate="";\
  grouped.forEach(function(g){\
    if(g.date&&g.date!==lastDate){html+=\'<div class="date-sep">\'+g.date+\'</div>\';lastDate=g.date;}\
    var timeStr=("0"+g.hour).slice(-2)+":"+("0"+g.minute).slice(-2);\
    var bc=g.status==="下書き"?"b-draft":g.status==="待機中"?"b-wait":g.status==="投稿済"?"b-done":"b-err";\
    var badge=\'<span class="badge \'+bc+\'">\'+g.status+\'</span>\';\
    if(g.type==="single"){\
      totalPosts++;\
      var cc=g.charCount||g.text.length;\
      var ccCls=cc>500?"char-count char-over":"char-count";\
      html+=\'<div class="post"><div class="p-head"><div class="ava">👤</div><span class="p-name">preview</span><span class="p-time">\'+timeStr+badge+\'</span></div><div class="p-text">\'+esc(g.text)+\'</div><div class="\'+ccCls+\'">\'+cc+\'文字</div><div class="p-meta"><span>♡</span><span>💬</span><span>🔄</span><span>📤</span></div></div>\';\
    }else{\
      totalPosts++;\
      g.items.forEach(function(item,idx){\
        var cls=idx>0?"post no-bt":"post";\
        var ic=item.charCount||item.text.length;\
        var icCls=ic>500?"char-count char-over":"char-count";\
        var label=idx===0?"■"+(idx+1)+" ":"■"+(idx+1)+" ";\
        html+=\'<div class="\'+cls+\'"><div class="p-head"><div class="ava">👤</div><span class="p-name">preview</span><span class="p-time">\'+timeStr+(idx===0?badge:"")+\'</span></div><div class="p-text">\'+esc(item.text)+\'</div><div class="\'+icCls+\'">■\'+(idx+1)+\' \'+ic+\'文字</div><div class="p-meta"><span>♡</span><span>💬</span><span>🔄</span><span>📤</span></div></div>\';\
        if(idx<g.items.length-1)html+=\'<div class="thread-line"><div class="bar"></div></div>\';\
      });\
    }\
  });\
  document.getElementById("feed").innerHTML=html;\
  document.getElementById("info").textContent=totalPosts+"件";\
}\
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\\n/g,"<br>");}\
loadData();\
<\/script>\
</body>\
</html>'
}
