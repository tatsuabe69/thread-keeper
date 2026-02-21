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

export async function captureContext(historyMinutesBack = 60): Promise<SessionData> {
  const [windows, recentFiles, browserTabs, browserHistory] = await Promise.all([
    collectWindows(),
    Promise.resolve(collectRecentFiles()),
    collectBrowserTabs(),
    collectBrowserHistory(historyMinutesBack),
  ]);

  const clipboard = collectClipboard();

  return { windows, clipboard, recentFiles, browserTabs, browserHistory };
}
