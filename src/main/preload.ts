/**
 * preload.ts
 *
 * Exposes a minimal, safe API to renderer processes via contextBridge.
 * Replaces the old `nodeIntegration: true` + `contextIsolation: false` pattern.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Only expose what renderers actually need — no raw Node.js access
contextBridge.exposeInMainWorld('electronAPI', {
  // ── i18n ──────────────────────────────────────────────────────────────────────
  getTranslations:       ()                          => ipcRenderer.invoke('get-translations'),
  getAvailableLanguages: ()                          => ipcRenderer.invoke('get-available-languages'),

  // ── Invoke (request-response) ──────────────────────────────────────────────
  getInitialTab:      ()                          => ipcRenderer.invoke('get-initial-tab'),
  getPendingSession:  ()                          => ipcRenderer.invoke('get-pending-session'),
  getCaptureState:    ()                          => ipcRenderer.invoke('get-capture-state'),
  approveSession:     (userNote: string)          => ipcRenderer.invoke('approve-session', userNote),
  skipSession:        ()                          => ipcRenderer.invoke('skip-session'),
  loadSessions:       ()                          => ipcRenderer.invoke('load-sessions'),
  restoreSession:     (id: string)                => ipcRenderer.invoke('restore-session', id),
  closeSetup:         ()                          => ipcRenderer.invoke('close-setup'),
  getConfig:          ()                          => ipcRenderer.invoke('get-config'),
  saveConfig:         (patch: Record<string, unknown>) => ipcRenderer.invoke('save-config', patch),
  registerShortcuts:  (cap: string, open: string) => ipcRenderer.invoke('register-shortcuts', cap, open),
  testAiConfig:       (cfg: Record<string, unknown>) => ipcRenderer.invoke('test-ai-config', cfg),
  testApiKey:         (key: string, model?: string) => ipcRenderer.invoke('test-api-key', key, model),
  openDataFolder:     ()                          => ipcRenderer.invoke('open-data-folder'),
  openExtensionFolder: ()                         => ipcRenderer.invoke('open-extension-folder'),
  openUrl:            (url: string)               => ipcRenderer.invoke('open-url', url),
  openPath:           (filePath: string)          => ipcRenderer.invoke('open-path', filePath),
  writeClipboard:     (text: string)              => ipcRenderer.invoke('write-clipboard', text),
  checkForUpdates:      ()                          => ipcRenderer.invoke('check-for-updates'),
  startDownloadUpdate:  ()                          => ipcRenderer.invoke('start-download-update'),
  cancelDownloadUpdate: ()                          => ipcRenderer.invoke('cancel-download-update'),
  installUpdate:        (filePath: string)          => ipcRenderer.invoke('install-update', filePath),
  skipUpdateVersion:    (version: string)           => ipcRenderer.invoke('skip-update-version', version),

  // ── On (main → renderer events) ───────────────────────────────────────────
  onNavigate:              (cb: (tab: string) => void)     => { ipcRenderer.on('navigate',              (_e, tab) => cb(tab)); },
  onCaptureStarted:        (cb: () => void)                => { ipcRenderer.on('capture-started',       () => cb()); },
  onNewSessionPending:     (cb: (data: unknown) => void)   => { ipcRenderer.on('new-session-pending',   (_e, data) => cb(data)); },
  onCaptureError:          (cb: (msg: string) => void)     => { ipcRenderer.on('capture-error',         (_e, msg) => cb(msg)); },
  onSessionSummaryReady:   (cb: (summary: string) => void) => { ipcRenderer.on('session-summary-ready', (_e, s) => cb(s)); },
  onUpdateAvailable:       (cb: (info: unknown) => void)   => { ipcRenderer.on('update-available',        (_e, info) => cb(info)); },
  onUpdateDownloadProgress:(cb: (p: unknown) => void)      => { ipcRenderer.on('update-download-progress', (_e, p) => cb(p)); },
  onUpdateDownloaded:      (cb: (info: unknown) => void)   => { ipcRenderer.on('update-downloaded',        (_e, info) => cb(info)); },
  onUpdateError:           (cb: (info: unknown) => void)   => { ipcRenderer.on('update-error',             (_e, info) => cb(info)); },
});
