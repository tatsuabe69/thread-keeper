import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { BrowserTab } from './browser-collector';
import { HistoryEntry } from './history-collector';
import { getAppDataDir } from '../platform';

const APP_DIR = getAppDataDir();
const DATA_DIR = path.join(APP_DIR, 'sessions');
const INDEX_FILE = path.join(APP_DIR, 'index.json');
const HMAC_KEY_FILE = path.join(APP_DIR, '.hmac-key');

export interface StoredSession {
  id: string;
  capturedAt: string;
  windows: Array<{ name: string; title: string }>;
  clipboard: string;
  recentFiles: string[];
  browserTabs: BrowserTab[];       // open tabs (url + title + browser)
  browserHistory: HistoryEntry[];  // recent visited history (last 60 min)
  /** @deprecated legacy field kept for reading old sessions */
  browserUrls?: string[];
  aiSummary: string;
  userNote: string;
  approved: boolean;
}

interface IndexEntry {
  id: string;
  capturedAt: string;
  aiSummary: string;
}

function ensureDirs(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── MEDIUM-03: HMAC integrity helpers ────────────────────────────────────────
function getHmacKey(): string {
  try {
    if (fs.existsSync(HMAC_KEY_FILE)) {
      return fs.readFileSync(HMAC_KEY_FILE, 'utf-8').trim();
    }
  } catch { /* generate new key */ }
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(HMAC_KEY_FILE), { recursive: true });
    fs.writeFileSync(HMAC_KEY_FILE, key, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.warn('[TK] Failed to write HMAC key:', (err as Error).message);
  }
  return key;
}

function computeHmac(data: string): string {
  return crypto.createHmac('sha256', getHmacKey()).update(data).digest('hex');
}

function readIndex(): IndexEntry[] {
  try {
    if (!fs.existsSync(INDEX_FILE)) return [];
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8')) as IndexEntry[];
  } catch {
    return [];
  }
}

function writeIndex(index: IndexEntry[]): void {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

/** Normalize a loaded session so old sessions without newer fields still work. */
function normalizeSession(s: StoredSession): StoredSession {
  if (!s.browserTabs) {
    s.browserTabs = (s.browserUrls ?? []).map(url => ({
      url,
      title: url,
      browser: 'browser',
    }));
  }
  if (!s.browserHistory) {
    s.browserHistory = [];
  }
  return s;
}

export function saveSession(
  data: Omit<StoredSession, 'id' | 'capturedAt'>
): StoredSession {
  ensureDirs();

  const session: StoredSession = {
    id: uuidv4(),
    capturedAt: new Date().toISOString(),
    ...data,
  };

  const sessionJson = JSON.stringify(session, null, 2);
  const sessionFile = path.join(DATA_DIR, `${session.id}.json`);
  fs.writeFileSync(sessionFile, sessionJson, 'utf-8');

  // MEDIUM-03: Write HMAC signature alongside the session file
  const hmacFile = path.join(DATA_DIR, `${session.id}.hmac`);
  fs.writeFileSync(hmacFile, computeHmac(sessionJson), 'utf-8');

  // Prepend to index (newest first)
  const index = readIndex();
  index.unshift({
    id: session.id,
    capturedAt: session.capturedAt,
    aiSummary: session.aiSummary,
  });
  writeIndex(index);

  console.log(`[TK] Session saved: ${session.id}`);
  return session;
}

export function loadSession(id: string): StoredSession | null {
  try {
    const sessionFile = path.join(DATA_DIR, `${id}.json`);
    const raw = fs.readFileSync(sessionFile, 'utf-8');

    // MEDIUM-03: Verify HMAC if it exists
    const hmacFile = path.join(DATA_DIR, `${id}.hmac`);
    if (fs.existsSync(hmacFile)) {
      const storedHmac = fs.readFileSync(hmacFile, 'utf-8').trim();
      const computedHmac = computeHmac(raw);
      if (storedHmac !== computedHmac) {
        console.warn(`[TK] Session ${id}: HMAC mismatch — possible tampering`);
        return null; // reject tampered file
      }
    }
    // If no .hmac file exists, this is a legacy session — allow it (backward compat)

    const s = JSON.parse(raw) as StoredSession;
    return normalizeSession(s);
  } catch {
    return null;
  }
}

export function loadAllSessions(): StoredSession[] {
  const index = readIndex();
  return index
    .map((e) => loadSession(e.id))
    .filter((s): s is StoredSession => s !== null);
}

// ── LOW-03: Data retention policy — auto-delete sessions older than 90 days ──
export function pruneOldSessions(maxAgeDays = 90): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const index = readIndex();
  const toRemove: string[] = [];
  const kept: IndexEntry[] = [];

  for (const entry of index) {
    const ts = new Date(entry.capturedAt).getTime();
    if (ts < cutoff) {
      toRemove.push(entry.id);
    } else {
      kept.push(entry);
    }
  }

  // Delete session files
  for (const id of toRemove) {
    try { fs.unlinkSync(path.join(DATA_DIR, `${id}.json`)); } catch { /* ok */ }
    try { fs.unlinkSync(path.join(DATA_DIR, `${id}.hmac`)); } catch { /* ok */ }
  }

  if (toRemove.length > 0) {
    writeIndex(kept);
    console.log(`[TK] Pruned ${toRemove.length} sessions older than ${maxAgeDays} days`);
  }

  return toRemove.length;
}
