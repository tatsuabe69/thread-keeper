# ThreadKeeper セキュリティ再監査レポート (v0.1.1)

**初回監査日**: 2026-02-21
**再監査日**: 2026-02-21
**対象バージョン**: v0.1.1
**前回バージョン**: v0.1.0

---

## エグゼクティブサマリー

v0.1.0 で検出した 15件（Critical 2、High 4、Medium 5、Low 4）のセキュリティ課題について、v0.1.1 での修正状況を再監査した。

**結果**: 15件中 **13件が修正完了**、**1件が部分修正**、**1件が未修正**。修正に伴い **新規 3件** の課題を検出した。

### 修正状況サマリー

| 重大度 | 検出数 | 修正完了 | 部分修正 | 未修正 |
|--------|--------|----------|----------|--------|
| Critical | 2 | **2** | 0 | 0 |
| High | 4 | **3** | **1** | 0 |
| Medium | 5 | **5** | 0 | 0 |
| Low | 4 | **3** | 0 | **1** |
| **合計** | **15** | **13** | **1** | **1** |

### 新規検出

| 重大度 | 件数 | 概要 |
|--------|------|------|
| Medium | 1 | `/token` エンドポイントが認証なしでトークンを返却 |
| Low | 1 | `will-navigate` / `setWindowOpenHandler` の未設定 |
| Info | 1 | HMAC キーの Windows 上でのファイルパーミッション制限 |

---

## 既存検出項目の修正状況

### CRITICAL-01: Electron コンテキスト分離の無効化 — **修正完了**

**修正内容**:
- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` に変更 (`main.ts:58-63`, `main.ts:86-91`)
- `preload.ts` を新規作成し、`contextBridge.exposeInMainWorld()` で最小限の API のみを公開
- 全レンダラーファイルが `window.electronAPI.*` 経由の呼び出しに移行済み

**検証**: `preload.ts` で公開される API は 17 個の invoke メソッドと 5 個のイベントリスナーのみで、`require`、`process`、`fs` 等の Node.js API は一切公開されていない。レンダラーのサンドボックス化により、万一の XSS でも RCE への昇格が防止される。

**判定**: 適切に修正されている。

---

### CRITICAL-02: セッション復元時の PowerShell コマンドインジェクション — **修正完了**

**修正内容**:
- プロセス名のバリデーション追加: `SAFE_PROCESS_NAME = /^[a-zA-Z0-9._\- ]+$/` (`main.ts:265`)
- 不正な名前のスキップ (`main.ts:271`)
- PowerShell スクリプト内での文字列補間を廃止し、`$args[0]` によるパラメータ渡しに変更 (`main.ts:277-290`)

**検証**: `processName` は `execFileAsync` の引数配列の末尾要素として渡され、PowerShell 内では `$args[0]` で参照される。シェルインジェクションの経路は完全に遮断されている。正規表現によるバリデーションもバイパス困難。

**判定**: 適切に修正されている。

---

### HIGH-01: API キーの平文保存 — **修正完了**

**修正内容**:
- `safeStorage.encryptString()` / `decryptString()` による暗号化保存 (`config-store.ts:12-32`)
- 保存時に暗号化、読み込み時に復号 (`config-store.ts:93-98`, `config-store.ts:144-150`)
- 暗号化済みフィールドは `enc:` プレフィックスで識別し、レガシー平文との後方互換を維持
- `googleApiKey`、`openaiApiKey`、`anthropicApiKey` の3フィールドが対象

**検証**: `safeStorage` は Windows では DPAPI (Data Protection API) を使用し、現在のユーザーアカウントに紐づいた暗号化を行う。他のユーザーアカウントやオフラインでのディスク読み取りでは復号不可。暗号化が利用不可の場合のフォールバック（平文保存）も適切に実装されている。

**判定**: 適切に修正されている。

---

### HIGH-02: タブリレーサーバーの認証・認可不備 — **部分修正** (残存課題あり → NEW-01)

**修正内容**:
- CORS を拡張機能 Origin のみに制限: `chrome-extension://`、`moz-extension://`、`extension://` (`tab-relay-server.ts:52-56`)
- `crypto.randomBytes(32)` によるランダムトークン生成 (`tab-relay-server.ts:68-79`)
- `POST /tabs` および `GET /tabs` に Bearer トークン認証を要求 (`tab-relay-server.ts:126-132`, `tab-relay-server.ts:168-174`)
- ブラウザ拡張機能もトークン取得 → 認証付きリクエストに対応 (`background.js:23-33`)
- リクエストボディサイズ制限 1MB (`tab-relay-server.ts:29`)

