import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeStorage } from 'electron';

const CONFIG_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'ThreadKeeper');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── HIGH-01: API key encryption helpers ──────────────────────────────────────
const SENSITIVE_KEYS: (keyof AppConfig)[] = ['googleApiKey', 'openaiApiKey', 'anthropicApiKey'];

function encryptField(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value;
  try {
    const encrypted = safeStorage.encryptString(value);
    return 'enc:' + encrypted.toString('base64');
  } catch {
    return value; // fallback to plaintext if encryption fails
  }
}

function decryptField(value: string): string {
  if (!value) return value;
  if (!value.startsWith('enc:')) return value; // plaintext (legacy or unencrypted)
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    const buf = Buffer.from(value.slice(4), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    return ''; // corrupted — treat as empty
  }
}

export type AiProvider = 'gemini' | 'openai' | 'anthropic' | 'ollama';

export type HistoryMode = 'fixed' | 'since-last';

export interface AppConfig {
  // ── Existing ──
  googleApiKey: string;    // Gemini API key (kept for backward compat)
  geminiModel: string;     // Gemini model (kept for backward compat)
  openAtLogin: boolean;
  defaultBrowser: string;
  theme: string;

  // ── New: unified AI provider settings ──
  aiProvider: AiProvider;   // which provider to use
  aiModel: string;          // model name for the selected provider
  openaiApiKey: string;
  anthropicApiKey: string;
  ollamaBaseUrl: string;    // default: http://localhost:11434

  // ── Browser history settings ──
  historyMinutesBack: number;  // 15 | 30 | 60 | 120 | 240
  historyMode: HistoryMode;    // 'fixed' = use historyMinutesBack, 'since-last' = since last capture

  // ── Shortcut settings ──
  captureShortcut: string;   // default: 'Ctrl+Shift+S'
  openShortcut: string;      // default: 'Ctrl+Shift+R'

  // ── Privacy settings (LOW-04) ──
  clipboardCapture: boolean; // default: true — set false to opt out of clipboard capture
}

const DEFAULTS: AppConfig = {
  googleApiKey: '',
  geminiModel: 'gemini-2.5-flash',
  openAtLogin: false,
  defaultBrowser: 'edge',
  theme: 'system',
  // AI provider (new)
  aiProvider: 'gemini',
  aiModel: 'gemini-2.5-flash',
  openaiApiKey: '',
  anthropicApiKey: '',
  ollamaBaseUrl: 'http://localhost:11434',
  // Browser history
  historyMinutesBack: 60,
  historyMode: 'fixed',
  // Shortcuts
  captureShortcut: 'Ctrl+Shift+S',
  openShortcut: 'Ctrl+Shift+R',
  // Privacy
  clipboardCapture: true,
};

export function loadConfig(): AppConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const cfg: AppConfig = { ...DEFAULTS, ...raw };

    // HIGH-01: Decrypt sensitive fields
    for (const key of SENSITIVE_KEYS) {
      if (cfg[key] && typeof cfg[key] === 'string') {
        (cfg as unknown as Record<string, unknown>)[key] = decryptField(cfg[key] as string);
      }
    }

    // Backward compat: old configs that have googleApiKey but no aiProvider/aiModel
    // keep using gemini with the saved geminiModel
    if (!raw.aiModel && raw.geminiModel) {
      cfg.aiModel = raw.geminiModel;
    }
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * .env ファイルから Google_API_KEY を読み取り config.json に移行する。
 * 初回起動時のみ実行し、config.json が既にある場合はスキップ。
 */
export function migrateFromDotenv(appPath: string): void {
  if (fs.existsSync(CONFIG_FILE)) return; // already migrated

  const envFile = path.join(appPath, '.env');
  if (!fs.existsSync(envFile)) return;

  try {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^Google_API_KEY\s*=\s*(.+)$/);
      if (m) {
        const key = m[1].trim();
        if (key && key.startsWith('AIza')) {
          saveConfig({ googleApiKey: key });
          console.log('[TK] Migrated API key from .env to config.json');
        }
        break;
      }
    }
  } catch {
    // ignore migration errors
  }
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const current = loadConfig();
  const updated: AppConfig = { ...current, ...patch };

  // HIGH-01: Encrypt sensitive fields before writing to disk
  const toWrite = { ...updated };
  for (const key of SENSITIVE_KEYS) {
    if (toWrite[key] && typeof toWrite[key] === 'string') {
      (toWrite as unknown as Record<string, unknown>)[key] = encryptField(toWrite[key] as string);
    }
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(toWrite, null, 2), 'utf-8');
  return updated; // return decrypted version to caller
}

/** API キーが有効な形式かつ設定済みか判定 */
export function isConfigured(): boolean {
  const cfg = loadConfig();
  switch (cfg.aiProvider) {
    case 'openai':
      return !!(cfg.openaiApiKey && cfg.openaiApiKey.startsWith('sk-') && cfg.openaiApiKey.length > 20);
    case 'anthropic':
      return !!(cfg.anthropicApiKey && cfg.anthropicApiKey.startsWith('sk-ant-') && cfg.anthropicApiKey.length > 20);
    case 'ollama':
      return !!(cfg.ollamaBaseUrl); // no key needed
    case 'gemini':
    default:
      return !!(cfg.googleApiKey && cfg.googleApiKey.startsWith('AIza') && cfg.googleApiKey.length > 20);
  }
}
