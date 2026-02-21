/**
 * ai-client.ts  (file kept as anthropic-client.ts for import-compat)
 *
 * Multi-provider AI client for generating session summaries.
 * Supported providers:
 *   - Google Gemini  (@google/generative-ai SDK)
 *   - OpenAI         (fetch → api.openai.com)
 *   - Anthropic      (fetch → api.anthropic.com)
 *   - Ollama         (fetch → localhost:11434, local LLM)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { SessionData } from '../session/collector';
import { loadConfig, AiProvider } from '../config-store';

// ── Prompt builder (shared across all providers) ──────────────────────────────

function buildPrompt(context: SessionData): string {
  const nonBrowserNames = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'iexplore']);
  const nonBrowserWindows = context.windows.filter(
    w => !nonBrowserNames.has(w.name.toLowerCase().replace('.exe', ''))
  );
  const windowLines = nonBrowserWindows
    .map(w => `・${w.title}（${w.name}）`)
    .join('\n');

  // Currently open tabs
  const tabs = context.browserTabs ?? (context.browserUrls ?? []).map(u => ({ url: u, title: u, browser: 'browser' }));
  const tabLines = tabs.slice(0, 15).map(t => {
    let domain = t.url;
    try { domain = new URL(t.url).hostname.replace(/^www\./, ''); } catch { /* ok */ }
    const hasTitle = t.title && t.title !== t.url && t.title.length > 3;
    return hasTitle ? `・[${domain}] ${t.title}` : `・${t.url}`;
  }).join('\n');

  // Recent browser history (last 60 min) — grouped by time proximity
  const history = context.browserHistory ?? [];
  const histLines = history.slice(0, 20).map(h => {
    let domain = h.url;
    try { domain = new URL(h.url).hostname.replace(/^www\./, ''); } catch { /* ok */ }
    const mins = Math.round((Date.now() - new Date(h.visitedAt).getTime()) / 60000);
    const timeStr = mins < 60 ? `${mins}分前` : `${Math.round(mins / 60)}時間前`;
    const hasTitle = h.title && h.title !== h.url && h.title.length > 3;
    return hasTitle ? `・[${domain}] ${h.title}（${timeStr}）` : `・${h.url}（${timeStr}）`;
  }).join('\n');

  const recentFilesList = context.recentFiles.slice(0, 5).join('、');
  const clipPreview = context.clipboard.substring(0, 200);

  return `あなたは作業コンテキスト記録システムです。
以下のPCの状態スナップショットから、ユーザーが「何に取り組んでいたか」を推測し、指定のフォーマットのみで回答してください。

【この1時間のブラウザ閲覧履歴（タイトルと経過時間）】
${histLines || 'なし'}

【現在開いているブラウザタブ】
${tabLines || 'なし'}

【開いていたアプリケーション】
${windowLines || 'なし'}

【最近使ったファイル】
${recentFilesList || 'なし'}

【クリップボードの内容（先頭200字）】
${clipPreview || 'なし'}

【出力フォーマット — このフォーマット以外は一切出力しないこと】
作業内容：[何をしていたかを一文で。動詞＋目的語。例：Vercelへのデプロイ設定と動作確認]
参照中：[開いていたサービス・タブのトップ3〜5件をスラッシュ区切りで。例：GitHub / Vercel / Google検索]
残タスク：[未完タスクがあれば一文。なければこの行は省略]

注意事項：
- 日本語で出力すること
- フォーマット外の文章・前置き・説明・「合っていますか？」は一切出力しない
- ページタイトル・動画名・サービス名など具体的な固有名詞を積極的に使うこと
- 閲覧履歴の流れ（何を調べていたか、どう推移したか）を重視して推測すること
- 複数の活動がある場合は最も主要なものを「作業内容」に記載し、「参照中」に列挙すること`;
}

// ── Provider implementations ──────────────────────────────────────────────────

// Gemini (Google AI SDK)
let _geminiClient: GoogleGenerativeAI | null = null;
let _geminiClientKey = '';

async function callGemini(prompt: string): Promise<string> {
  const cfg = loadConfig();
  const apiKey = cfg.googleApiKey;
  if (!apiKey) throw new Error('Google AI APIキーが設定されていません。');

  if (!_geminiClient || _geminiClientKey !== apiKey) {
    _geminiClient = new GoogleGenerativeAI(apiKey);
    _geminiClientKey = apiKey;
  }
  const modelName = cfg.aiModel || cfg.geminiModel || 'gemini-2.5-flash';
  const model = _geminiClient.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

// OpenAI (via fetch)
async function callOpenAI(prompt: string): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.openaiApiKey) throw new Error('OpenAI APIキーが設定されていません。');

  const model = cfg.aiModel || 'gpt-4o-mini';
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
      temperature: 0.7,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => resp.statusText);
    throw new Error(`OpenAI API ${resp.status}: ${err.substring(0, 120)}`);
  }
  const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content?.trim() ?? '';
}

// Anthropic Claude (via fetch)
async function callAnthropic(prompt: string): Promise<string> {
  const cfg = loadConfig();
  if (!cfg.anthropicApiKey) throw new Error('Anthropic APIキーが設定されていません。');

  const model = cfg.aiModel || 'claude-3-5-haiku-latest';
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': cfg.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => resp.statusText);
    throw new Error(`Anthropic API ${resp.status}: ${err.substring(0, 120)}`);
  }
  const data = await resp.json() as { content: Array<{ text: string }> };
  return data.content[0]?.text?.trim() ?? '';
}

