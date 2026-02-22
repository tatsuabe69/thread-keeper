/**
 * updater.ts
 *
 * Lightweight update checker + in-app download & install using the
 * GitHub Releases API.
 *
 * Flow:
 *   1. checkForUpdates() fetches latest release tag from GitHub
 *   2. If newer, sends 'update-available' event to renderer (or native dialog as fallback)
 *   3. Renderer shows banner; user clicks "Download"
 *   4. downloadUpdate() streams asset to temp dir with progress events
 *   5. User clicks "Install & Restart"
 *   6. installUpdate() launches installer via shell.openPath() then quits
 */

import * as path from 'path';
import * as fs from 'fs';
import { app, dialog, shell, net, BrowserWindow } from 'electron';
import type { ClientRequest } from 'electron';
import { loadConfig, saveConfig } from './config-store';
import { loadTranslations, t } from './i18n';
import { isMac } from './platform';

// ── GitHub repo coordinates ──────────────────────────────────────────────────
const GITHUB_OWNER = 'tatsuabe69';
const GITHUB_REPO  = 'thread-keeper';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface ReleaseInfo {
  version: string;      // e.g. "0.3.0" (tag_name stripped of leading "v")
  htmlUrl: string;       // release page URL (fallback)
  downloadUrl: string;   // direct asset download URL for current platform
  body: string;          // release notes (markdown)
}

// ── Download state ───────────────────────────────────────────────────────────
let activeDownloadRequest: ClientRequest | null = null;
let downloadedFilePath: string | null = null;
let lastDetectedRelease: ReleaseInfo | null = null;

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

/** Get the last detected release info (used by main.ts to store pendingReleaseInfo). */
export function getLastDetectedRelease(): ReleaseInfo | null {
  return lastDetectedRelease;
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
          const htmlUrl = data.html_url ?? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

          // Find platform-specific asset (.exe for Windows, .dmg for macOS)
          const assets: Array<{ name: string; browser_download_url: string }> = data.assets ?? [];
          const targetExt = isMac ? '.dmg' : '.exe';
          const asset = assets.find(a => a.name.toLowerCase().endsWith(targetExt));
          const downloadUrl = asset?.browser_download_url ?? htmlUrl;

          resolve({
            version: tagName.replace(/^v/i, ''),
            htmlUrl,
            downloadUrl,
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

// ── Download & Install ───────────────────────────────────────────────────────

/**
 * Download the update asset to a temp directory.
 * Sends progress events to the renderer via webContents.send().
 * Handles GitHub 302 redirects to S3/CloudFront.
 */
export function downloadUpdate(
  info: ReleaseInfo,
  win: BrowserWindow,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(new URL(info.downloadUrl).pathname) || 'update-installer';
    const destPath = path.join(app.getPath('temp'), fileName);
    downloadedFilePath = null;

    const fileStream = fs.createWriteStream(destPath);

    function doRequest(url: string) {
      const request = net.request({ method: 'GET', url });
      request.setHeader('User-Agent', `ThreadKeeper/${app.getVersion()}`);
      activeDownloadRequest = request;

      request.on('response', (response) => {
        // Handle GitHub redirect (302 → S3/CloudFront)
        if (response.statusCode === 302 || response.statusCode === 301) {
          const location = response.headers['location'];
          const redirectUrl = Array.isArray(location) ? location[0] : location;
          if (redirectUrl) {
            doRequest(redirectUrl);
            return;
          }
        }

        if (response.statusCode !== 200) {
          activeDownloadRequest = null;
          fileStream.close();
          try { fs.unlinkSync(destPath); } catch { /* ignore */ }
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const contentLength = response.headers['content-length'];
        const totalBytes = contentLength
          ? parseInt(Array.isArray(contentLength) ? contentLength[0] : contentLength, 10)
          : 0;
        let receivedBytes = 0;

        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          fileStream.write(chunk);

          // Send progress to renderer
          const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
          const transferred = (receivedBytes / (1024 * 1024)).toFixed(1);
          const total = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
          try {
            win.webContents.send('update-download-progress', {
              percent,
              transferred,
              total,
            });
          } catch { /* window may have been closed */ }
        });

        response.on('end', () => {
          fileStream.end(() => {
            activeDownloadRequest = null;
            downloadedFilePath = destPath;
            try {
              win.webContents.send('update-downloaded', { filePath: destPath });
            } catch { /* ignore */ }
            resolve(destPath);
          });
        });

        response.on('error', (err) => {
          fileStream.close();
          activeDownloadRequest = null;
          try { fs.unlinkSync(destPath); } catch { /* ignore */ }
          reject(err);
        });
      });

      request.on('error', (err) => {
        fileStream.close();
        activeDownloadRequest = null;
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        reject(err);
      });

      request.end();
    }

    doRequest(info.downloadUrl);
  });
}

/** Cancel an in-progress download and clean up partial file. */
export function cancelDownload(): void {
  if (activeDownloadRequest) {
    activeDownloadRequest.abort();
    activeDownloadRequest = null;
  }
  if (downloadedFilePath) {
    try { fs.unlinkSync(downloadedFilePath); } catch { /* ignore */ }
    downloadedFilePath = null;
  }
}

/**
 * Launch the downloaded installer and quit the app.
 * - Windows: opens .exe installer
 * - macOS: opens .dmg (mounts it for user to drag to Applications)
 */
export async function installUpdate(filePath: string): Promise<void> {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error('Update file not found');
  }

  // shell.openPath returns empty string on success, error message on failure
  const err = await shell.openPath(filePath);
  if (err) {
    throw new Error(err);
  }

  // Give the installer a moment to start, then quit
  setTimeout(() => {
    app.quit();
  }, 1500);
}

// ── Native Dialog Fallback ───────────────────────────────────────────────────

/** Show a native dialog (fallback when no renderer window is available). */
async function showUpdateDialog(info: ReleaseInfo): Promise<void> {
  const cfg = loadConfig();
  const i18n = loadTranslations(cfg.language || 'ja');

  // Truncate release notes for the dialog
  let notes = info.body || '';
  if (notes.length > 300) notes = notes.slice(0, 300) + '\u2026';

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
    // Download — open direct download URL (or release page as fallback)
    try {
      const parsed = new URL(info.downloadUrl);
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

    // Store release info for download
    lastDetectedRelease = release;

    // Try to send event to renderer window; fallback to native dialog
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const allWindows = BrowserWindow.getAllWindows();
    const targetWindow = focusedWindow ?? allWindows[0];

    if (targetWindow) {
      targetWindow.webContents.send('update-available', {
        version: release.version,
        downloadUrl: release.downloadUrl,
        htmlUrl: release.htmlUrl,
        body: release.body,
      });
    } else {
      // No window available — fallback to native dialog
      await showUpdateDialog(release);
    }
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
