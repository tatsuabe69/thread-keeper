import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  shell,
} from 'electron';
import * as path from 'path';

import { captureContext, SessionData } from './session/collector';
import { generateSessionSummary, testAiConfig, TestAiConfig } from './ai/anthropic-client';
import { saveSession, loadAllSessions, loadSession, pruneOldSessions } from './session/session-store';
import { loadConfig, saveConfig, isConfigured, migrateFromDotenv } from './config-store';
import { startRelayServer } from './session/tab-relay-server';
import { loadTranslations, clearTranslationCache, getAvailableLanguages, t } from './i18n';
import { isMac, isWin, getAppDataDir, getDefaultShortcuts, getRecentFilesDir } from './platform';
import { checkForUpdates, downloadUpdate, cancelDownload, installUpdate, getLastDetectedRelease } from './updater';
import type { ReleaseInfo } from './updater';

// ─── Single instance ──────────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); process.exit(0); }

// 2重起動されたとき → 既存ウィンドウを前面に
app.on('second-instance', () => {
  openMainWindow('sessions');
});
if (isWin) app.setAppUserModelId('com.threadkeeper.app');

function rendererPath(...parts: string[]): string {
  return path.join(app.getAppPath(), 'src', 'renderer', ...parts);
}

// ─── State ────────────────────────────────────────────────────────────────────
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let pendingSession: (SessionData & { aiSummary: string }) | null = null;
let isCapturing = false;
let isQuitting = false;
let initialTab = 'sessions'; // consumed once by get-initial-tab IPC
let pendingReleaseInfo: ReleaseInfo | null = null;