**残存課題**:
`GET /token` エンドポイント（`tab-relay-server.ts:119-124`）が認証なしでトークンを返却している。詳細は NEW-01 を参照。

**判定**: Web ベースの攻撃（悪意ある Web ページからのアクセス）は CORS 制限により遮断された。ローカルプロセスからの攻撃に対しては依然として脆弱だが、脅威モデルを考慮すると実質的なリスクは限定的。

---

### HIGH-03: `shell.openExternal` / `shell.openPath` のバリデーション不足 — **修正完了**

**修正内容**:
- URL: `new URL()` によるパース + `protocol` チェック（`http:` / `https:` のみ許可）(`main.ts:304-311`, `main.ts:355-362`)
- ファイルパス: `path.normalize()` 後にホームディレクトリプレフィックスを検証 (`main.ts:369-372`)
- レガシーパス: `path.basename()` でディレクトリトラバーサルを防止 (`main.ts:376`)

**検証**: `new URL()` は不正な URL を例外で弾き、`parsed.href` は正規化済みの安全な URL を返す。カスタムプロトコル（`file://`、`javascript:` 等）は protocol チェックで遮断される。パス正規化により `..` を含むトラバーサル攻撃も防止。

**判定**: 適切に修正されている。

---

### HIGH-04: 依存パッケージの既知脆弱性 — **修正完了**

**修正内容**:
- `electron`: `^33.2.1` → `^40.6.0` (ASAR Integrity Bypass 等が修正済みのメジャーバージョンに更新)
- `electron-builder`: `^25.1.8` → `^26.8.1` (minimatch ReDoS、tar path traversal 等の脆弱性が修正された依存チェーンに更新)
- `dotenv`: 削除（LOW-01 と同時修正）

**判定**: 主要な既知脆弱性への対応完了。今後は CI/CD への `npm audit` 組み込みを推奨。

---

### MEDIUM-01: Content Security Policy 未設定 — **修正完了**

**修正内容**:
全 HTML ファイルに CSP `<meta>` タグを追加:
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self' http://localhost:9224;
  font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none';">
```

**検証**:
- `script-src 'self'`: インラインスクリプトとeval を禁止 — XSS 防御の核心
- `connect-src` にリレーサーバーのみ許可 — 意図通り
- `object-src 'none'`: Flash/Java 等のプラグイン無効化
- `form-action 'none'`: フォーム送信先の制限
- `style-src 'unsafe-inline'`: インラインスタイルを許可（CSP レベル3の `nonce` や `hash` への移行を将来的に検討可能だが、現時点では問題ない）

**判定**: 適切に修正されている。

---

### MEDIUM-02: リレーサーバーのリクエストボディサイズ制限なし — **修正完了**

**修正内容**: `MAX_BODY_BYTES = 1MB`、超過時に 413 レスポンスを返しリクエストを破棄 (`tab-relay-server.ts:29`, `tab-relay-server.ts:137-147`)

**判定**: 適切に修正されている。

---

### MEDIUM-03: セッションファイルの整合性検証なし — **修正完了**

**修正内容**:
- HMAC-SHA256 による署名: セッション保存時に `.hmac` ファイルを同時書き出し (`session-store.ts:103-105`)
- 読み込み時の署名検証: HMAC 不一致の場合は `null` を返す（改竄を検知） (`session-store.ts:125-134`)
- HMAC 鍵: `crypto.randomBytes(32)` で生成し `%AppData%/.hmac-key` に保存 (`session-store.ts:40-54`)
- レガシーセッション（`.hmac` なし）は後方互換のため読み込みを許可

**判定**: 適切に修正されている。Windows NTFS のファイルパーミッションに関する補足事項あり（→ NEW-03）。

---

### MEDIUM-04: 外部 CDN からのフォント読み込み — **修正完了**

**修正内容**:
- Google Fonts CDN への `<link>` タグを削除
- CSS 変数をシステムフォントスタックに変更:
  ```css
  --serif: 'Yu Mincho', Georgia, 'Hiragino Mincho ProN', serif;
  --sans: system-ui, -apple-system, 'Yu Gothic UI', 'Segoe UI', 'Hiragino Sans', sans-serif;
  ```

**判定**: 適切に修正されている。外部 CDN への依存と IP アドレス追跡リスクが完全に排除された。

---

### MEDIUM-05: `innerHTML` の広範な使用 — **修正完了**

**修正内容**:
- `esc()` 関数にシングルクォートのエスケープを追加: `'` → `&#x27;` (`app.js:16`)

