/**
 * ThreadKeeper Tab Bridge - background.js (Manifest V3 Service Worker)
 *
 * Syncs all open browser tabs to the ThreadKeeper desktop app
 * via a local HTTP relay server on localhost:9224.
 */

const CK_PORT = 9224;
const CK_ENDPOINT = `http://localhost:${CK_PORT}/tabs`;

// Debounce timer to avoid flooding the server on rapid tab changes
let syncTimer = null;

async function syncTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const data = tabs
      .filter(t => t.url && /^https?:\/\//.test(t.url))
      .map(t => ({
        url: t.url,
        title: t.title || t.url,
        active: t.active,
        windowId: t.windowId,
      }));

    await fetch(CK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  } catch {
    // ThreadKeeper not running — silently ignore
  }
}

function schedulSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncTabs, 300);
}

// Initial sync on service worker startup
syncTabs();

// Sync when tabs change
chrome.tabs.onCreated.addListener(schedulSync);
chrome.tabs.onRemoved.addListener(schedulSync);
chrome.tabs.onActivated.addListener(schedulSync);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.url || info.title) schedulSync();
});
chrome.windows.onCreated.addListener(schedulSync);
chrome.windows.onRemoved.addListener(schedulSync);
