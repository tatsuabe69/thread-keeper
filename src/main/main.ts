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

// ─── Single instance ──────────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); process.exit(0); }

// 2重起動されたとき → 既存ウィンドウを前面に
app.on('second-instance', () => {
  openMainWindow('sessions');
});
app.setAppUserModelId('com.threadkeeper.app');

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
    width: 480,
    height: 420,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
    resizable: false,
    title: 'ThreadKeeper — セットアップ',
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
    if (mainWindow) mainWindow.webContents.send('capture-error', 'コンテキスト収集に失敗しました');
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
    const msg = 'AI推測の生成に失敗しました。手動でメモを入力してください。';
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
  const captureKey = cfg.captureShortcut || 'Ctrl+Shift+S';
  const openKey    = cfg.openShortcut    || 'Ctrl+Shift+R';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `📸 セッションを保存  ${captureKey}`, click: () => captureSession() },
    { label: `📋 セッション一覧    ${openKey}`,    click: () => openMainWindow('sessions') },
    { type: 'separator' },
    { label: '⚙️  設定', click: () => openMainWindow('settings') },
    { type: 'separator' },
    { label: '終了', click: () => app.exit(0) },
  ]));
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
function registerIpc(): void {
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
    const SKIP_PROCESSES = new Set([
      'textinputhost', 'applicationframehost', 'shellexperiencehost',
      'searchhost', 'lockapp', 'startmenuexperiencehost',
      'nvidia overlay', 'nvcontainer',
    ]);
    const BROWSER_PROCESSES = new Set(['msedge', 'chrome', 'firefox', 'brave', 'opera', 'iexplore']);
    const BROWSER_EXE: Record<string, string> = {
      'edge': 'msedge', 'chrome': 'chrome', 'firefox': 'firefox', 'brave': 'brave',
    };
    const cfg = loadConfig();
    const preferredBrowser = BROWSER_EXE[cfg.defaultBrowser] ?? 'msedge';

    const launched: string[] = [];
    const seen = new Set<string>();

    // CRITICAL-02: Validate process names to prevent command injection
    const SAFE_PROCESS_NAME = /^[a-zA-Z0-9._\- ]+$/;

    for (const win of session.windows) {
      const nameLower = win.name.toLowerCase();
      if (SKIP_PROCESSES.has(nameLower)) continue;
      const processName = BROWSER_PROCESSES.has(nameLower) ? preferredBrowser : win.name;
      if (!SAFE_PROCESS_NAME.test(processName)) continue; // reject suspicious names
      const processLower = processName.toLowerCase();
      if (seen.has(processLower)) continue;
      seen.add(processLower);
      try {
        // Use safe parameter passing (no string interpolation into script)
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
          processName,  // passed as $args[0], not interpolated
        ], { timeout: 5000 });
        launched.push(`${processName} (${stdout.trim()})`);
      } catch { /* ignore */ }
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
    // Re-register shortcuts if they changed
    if ('captureShortcut' in patch || 'openShortcut' in patch) {
      registerShortcuts(
        updated.captureShortcut || 'Ctrl+Shift+S',
        updated.openShortcut    || 'Ctrl+Shift+R'
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
    const { homedir } = await import('os');
    await shell.openPath(path.join(homedir(), 'AppData', 'Roaming', 'ThreadKeeper'));
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
    const { homedir } = await import('os');
    const home = homedir();
    if (path.isAbsolute(filePath)) {
      // HIGH-03: Normalize and restrict to home directory
      const normalized = path.normalize(filePath);
      if (!normalized.startsWith(home)) return; // block path traversal
      shell.openPath(normalized);
    } else {
      // Legacy: only filename stored — open the .lnk in Recent folder
      const safeName = path.basename(filePath); // strip any ../ attempts
      const lnk = path.join(
        home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent',
        safeName + '.lnk'
      );
      shell.openPath(lnk);
    }
  });

  ipcMain.handle('write-clipboard', async (_e, text: string) => {
    const { clipboard } = await import('electron');
    clipboard.writeText(String(text));
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
  registerShortcuts(
    config.captureShortcut || 'Ctrl+Shift+S',
    config.openShortcut    || 'Ctrl+Shift+R'
  );
  if (!isConfigured()) {
    openSetupWindow();
  } else {
    // 設定済みの場合は起動時にメインウィンドウを開く
    openMainWindow('sessions');
  }
  console.log('[TK] Started. Configured:', isConfigured());
});

app.on('window-all-closed', () => { /* tray app — keep alive */ });
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
