# ThreadKeeper

**作業文脈を保存・復元するデスクトップアプリ**

PCの作業状態をワンタッチで記録し、AIが何をしていたかを推測・要約。いつでも続きから再開できます。

<p align="center">
  <img src="assets/icon.png" alt="ThreadKeeper" width="128" />
</p>

## 特徴

- **ワンタッチキャプチャ** — `Ctrl+Shift+S` で今の作業状態を即座に記録
- **AI 自動要約** — 開いていたウィンドウ・タブ・ファイルからAIが作業内容を推測
- **セッション復元** — 保存したセッションをワンクリックで再現（アプリ起動 + URL復元 + クリップボード復元）
- **マルチAI対応** — Google Gemini / OpenAI / Anthropic / Ollama（ローカル）
- **多言語対応** — 日本語・English・Italiano・Deutsch・Fran&ccedil;ais・中文
- **クロスプラットフォーム** — Windows / macOS
- **アプリ内アップデート** — 新バージョンをアプリ内で直接ダウンロード＆インストール

## インストール

[Releases](https://github.com/tatsuabe69/thread-keeper/releases/latest) から最新版をダウンロード：

| OS | ファイル |
|----|---------|
| Windows | `ThreadKeeper-Setup-x.x.x.exe` |
| macOS | `ThreadKeeper-x.x.x.dmg` |

## セットアップ

初回起動時にウィザード形式のセットアップが表示されます：

1. **AIエンジン設定** — APIキーを入力してテスト
2. **ブラウザ選択** — セッション復元に使うブラウザを指定
3. **使い方チュートリアル** — 基本操作の説明

## 使い方

| 操作 | 方法 |
|-----|------|
| セッションを保存 | `Ctrl+Shift+S`（Mac: `Cmd+Shift+S`） |
| アプリを開く | `Ctrl+Shift+R`（Mac: `Cmd+Shift+R`） |
| セッションを復元 | セッション一覧から「復元」ボタン |
| トレイから操作 | タスクバーのアイコンをダブルクリック |

## ブラウザ拡張機能（推奨）

全タブのURL・タイトルを取得するには、ブラウザ拡張機能を導入してください：

1. 設定画面で「拡張機能フォルダを開く」をクリック
2. `chrome://extensions` を開く
3. 「デベロッパーモード」をON
4. 「パッケージ化されていない拡張機能を読み込む」でフォルダを指定

Chrome・Edge・Brave に対応しています。

## 開発

```bash
# 依存関係のインストール
npm install

# 開発モード（ホットリロード）
npm run dev

# ビルド
npm run build

# パッケージング
npm run dist        # Windows
npm run dist:mac    # macOS
npm run dist:all    # 両方
```

## 技術スタック

- **Electron** — デスクトップアプリフレームワーク
- **TypeScript** — メインプロセス
- **Vanilla JS** — レンダラープロセス（フレームワーク不使用）
- **sql.js** — ブラウザ履歴の読み取り
- **GitHub Actions** — CI/CD（タグプッシュで自動リリース）

## ライセンス

Copyright &copy; 2025 tatsuabe69
