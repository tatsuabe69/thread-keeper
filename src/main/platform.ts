/**
 * platform.ts
 *
 * Cross-platform abstraction layer for ThreadKeeper.
 * Provides OS-specific paths, browser history locations,
 * and default keyboard shortcuts.
 */

import * as path from 'path';
import * as os from 'os';

export const isMac  = process.platform === 'darwin';
export const isWin  = process.platform === 'win32';

// ── App data directory ───────────────────────────────────────────────────────

export function getAppDataDir(): string {
  if (isMac) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ThreadKeeper');
  }
  // Windows (+ Linux fallback)
  return path.join(os.homedir(), 'AppData', 'Roaming', 'ThreadKeeper');
}

// ── Browser history database paths ───────────────────────────────────────────

export interface BrowserProfile {
  name:    string;
  history: string;
}

export function getBrowserHistoryPaths(): BrowserProfile[] {
  const home = os.homedir();

  if (isMac) {
    return [
      {
        name:    'chrome',
        history: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'History'),
      },
      {
        name:    'edge',
        history: path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'History'),
      },
      {
        name:    'brave',
        history: path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'Default', 'History'),
      },
      {
        name:    'chrome',
        history: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome Beta', 'Default', 'History'),
      },
    ];
  }

  // Windows
  return [
    {
      name:    'chrome',
      history: path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'History'),
    },
    {
      name:    'edge',
      history: path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'History'),
    },
    {
      name:    'brave',
      history: path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'History'),
    },
    {
      name:    'chrome',
      history: path.join(home, 'AppData', 'Local', 'Google', 'Chrome Beta', 'User Data', 'Default', 'History'),
    },
  ];
}

// ── Recent files directory ───────────────────────────────────────────────────

/**
 * Returns the path to the OS "recent files" folder, or null if the OS
 * uses a different mechanism (e.g. macOS Spotlight / mdfind).
 */
export function getRecentFilesDir(): string | null {
  if (isMac) return null; // macOS uses mdfind instead
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
}

// ── Default keyboard shortcuts ───────────────────────────────────────────────

export function getDefaultShortcuts(): { capture: string; open: string } {
  if (isMac) {
    return { capture: 'Cmd+Shift+S', open: 'Cmd+Shift+R' };
  }
  return { capture: 'Ctrl+Shift+S', open: 'Ctrl+Shift+R' };
}
