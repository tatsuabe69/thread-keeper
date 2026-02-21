import { collectWindows, WindowInfo } from './window-collector';
import { collectClipboard } from './clipboard-collector';
import { collectRecentFiles } from './recent-files-collector';
import { collectBrowserTabs, BrowserTab } from './browser-collector';
import { collectBrowserHistory, HistoryEntry } from './history-collector';

export type { BrowserTab }    from './browser-collector';
export type { HistoryEntry }  from './history-collector';

export interface SessionData {
  windows:       WindowInfo[];
  clipboard:     string;
  recentFiles:   string[];
  browserTabs:   BrowserTab[];    // open tabs (via extension relay / CDP / UIA)
  browserHistory: HistoryEntry[]; // recent history from Chrome/Edge DB (last 60 min)
  /** @deprecated kept for backward-compat reads only */
  browserUrls?: string[];
}

export interface CaptureOptions {
  historyMinutesBack?: number;
  clipboardCapture?: boolean;  // LOW-04: opt-out of clipboard capture
}

export async function captureContext(optionsOrMinutes: CaptureOptions | number = 60): Promise<SessionData> {
  // Support both legacy (number) and new (object) calling convention
  const opts: CaptureOptions = typeof optionsOrMinutes === 'number'
    ? { historyMinutesBack: optionsOrMinutes }
    : optionsOrMinutes;
  const historyMinutesBack = opts.historyMinutesBack ?? 60;
  const shouldCaptureClipboard = opts.clipboardCapture !== false;

  const [windows, recentFiles, browserTabs, browserHistory] = await Promise.all([
    collectWindows(),
    Promise.resolve(collectRecentFiles()),
    collectBrowserTabs(),
    collectBrowserHistory(historyMinutesBack),
  ]);

  const clipboard = shouldCaptureClipboard ? collectClipboard() : '';

  return { windows, clipboard, recentFiles, browserTabs, browserHistory };
}