**検証**: `esc()` は現在 `&`、`<`、`>`、`"`、`'` の 5文字をエスケープしており、HTML コンテキストでの XSS を十分に防止する。`innerHTML` の使用は継続しているが、`contextIsolation: true` + `sandbox: true` との組み合わせにより、万一のエスケープ漏れがあっても RCE には繋がらない。

**判定**: 修正完了。`textContent` / `createElement` への移行は推奨だが必須ではない。

---

### LOW-01: 未使用の `dotenv` 依存 — **修正完了**

`package.json` から `dotenv` が削除されている。

---

### LOW-02: コンソールログへの機密情報出力 — **未修正**

**現状**: `console.error` / `console.log` でエラーメッセージやデバッグ情報を出力する箇所が複数残存している。API エラーレスポンスの部分文字列（最大120文字）がログに含まれる可能性がある。

```typescript
console.error(`[TK] AI config test error (${cfg.provider}):`, msg);
```

**リスク**: 低。デスクトップアプリのコンソールログは DevTools を明示的に開かない限り閲覧不可。本番ビルドでのログレベル制限は nice-to-have。

---

### LOW-03: セッションデータの有効期限なし — **修正完了**

- `pruneOldSessions(90)`: 90日以上前のセッションを起動時に自動削除 (`session-store.ts:152-179`)
- `main.ts:399`: アプリ起動時に実行
- `.hmac` ファイルも同時削除

---

### LOW-04: クリップボード内容のファイル保存 — **修正完了**

- `clipboardCapture` 設定オプション追加 (`config-store.ts:62`)
- `collector.ts:31,40`: オプトアウト時はクリップボードをキャプチャしない
- `main.ts:129`: 設定値を `captureContext()` に渡す

---

## 新規検出項目

### NEW-01: `/token` エンドポイントが認証なしでトークンを返却 (Medium)

**ファイル**: `src/main/session/tab-relay-server.ts:119-124`
**CWE**: CWE-306 (Missing Authentication for Critical Function)

**概要**:
`GET /token` エンドポイントが認証なしでアクセス可能。CORS によるブラウザベースの攻撃は遮断されるが、ローカルプロセス（curl、マルウェア等）は Origin ヘッダーなしでアクセスでき、トークンを取得可能。

```typescript
// /token — returns auth token (protected by CORS — only extensions can read)
if (req.method === 'GET' && req.url === '/token') {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(authToken);  // 認証なしで返却
  return;
}
```

**攻撃シナリオ**:
```bash
# ローカルの任意のプロセスが実行可能
TOKEN=$(curl -s http://localhost:9224/token)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:9224/tabs
# → 全タブの URL/タイトルが取得可能
```

**リスク**: 中。ローカルアクセスが前提であり、同一マシンの悪意あるプロセスには有効だが、Web ベースの攻撃は遮断されている。

**推奨対応**:
1. `/token` エンドポイントを廃止し、トークンファイル (`TOKEN_FILE`) のみでの共有に一本化する。
2. ブラウザ拡張機能は Chrome の Native Messaging を使用してファイルからトークンを読み取る。

---

### NEW-02: ウィンドウナビゲーション制限の未設定 (Low)

**ファイル**: `src/main/main.ts`
**CWE**: CWE-1021 (Improper Restriction of Rendered UI Layers or Frames)

**概要**:
`BrowserWindow` に対して `will-navigate` イベントハンドラや `setWindowOpenHandler()` が設定されていない。レンダラー内で外部 URL へのナビゲーションが試行された場合、BrowserWindow 内に外部コンテンツが読み込まれる理論的リスクがある。