// ─── Main Window (single unified window) ─────────────────────────────────────
function openMainWindow(tab = 'sessions'): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('navigate', tab);
    return;
  }

  initialTab = tab;

  mainWindow = new BrowserWindow({
    width: 960,
    height: 660,
    minWidth: 800,
    minHeight: 540,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
    title: 'ThreadKeeper',
    show: false,
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(rendererPath('app', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Hide instead of destroy so Ctrl+Shift+S re-shows instantly
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Setup Window (first run only) ───────────────────────────────────────────
function openSetupWindow(): void {
  if (setupWindow) { setupWindow.focus(); return; }
  setupWindow = new BrowserWindow({
    width: 560,
    height: 660,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
    resizable: false,
    title: t(loadTranslations(loadConfig().language || 'ja'), 'setup_title'),
    alwaysOnTop: true,
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(rendererPath('setup', 'index.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

// ─── Capture flow ─────────────────────────────────────────────────────────────
async function captureSession(): Promise<void> {
  if (!isConfigured()) { openSetupWindow(); return; }
  if (isCapturing) return;
  // Already have a pending session — just bring the window to front
  if (pendingSession) { openMainWindow('capture'); return; }
  isCapturing = true;

  // ── Phase 0: Show window INSTANTLY — before any async work ─────────────
  openMainWindow('capture');
  if (mainWindow) mainWindow.webContents.send('capture-started');

  // ── Phase 1: Context collection (2-4s) ─────────────────────────────────
  let context: import('./session/collector').SessionData;
  try {
    console.log('[TK] Capturing context...');
    const cfg = loadConfig();
    let historyMinutes = cfg.historyMinutesBack ?? 60;
    if (cfg.historyMode === 'since-last') {
      const sessions = loadAllSessions();
      if (sessions.length > 0) {
        const sinceMs = Date.now() - new Date(sessions[0].capturedAt).getTime();
        historyMinutes = Math.max(15, Math.ceil(sinceMs / 60_000));
        console.log(`[TK] History mode: since-last → ${historyMinutes} min`);
      }
    }
    context = await captureContext({
      historyMinutesBack: historyMinutes,
      clipboardCapture: cfg.clipboardCapture !== false, // LOW-04
    });
  } catch (err) {
    console.error('[TK] Context capture error:', err);
    isCapturing = false;
    const errI18n = loadTranslations(loadConfig().language || 'ja');
    if (mainWindow) mainWindow.webContents.send('capture-error', t(errI18n, 'err_capture_fail'));
    return;
  }

  // ── Phase 2: Push context to renderer (aiSummary still empty) ──────────
  pendingSession = { ...context, aiSummary: '' };
  isCapturing = false;
  if (mainWindow) mainWindow.webContents.send('new-session-pending', pendingSession);

  // ── Phase 3: AI generation (async — does not block) ────────────────────
  try {
    const aiSummary = await generateSessionSummary(context);
    if (pendingSession) {
      pendingSession.aiSummary = aiSummary;
      if (mainWindow) mainWindow.webContents.send('session-summary-ready', aiSummary);
    }
  } catch (err) {
    console.error('[TK] AI error:', err);
    const msg = t(loadTranslations(loadConfig().language || 'ja'), 'err_ai_fail');
    if (pendingSession) {
      pendingSession.aiSummary = msg;
      if (mainWindow) mainWindow.webContents.send('session-summary-ready', msg);
    }
  }
}

// ─── Shortcut registration ────────────────────────────────────────────────────
function registerShortcuts(captureKey: string, openKey: string): { captureOk: boolean; openOk: boolean } {
  globalShortcut.unregisterAll();
  const captureOk = globalShortcut.register(captureKey, () => captureSession());
  const openOk    = globalShortcut.register(openKey,    () => openMainWindow('sessions'));
  refreshTrayMenu();
  return { captureOk, openOk };
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray(): void {
  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    );
  }
  tray = new Tray(icon);
  tray.setToolTip('ThreadKeeper');
  refreshTrayMenu();
  tray.on('double-click', () => openMainWindow('sessions'));
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const cfg = loadConfig();
  const i18n = loadTranslations(cfg.language || 'ja');
  const captureKey = cfg.captureShortcut || 'Ctrl+Shift+S';
  const openKey    = cfg.openShortcut    || 'Ctrl+Shift+R';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${t(i18n, 'tray_capture')}  ${captureKey}`, click: () => captureSession() },
    { label: `${t(i18n, 'tray_sessions')}    ${openKey}`,    click: () => openMainWindow('sessions') },
    { type: 'separator' },
    { label: t(i18n, 'tray_settings'), click: () => openMainWindow('settings') },
    { label: t(i18n, 'tray_check_update'), click: () => { openMainWindow('settings'); checkForUpdates(false); } },
    { type: 'separator' },
    { label: t(i18n, 'tray_quit'), click: () => app.exit(0) },
  ]));
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
function registerIpc(): void {
  // ── i18n ──
  ipcMain.handle('get-translations', () => {
    const cfg = loadConfig();
    return loadTranslations(cfg.language || 'ja');
  });
  ipcMain.handle('get-available-languages', () => getAvailableLanguages());

  // Initial tab for fresh window
  ipcMain.handle('get-initial-tab', () => initialTab);

  // ── Pending session ──
  ipcMain.handle('get-pending-session', () => pendingSession);
  ipcMain.handle('get-capture-state', () =>
    isCapturing ? 'collecting' : (pendingSession ? 'pending' : 'idle')
  );

  ipcMain.handle('approve-session', (_e, userNote: string) => {
    if (!pendingSession) return null;
    const session = saveSession({
      windows:        pendingSession.windows,
      clipboard:      pendingSession.clipboard,
      recentFiles:    pendingSession.recentFiles,
      browserTabs:    pendingSession.browserTabs    ?? [],
      browserHistory: pendingSession.browserHistory ?? [],
      aiSummary:      pendingSession.aiSummary,
      userNote:       userNote ?? '',
      approved:       true,
    });
    pendingSession = null;
    return session;
  });

  ipcMain.handle('skip-session', () => {
    pendingSession = null;
  });

  // ── Sessions ──
  ipcMain.handle('load-sessions', () => loadAllSessions());

  ipcMain.handle('restore-session', async (_e, id: string) => {
    const session = loadSession(id);
    if (!session) return { success: false, launched: [], urlsOpened: 0, clipboardRestored: false };

    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { clipboard } = await import('electron');

    // ── Clipboard ──
    let clipboardRestored = false;
    if (session.clipboard?.trim()) {
      try { clipboard.writeText(session.clipboard); clipboardRestored = true; } catch { /* ignore */ }
    }

    // ── App windows ──
    const BROWSER_PROCESSES = new Set(['msedge', 'chrome', 'firefox', 'brave', 'opera', 'iexplore', 'safari']);
    const BROWSER_EXE: Record<string, string> = {
      'edge': 'msedge', 'chrome': 'chrome', 'firefox': 'firefox', 'brave': 'brave',
    };
    const cfg = loadConfig();
    const preferredBrowser = BROWSER_EXE[cfg.defaultBrowser] ?? (isMac ? 'safari' : 'msedge');

    const launched: string[] = [];
    const seen = new Set<string>();

    // CRITICAL-02: Validate process names to prevent command injection
    const SAFE_PROCESS_NAME = /^[a-zA-Z0-9._\- ]+$/;

    if (isMac) {
      // ── macOS: use osascript to activate / launch apps ──
      const MAC_SKIP = new Set(['loginwindow', 'dock', 'finder', 'systemuiserver', 'spotlight']);

      for (const win of session.windows) {
        const nameLower = win.name.toLowerCase();
        if (MAC_SKIP.has(nameLower)) continue;
        if (BROWSER_PROCESSES.has(nameLower)) continue; // browsers restored via URL below
        if (!SAFE_PROCESS_NAME.test(win.name)) continue;
        if (seen.has(nameLower)) continue;
        seen.add(nameLower);
        try {
          const script = `
            tell application "${win.name.replace(/"/g, '\\"')}"
              activate
            end tell
            return "focused"
          `;
          const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 5000 });
          launched.push(`${win.name} (${stdout.trim()})`);
        } catch {
          // Try 'open -a' as fallback
          try {
            await execFileAsync('/usr/bin/open', ['-a', win.name], { timeout: 5000 });
            launched.push(`${win.name} (launched)`);
          } catch { /* ignore */ }
        }
      }
    } else {
      // ── Windows: use PowerShell to focus / launch processes ──
      const WIN_SKIP = new Set([
        'textinputhost', 'applicationframehost', 'shellexperiencehost',
        'searchhost', 'lockapp', 'startmenuexperiencehost',
        'nvidia overlay', 'nvcontainer',
      ]);

      for (const win of session.windows) {
        const nameLower = win.name.toLowerCase();
        if (WIN_SKIP.has(nameLower)) continue;
        const processName = BROWSER_PROCESSES.has(nameLower) ? preferredBrowser : win.name;
        if (!SAFE_PROCESS_NAME.test(processName)) continue;
        const processLower = processName.toLowerCase();
        if (seen.has(processLower)) continue;
        seen.add(processLower);
        try {
          const { stdout } = await execFileAsync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            '$name = $args[0]; ' +
            '$p = Get-Process -Name $name -ErrorAction SilentlyContinue | ' +
            'Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; ' +
            'if ($p) { ' +
            '  Add-Type -Name U32 -Namespace W -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);\'; ' +
            '  [W.U32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; ' +
            '  Write-Output "focused" ' +
            '} else { ' +
            '  Start-Process $name -ErrorAction SilentlyContinue; ' +
            '  Write-Output "launched" ' +
            '}',
            processName,
          ], { timeout: 5000 });
          launched.push(`${processName} (${stdout.trim()})`);
        } catch { /* ignore */ }
      }
    }

    // ── Browser URLs (from browserTabs or legacy browserUrls) ──
    const tabUrls = (session.browserTabs ?? []).map(t => t.url)
      .concat(session.browserUrls ?? [])
      .filter((u, i, a) => a.indexOf(u) === i) // de-dup
      .filter(u => /^https?:\/\//.test(u))
      .slice(0, 20);
    let urlsOpened = 0;

    for (const url of tabUrls) {
      // HIGH-03: Strict URL validation before shell.openExternal
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        await shell.openExternal(parsed.href);
        urlsOpened++;
      } catch { /* ignore */ }
    }

    return { success: true, session, launched, urlsOpened, clipboardRestored };
  });

  // ── Config ──
  ipcMain.handle('close-setup', () => { if (setupWindow) setupWindow.close(); });
  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', (_e, patch: Partial<import('./config-store').AppConfig>) => {
    const updated = saveConfig(patch);
    app.setLoginItemSettings({ openAtLogin: updated.openAtLogin });

    // Clear i18n cache if language changed
    if ('language' in patch) {
      clearTranslationCache();
    }

    // Re-register shortcuts if they changed
    const shortcutDefaults = getDefaultShortcuts();
    if ('captureShortcut' in patch || 'openShortcut' in patch) {
      registerShortcuts(
        updated.captureShortcut || shortcutDefaults.capture,
        updated.openShortcut    || shortcutDefaults.open
      );
    } else {
      refreshTrayMenu();
    }
    return updated;
  });
  // ── Shortcuts ──
  ipcMain.handle('register-shortcuts', (_e, captureKey: string, openKey: string) => {
    return registerShortcuts(captureKey, openKey);
  });

  // New unified AI config test (multi-provider)
  ipcMain.handle('test-ai-config', (_e, cfg: TestAiConfig) => testAiConfig(cfg));

  // Legacy handler kept for backward compat (setup window etc.)
  ipcMain.handle('test-api-key', async (_e, key: string, modelName?: string) => {
    return testAiConfig({ provider: 'gemini', googleApiKey: key, model: modelName });
  });
  ipcMain.handle('open-data-folder', async () => {
    await shell.openPath(getAppDataDir());
  });

  ipcMain.handle('open-extension-folder', () => {
    shell.openPath(path.join(app.getAppPath(), 'assets', 'ck-extension'));
  });

  ipcMain.handle('open-url', (_e, url: string) => {
    // HIGH-03: Strict URL validation
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(parsed.href);
      }
    } catch { /* invalid URL — silently ignore */ }
  });

  ipcMain.handle('open-path', async (_e, filePath: string) => {
    if (!filePath) return;
    const os = await import('os');
    const home = os.homedir();
    if (path.isAbsolute(filePath)) {
      // HIGH-03: Normalize and restrict to home directory
      const normalized = path.normalize(filePath);
      if (!normalized.startsWith(home)) return; // block path traversal
      shell.openPath(normalized);
    } else if (isWin) {
      // Windows legacy: only filename stored — open the .lnk in Recent folder
      const recentDir = getRecentFilesDir();
      if (!recentDir) return;
      const safeName = path.basename(filePath); // strip any ../ attempts
      shell.openPath(path.join(recentDir, safeName + '.lnk'));
    }
    // On macOS, recent files are stored as absolute paths — no .lnk fallback needed
  });

  ipcMain.handle('write-clipboard', async (_e, text: string) => {
    const { clipboard } = await import('electron');
    clipboard.writeText(String(text));
  });

  // ── Update check & download ──
  ipcMain.handle('check-for-updates', async () => {
    await checkForUpdates(false);
    const release = getLastDetectedRelease();
    if (release) pendingReleaseInfo = release;
  });

  ipcMain.handle('start-download-update', async () => {
    if (!pendingReleaseInfo) {
      return { success: false, error: 'No update available' };
    }
    const targetWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!targetWindow) {
      return { success: false, error: 'No window available' };
    }
    try {
      const filePath = await downloadUpdate(pendingReleaseInfo, targetWindow);
      return { success: true, filePath };
    } catch (err) {
      const errorMessage = (err as Error).message;
      try {
        targetWindow.webContents.send('update-error', { error: errorMessage });
      } catch { /* ignore */ }
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('cancel-download-update', () => {
    cancelDownload();
    return { success: true };
  });

  ipcMain.handle('install-update', async (_e, filePath: string) => {
    try {
      await installUpdate(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('skip-update-version', (_e, version: string) => {
    saveConfig({ skipVersion: version });
    pendingReleaseInfo = null;
    return { success: true };
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  migrateFromDotenv(app.getAppPath());
  startRelayServer(); // タブリレーサーバー起動 (port 9224)
  registerIpc();
  createTray();

  // LOW-03: Prune sessions older than 90 days on startup
  try { pruneOldSessions(90); } catch (err) {
    console.warn('[TK] Session pruning failed:', (err as Error).message);
  }

  const config = loadConfig();
  app.setLoginItemSettings({ openAtLogin: config.openAtLogin });
  const defaults = getDefaultShortcuts();
  registerShortcuts(
    config.captureShortcut || defaults.capture,
    config.openShortcut    || defaults.open
  );
  if (!isConfigured()) {
    openSetupWindow();
  } else {
    // 設定済みの場合は起動時にメインウィンドウを開く
    openMainWindow('sessions');
  }
  console.log('[TK] Started. Configured:', isConfigured());

  // Auto-update check after 5 seconds
  setTimeout(async () => {
    try {
      await checkForUpdates(true);
      const release = getLastDetectedRelease();
      if (release) pendingReleaseInfo = release;
    } catch (err) {
      console.warn('[TK] Auto update check failed:', (err as Error).message);
    }
  }, 5000);
});

app.on('window-all-closed', () => { /* tray app — keep alive */ });
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