// Ollama (local LLM via fetch)
async function callOllama(prompt: string): Promise<string> {
  const cfg = loadConfig();
  const baseUrl = (cfg.ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const model = cfg.aiModel || 'llama3.2';

  const resp = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text().catch(() => resp.statusText);
    throw new Error(`Ollama ${resp.status}: ${err.substring(0, 120)}`);
  }
  const data = await resp.json() as { message: { content: string } };
  return data.message?.content?.trim() ?? '';
}

// ── Router ────────────────────────────────────────────────────────────────────

async function callProvider(provider: AiProvider, prompt: string): Promise<string> {
  switch (provider) {
    case 'openai':    return callOpenAI(prompt);
    case 'anthropic': return callAnthropic(prompt);
    case 'ollama':    return callOllama(prompt);
    case 'gemini':
    default:          return callGemini(prompt);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function generateSessionSummary(context: SessionData): Promise<string> {
  const cfg = loadConfig();
  const provider: AiProvider = cfg.aiProvider || 'gemini';
  const prompt = buildPrompt(context);

  try {
    const text = await callProvider(provider, prompt);
    return text || '作業内容を推測できませんでした。';
  } catch (err) {
    console.error(`[TK] AI error (${provider}):`, err);
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('401') || msg.includes('403') || msg.includes('invalid_api_key') || msg.includes('Authentication')) {
      return 'APIキーが無効です。設定 → AI エンジン設定 から更新してください。手動でメモを入力してください。';
    }
    if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('quota')) {
      return 'APIの利用制限に達しました。しばらく待つか、設定でモデルを変更してください。手動でメモを入力してください。';
    }
    if (msg.includes('404') || msg.includes('model_not_found') || msg.includes('not found')) {
      return `モデル "${cfg.aiModel}" が見つかりません。設定 → AI エンジン設定 からモデルを変更してください。`;
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return provider === 'ollama'
        ? 'Ollamaに接続できません。Ollamaが起動しているか確認してください。'
        : 'AI サービスに接続できません。ネットワークを確認してください。';
    }
    return 'AI推測の生成に失敗しました。手動でメモを入力してください。';
  }
}

// ── Test helper (used by IPC test-ai-config handler) ─────────────────────────

export interface TestAiConfig {
  provider: AiProvider;
  googleApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  model?: string;
}

export async function testAiConfig(cfg: TestAiConfig): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    switch (cfg.provider) {
      case 'gemini': {
        const key = cfg.googleApiKey || '';
        if (!key) throw new Error('APIキーが入力されていません');
        const genAI = new GoogleGenerativeAI(key);
        const modelName = cfg.model || 'gemini-2.5-flash';

        // First: lightweight countTokens check (no generation, no tokens consumed)
        try {
          const model = genAI.getGenerativeModel({ model: modelName });
          await model.countTokens('hello');
          return { ok: true, model: modelName };
        } catch (modelErr) {
          const errMsg = modelErr instanceof Error ? modelErr.message : String(modelErr);
          console.log(`[TK] Gemini test failed for model "${modelName}":`, errMsg);

          // If model not found, try listing available models for a helpful message
          if (errMsg.includes('404') || errMsg.toLowerCase().includes('not found')) {
            // Try the API key with a known-good model to distinguish key vs model issues
            try {
              const fallback = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
              await fallback.countTokens('hello');
              // Key works but model doesn't exist
              throw new Error(`MODEL_NOT_FOUND:${modelName}`);
            } catch (fallbackErr) {
              const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
              if (fbMsg.startsWith('MODEL_NOT_FOUND:')) throw fallbackErr;
              // Both models fail — likely a key issue or API access issue
              if (fbMsg.includes('401') || fbMsg.includes('403') || fbMsg.includes('API_KEY_INVALID')) {
                throw new Error('APIキーが無効です');
              }
              // Some other issue — show detailed error
              throw new Error(`API接続エラー: ${errMsg.substring(0, 120)}`);
            }
          }
          throw modelErr; // re-throw for generic error handling below
        }
      }
      case 'openai': {
        const key = cfg.openaiApiKey || '';
        if (!key) throw new Error('APIキーが入力されていません');
        // Use /v1/models to validate key without spending tokens
        const resp = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ok: true, model: cfg.model };
      }
      case 'anthropic': {
        const key = cfg.anthropicApiKey || '';
        if (!key) throw new Error('APIキーが入力されていません');
        // Minimal message test (1 token)
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: cfg.model || 'claude-3-5-haiku-latest',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ok: true, model: cfg.model };
      }
      case 'ollama': {
        const baseUrl = (cfg.ollamaBaseUrl || 'http://localhost:11434').replace(/\/$/, '');
        // Just check if Ollama is reachable
        const resp = await fetch(`${baseUrl}/api/tags`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json() as { models?: Array<{ name: string }> };
        const modelList = (data.models ?? []).map((m: { name: string }) => m.name).join(', ');
        return { ok: true, model: modelList || '(モデルリスト取得済み)' };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TK] AI config test error (${cfg.provider}):`, msg);

    // Gemini model-specific error with diagnostic info
    if (msg.startsWith('MODEL_NOT_FOUND:')) {
      const badModel = msg.replace('MODEL_NOT_FOUND:', '');
      return { ok: false, error: `モデル "${badModel}" が見つかりません。ドロップダウンから別のモデルを選択してください` };
    }

    const short = msg.includes('API_KEY_INVALID') || msg.includes('401') || msg.includes('403')
      ? 'APIキーが無効です'
      : msg.includes('429') ? 'レート制限中です。しばらく待ってから再試行してください'
      : msg.includes('ECONNREFUSED') || msg.includes('fetch failed') ? '接続できません（サービスが起動しているか確認）'
      : msg.startsWith('APIキーが') || msg.startsWith('API接続') ? msg
      : msg.substring(0, 120);
    return { ok: false, error: short };
  }
}
