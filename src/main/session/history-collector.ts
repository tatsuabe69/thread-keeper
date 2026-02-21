/**
 * history-collector.ts
 *
 * Reads recent browser history from Chrome / Edge / Brave SQLite databases.
 * No extension or special startup flags required — works out of the box.
 *
 * Strategy:
 *   1. Locate the History SQLite file for each installed Chromium browser.
 *   2. Copy it to %TEMP% (Chrome locks the original while running).
 *   3. Query the `urls` table for entries in the last N minutes.
 *   4. Return de-duplicated results sorted by visit time (newest first).
 *
 * Chrome timestamps: microseconds since 1601-01-01 (Windows FILETIME epoch).
 * Unix timestamps:   milliseconds  since 1970-01-01
 * Offset: 11,644,473,600,000 ms
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { app }   from 'electron';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  url:       string;
  title:     string;
  visitedAt: string; // ISO-8601 string
  browser:   string; // 'chrome' | 'edge' | 'brave'
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Difference between Chrome epoch (1601-01-01) and Unix epoch (1970-01-01) in ms
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

function chromeTimeToDate(chromeMicros: number): Date {
  return new Date(Math.floor(chromeMicros / 1000) - CHROME_EPOCH_OFFSET_MS);
}

function nowToChrome(): number {
  return (Date.now() + CHROME_EPOCH_OFFSET_MS) * 1000;
}

// ── History file paths ────────────────────────────────────────────────────────

interface BrowserProfile {
  name:    string;
  history: string;
}

function getCandidates(): BrowserProfile[] {
  const local = os.homedir();
  return [
    {
      name:    'chrome',
      history: path.join(local, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History'),
    },
    {
      name:    'edge',
      history: path.join(local, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'History'),
    },
    {
      name:    'brave',
      history: path.join(local, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'History'),
    },
    {
      name:    'chrome',
      history: path.join(local, 'AppData', 'Local', 'Google', 'Chrome Beta', 'User Data', 'Default', 'History'),
    },
  ].filter(p => fs.existsSync(p.history));
}

// ── SQLite loader ─────────────────────────────────────────────────────────────

let sqlJsCache: unknown | null = null;

async function getSqlJs(): Promise<unknown | null> {
  if (sqlJsCache) return sqlJsCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js');
    const wasmPath  = path.join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    sqlJsCache = await initSqlJs({ locateFile: () => wasmPath });
    return sqlJsCache;
  } catch (e) {
    console.warn('[TK] sql.js load error:', e);
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function collectBrowserHistory(minutesBack = 60): Promise<HistoryEntry[]> {
  const profiles = getCandidates();
  if (profiles.length === 0) return [];

  const SQL = await getSqlJs() as {
    Database: new (data: Buffer) => {
      exec: (sql: string) => Array<{ values: unknown[][] }>;
      close: () => void;
    };
  } | null;

  if (!SQL) return [];

  // cutoff in Chrome microseconds
  const cutoffChrome = nowToChrome() - minutesBack * 60 * 1_000_000;

  const allEntries: HistoryEntry[] = [];

  for (const profile of profiles) {
    const tempPath = path.join(os.tmpdir(), `ck-hist-${Date.now()}.db`);
    try {
      // Copy to temp to avoid sharing violations (Chrome locks the DB while running)
      fs.copyFileSync(profile.history, tempPath);

      const buf = fs.readFileSync(tempPath);
      const db  = new SQL.Database(buf);

      const result = db.exec(`
        SELECT url, title, last_visit_time
        FROM   urls
        WHERE  last_visit_time > ${cutoffChrome}
          AND  (url LIKE 'http://%' OR url LIKE 'https://%')
          AND  url NOT LIKE 'chrome://%'
          AND  url NOT LIKE 'edge://%'
        ORDER  BY last_visit_time DESC
        LIMIT  60
      `);

      db.close();

      if (result.length > 0 && result[0].values) {
        for (const [url, title, visitTime] of result[0].values) {
          allEntries.push({
            url:       String(url),
            title:     String(title || url),
            visitedAt: chromeTimeToDate(Number(visitTime)).toISOString(),
            browser:   profile.name,
          });
        }
      }
    } catch (e) {
      console.warn(`[TK] History read failed (${profile.name}):`, (e as Error).message);
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  // De-duplicate by URL (keep most recent visit)
  const seen = new Set<string>();
  const unique = allEntries.filter(e => {
    const key = e.url.replace(/[?#].*$/, ''); // normalise: strip query/hash for dedup
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[TK] Browser history: ${unique.length} entries (last ${minutesBack} min)`);
  return unique.slice(0, 40);
}
