import { shell } from 'electron';
import { loadSession } from './session-store';

/**
 * Attempts to restore a saved session.
 * Currently: logs window/file context.
 * Future: launch apps by process name, open files via shell.
 */
export async function restoreSession(id: string): Promise<{ success: boolean; session: import('./session-store').StoredSession | null }> {
  const session = loadSession(id);
  if (!session) return { success: false, session: null };

  console.log('[TK] Restoring session:', session.capturedAt);
  console.log('[TK] Windows:', session.windows.map((w) => w.title).join(', '));
  console.log('[TK] Files:', session.recentFiles.join(', '));

  // Open the ThreadKeeper data folder as a "restore anchor"
  // In the future this would re-launch apps and open files
  try {
    const appDir = require('path').join(
      require('os').homedir(),
      'AppData',
      'Roaming',
      'ThreadKeeper'
    );
    await shell.openPath(appDir);
  } catch {
    // ignore
  }

  return { success: true, session };
}
