import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { BrowserTab } from './browser-collector';
import { HistoryEntry } from './history-collector';

const APP_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'ThreadKeeper');
const DATA_DIR = path.join(APP_DIR, 'sessions');
const INDEX_FILE = path.join(APP_DIR, 'index.json');

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

  const sessionFile = path.join(DATA_DIR, `${session.id}.json`);
  fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2), 'utf-8');

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
    const s = JSON.parse(fs.readFileSync(sessionFile, 'utf-8')) as StoredSession;
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
