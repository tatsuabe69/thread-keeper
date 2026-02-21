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
import { loadTranslations, t } from '../i18n';

// ── Prompt builder (shared across all providers) ──────────────────────────────

function buildPrompt(context: SessionData): string {
  const cfg = loadConfig();
  const i18n = loadTranslations(cfg.language || 'ja');
  const joiner = t(i18n, 'ai_joiner');
  const none = t(i18n, 'ai_none');

  const nonBrowserNames = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'iexplore']);
  const nonBrowserWindows = context.windows.filter(
    w => !nonBrowserNames.has(w.name.toLowerCase().replace('.exe', ''))
  );
  const windowLines = nonBrowserWindows
    .map(w => `・${w.title}（${w.name}）`)
    .join('\n');

  // Currently open tabs
  const tabs = context.browserTabs ?? (context.browserUrls ?? []).map(u => ({ url: u, title: u, browser: 'browser' }));
  const tabLines = tabs.slice(0, 15).map(tb => {
    let domain = tb.url;
    try { domain = new URL(tb.url).hostname.replace(/^www\./, ''); } catch { /* ok */ }
    const hasTitle = tb.title && tb.title !== tb.url && tb.title.length > 3;
    return hasTitle ? `・[${domain}] ${tb.title}` : `・${tb.url}`;
  }).join('\n');

  // Recent browser history (last 60 min) — grouped by time proximity
  const history = context.browserHistory ?? [];
  const histLines = history.slice(0, 20).map(h => {
    let domain = h.url;
    try { domain = new URL(h.url).hostname.replace(/^www\./, ''); } catch { /* ok */ }
    const mins = Math.round((Date.now() - new Date(h.visitedAt).getTime()) / 60000);
    const timeStr = mins < 60
      ? t(i18n, 'time_ago_min', { n: mins })
      : t(i18n, 'time_ago_hour', { n: Math.round(mins / 60) });
    const hasTitle = h.title && h.title !== h.url && h.title.length > 3;
    return hasTitle ? `・[${domain}] ${h.title}（${timeStr}）` : `・${h.url}（${timeStr}）`;
  }).join('\n');

  const recentFilesList = context.recentFiles.slice(0, 5).join(joiner);
  const clipPreview = context.clipboard.substring(0, 200);

  // Build prompt from i18n template with parameter substitution
  const promptTemplate = t(i18n, 'ai_prompt');
  return promptTemplate
    .replace('{history}', histLines || none)
    .replace('{tabs}', tabLines || none)
    .replace('{windows}', windowLines || none)
    .replace('{files}', recentFilesList || none)
    .replace('{clipboard}', clipPreview || none)
    .replace(/\{label_task\}/g, t(i18n, 'ai_label_task'))
    .replace(/\{label_refs\}/g, t(i18n, 'ai_label_refs'))
    .replace(/\{label_remaining\}/g, t(i18n, 'ai_label_remaining'))
    .replace(/\{output_lang\}/g, t(i18n, 'ai_output_lang'));
}

// ── Provider implementations ──────────────────────────────────────────────────

// Gemini (Google AI SDK)
let _geminiClient: GoogleGenerativeAI | null = null;
let _geminiClientKey = '';

async function callGemini(prompt: string): Promise<string> {
  const cfg = loadConfig();
  const apiKey = cfg.googleApiKey;
  if (!apiKey) throw new Error('API key not configured');

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
  if (!cfg.openaiApiKey) throw new Error('API key not configured');

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
  if (!cfg.anthropicApiKey) throw new Error('API key not configured');

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

  const i18n = loadTranslations(cfg.language || 'ja');

  try {
    const text = await callProvider(provider, prompt);
    return text || t(i18n, 'err_ai_summary_empty');
  } catch (err) {
    console.error(`[TK] AI error (${provider}):`, err);
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('401') || msg.includes('403') || msg.includes('invalid_api_key') || msg.includes('Authentication')) {
      return t(i18n, 'err_api_key_invalid');
    }
    if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('quota')) {
      return t(i18n, 'err_rate_limit');
    }
    if (msg.includes('404') || msg.includes('model_not_found') || msg.includes('not found')) {
      return t(i18n, 'err_model_not_found', { model: cfg.aiModel });
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return provider === 'ollama'
        ? t(i18n, 'err_ollama_connect')
        : t(i18n, 'err_network');
    }
    return t(i18n, 'err_ai_fail');
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
  const appCfg = loadConfig();
  const i18n = loadTranslations(appCfg.language || 'ja');

  try {
    switch (cfg.provider) {
      case 'gemini': {
        const key = cfg.googleApiKey || '';
        if (!key) throw new Error(t(i18n, 'err_api_key_empty'));
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
                throw new Error(t(i18n, 'err_api_key_bad'));
              }
              // Some other issue — show detailed error
              throw new Error(`${t(i18n, 'err_api_connect')}${errMsg.substring(0, 120)}`);
            }
          }
          throw modelErr; // re-throw for generic error handling below
        }
      }
      case 'openai': {
        const key = cfg.openaiApiKey || '';
        if (!key) throw new Error(t(i18n, 'err_api_key_empty'));
        // Use /v1/models to validate key without spending tokens
        const resp = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ok: true, model: cfg.model };
      }
      case 'anthropic': {
        const key = cfg.anthropicApiKey || '';
        if (!key) throw new Error(t(i18n, 'err_api_key_empty'));
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
        return { ok: true, model: modelList || t(i18n, 'err_model_list_ok') };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[TK] AI config test error (${cfg.provider}):`, msg);

    // Gemini model-specific error with diagnostic info
    if (msg.startsWith('MODEL_NOT_FOUND:')) {
      const badModel = msg.replace('MODEL_NOT_FOUND:', '');
      return { ok: false, error: t(i18n, 'err_model_dropdown', { model: badModel }) };
    }

    const short = msg.includes('API_KEY_INVALID') || msg.includes('401') || msg.includes('403')
      ? t(i18n, 'err_api_key_bad')
      : msg.includes('429') ? t(i18n, 'err_rate_limit_short')
      : msg.includes('ECONNREFUSED') || msg.includes('fetch failed') ? t(i18n, 'err_connect_short')
      : msg.startsWith(t(i18n, 'err_api_key_empty').substring(0, 5)) || msg.startsWith(t(i18n, 'err_api_connect').substring(0, 5)) ? msg
      : msg.substring(0, 120);
    return { ok: false, error: short };
  }
}
