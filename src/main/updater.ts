/**
 * updater.ts
 *
 * Lightweight update checker using the GitHub Releases API.
 * On launch (after 5 s delay) and via a tray menu item,
 * fetches the latest release tag from GitHub and compares
 * it with the local package version.
 *
 * If a newer version exists, shows a native dialog with
 * three options: Download (opens browser), Skip This Version, Later.
 */

import { app, dialog, shell, net, BrowserWindow } from 'electron';
import { loadConfig, saveConfig } from './config-store';
import { loadTranslations, t } from './i18n';

// ── GitHub repo coordinates ──────────────────────────────────────────────────
const GITHUB_OWNER = 'tatsuabe69';
const GITHUB_REPO  = 'thread-keeper';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface ReleaseInfo {
  version: string;   // e.g. "0.3.0" (tag_name stripped of leading "v")
  htmlUrl: string;    // release page URL
  body: string;       // release notes (markdown)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compare two semver strings. Returns true if remote > local. */
export function isNewerVersion(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

/** Fetch the latest GitHub release using Electron's net module. */
function fetchLatestRelease(): Promise<ReleaseInfo> {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

    const request = net.request({
      method: 'GET',
      url,
    });
    request.setHeader('Accept', 'application/vnd.github.v3+json');
    request.setHeader('User-Agent', `ThreadKeeper/${app.getVersion()}`);

    let body = '';

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`GitHub API returned ${response.statusCode}`));
        return;
      }
      response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          const tagName: string = data.tag_name ?? '';
          resolve({
            version: tagName.replace(/^v/i, ''),
            htmlUrl: data.html_url ?? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
            body: data.body ?? '',
          });
        } catch (err) {
          reject(err);
        }
      });
      response.on('error', reject);
    });

    request.on('error', reject);
    request.end();
  });
}

/** Show a native dialog informing the user about an available update. */
async function showUpdateDialog(info: ReleaseInfo): Promise<void> {
  const cfg = loadConfig();
  const i18n = loadTranslations(cfg.language || 'ja');

  // Truncate release notes for the dialog
  let notes = info.body || '';
  if (notes.length > 300) notes = notes.slice(0, 300) + '…';

  const message = t(i18n, 'update_body', { version: info.version })
    .replace('{notes}', notes);

  const result = await dialog.showMessageBox(
    BrowserWindow.getFocusedWindow() ?? undefined as unknown as BrowserWindow,
    {
      type: 'info',
      title: t(i18n, 'update_available'),
      message: t(i18n, 'update_available'),
      detail: message,
      buttons: [
        t(i18n, 'update_download'),
        t(i18n, 'update_skip'),
        t(i18n, 'update_later'),
      ],
      defaultId: 0,
      cancelId: 2,
    }
  );

  if (result.response === 0) {
    // Download — open release page in browser
    try {
      const parsed = new URL(info.htmlUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        await shell.openExternal(parsed.href);
      }
    } catch { /* invalid URL — ignore */ }
  } else if (result.response === 1) {
    // Skip this version
    saveConfig({ skipVersion: info.version });
  }
  // response === 2 → Later — do nothing
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check for updates.
 * @param silent  If true, suppress "you're up to date" and error dialogs
 *                (used for automatic startup checks).
 *                If false, always show feedback (used for manual checks via tray).
 */
export async function checkForUpdates(silent: boolean): Promise<void> {
  const cfg = loadConfig();

  // Skip if auto-check is disabled and this is a silent (automatic) check
  if (silent && cfg.autoCheckUpdates === false) return;

  // Throttle: skip if checked within the last 6 hours (silent only)
  if (silent && cfg.lastUpdateCheck) {
    const elapsed = Date.now() - cfg.lastUpdateCheck;
    if (elapsed < CHECK_INTERVAL_MS) return;
  }

  const localVersion = app.getVersion();

  try {
    const release = await fetchLatestRelease();

    // Record timestamp
    saveConfig({ lastUpdateCheck: Date.now() });

    if (!isNewerVersion(release.version, localVersion)) {
      // Already up to date
      if (!silent) {
        const i18n = loadTranslations(cfg.language || 'ja');
        await dialog.showMessageBox(
          BrowserWindow.getFocusedWindow() ?? undefined as unknown as BrowserWindow,
          {
            type: 'info',
            title: t(i18n, 'update_latest'),
            message: t(i18n, 'update_latest'),
            detail: t(i18n, 'update_latest_body', { version: localVersion }),
            buttons: ['OK'],
          }
        );
      }
      return;
    }

    // Skip if user chose to skip this specific version (silent only)
    if (silent && cfg.skipVersion === release.version) return;

    await showUpdateDialog(release);
  } catch (err) {
    console.warn('[TK] Update check failed:', (err as Error).message);
    if (!silent) {
      const i18n = loadTranslations(cfg.language || 'ja');
      await dialog.showMessageBox(
        BrowserWindow.getFocusedWindow() ?? undefined as unknown as BrowserWindow,
        {
          type: 'warning',
          title: 'ThreadKeeper',
          message: t(i18n, 'update_check_error'),
          detail: (err as Error).message,
          buttons: ['OK'],
        }
      );
    }
  }
}