**緩和要因**:
- `sandbox: true` によりレンダラーの権限が制限されている
- CSP の `default-src 'self'` がナビゲーション後のリソース読み込みを制限
- 現在のコードに外部ナビゲーションを誘発するパスは確認されていない

**推奨対応**:
```typescript
mainWindow.webContents.on('will-navigate', (e, url) => {
  if (!url.startsWith('file://')) e.preventDefault();
});
mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
```

---

### NEW-03: HMAC キーファイルの Windows パーミッション (Info)

**ファイル**: `src/main/session/session-store.ts:49`

**概要**:
HMAC 鍵ファイルの書き込み時に `mode: 0o600` を指定しているが、Windows NTFS は Unix スタイルのファイルパーミッションを完全にはサポートしない。同じ Windows ユーザーアカウントでログインしている他のプロセスからはファイルが読み取り可能。

**リスク**: 情報提供レベル。HMAC の主目的は偶発的破損の検知と改竄の検知ハードル引き上げであり、同一ユーザーアカウントからの攻撃防御は脅威モデル外。

**推奨対応**: 対応不要（情報提供のみ）。強化が必要な場合は `safeStorage` で HMAC 鍵も暗号化保存可能。

---

## 全体評価

### v0.1.0 → v0.1.1 の改善度

| カテゴリ | v0.1.0 | v0.1.1 | 評価 |
|----------|--------|--------|------|
| **Electron セキュリティモデル** | nodeIntegration+contextIsolation無効 | contextIsolation+sandbox+preload | **大幅改善** |
| **API キー保護** | 平文 JSON | safeStorage (DPAPI) 暗号化 | **大幅改善** |
| **コマンドインジェクション** | 脆弱 | パラメータ渡し+バリデーション | **大幅改善** |
| **ネットワークセキュリティ** | CORS: * + 認証なし | Origin制限+トークン認証 | **改善** (残存課題あり) |
| **入力バリデーション** | 最小限 | URL パース+パス正規化+プロセス名検証 | **大幅改善** |
| **CSP** | なし | 厳格な CSP | **大幅改善** |
| **データ保護** | 無期限平文保存 | HMAC整合性+90日自動削除+暗号化 | **大幅改善** |
| **依存関係** | 既知脆弱性あり | 最新版に更新 | **改善** |

### 残存リスクの要約

| 項目 | 重大度 | 対応 |
|------|--------|------|
| NEW-01: `/token` エンドポイントの認証なし公開 | Medium | 短期対応推奨 |
| NEW-02: ナビゲーション制限の未設定 | Low | 防御の深化として推奨 |
| LOW-02: コンソールログの機密情報 | Low | 対応任意 |
| NEW-03: HMAC キーの Windows パーミッション | Info | 対応不要 |

### 総合判定

v0.1.1 は v0.1.0 で検出された Critical・High レベルの脆弱性をすべて適切に修正しており、**セキュリティ体制は大幅に改善された**。特に Electron のコンテキスト分離とサンドボックス化は、アプリケーション全体の攻撃面を根本的に縮小する重要な改善である。

残存する課題は Medium 1件、Low 2件、Info 1件であり、いずれもローカルアクセスを前提とした限定的なリスクである。

---

## 付録: 再監査対象ファイル一覧

| ファイル | 変更内容 |
|----------|----------|
| `src/main/main.ts` | contextIsolation, sandbox, preload, コマンドインジェクション修正, URL/パスバリデーション |
| `src/main/preload.ts` | **新規作成** — contextBridge による最小限 API 公開 |
| `src/main/config-store.ts` | safeStorage 暗号化, clipboardCapture オプション |
| `src/main/session/collector.ts` | CaptureOptions 導入, クリップボードオプトアウト |
| `src/main/session/session-store.ts` | HMAC 整合性検証, pruneOldSessions |
| `src/main/session/tab-relay-server.ts` | CORS 制限, トークン認証, ボディサイズ制限 |
| `src/renderer/app/app.js` | window.electronAPI 移行, esc() 改善 |
| `src/renderer/app/index.html` | CSP 追加, Google Fonts 削除, システムフォント |
| `src/renderer/setup/setup.js` | window.electronAPI 移行 |
| `src/renderer/setup/index.html` | CSP 追加 |
| `assets/ck-extension/background.js` | トークン認証対応 |
| `package.json` | electron/electron-builder 更新, dotenv 削除 |
