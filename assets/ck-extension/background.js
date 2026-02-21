/**
 * ThreadKeeper Tab Bridge - background.js (Manifest V3 Service Worker)
 *
 * Syncs all open browser tabs to the ThreadKeeper desktop app
 * via a local HTTP relay server on localhost:9224.
 *
 * HIGH-02: Fetches auth token from relay server and includes it
 * in all subsequent POST requests for security.
 */

const CK_PORT = 9224;
const CK_BASE = `http://localhost:${CK_PORT}`;
const CK_ENDPOINT = `${CK_BASE}/tabs`;
const CK_TOKEN_ENDPOINT = `${CK_BASE}/token`;

// Auth token (fetched from relay server on first connect)
let authToken = '';

// Debounce timer to avoid flooding the server on rapid tab changes
let syncTimer = null;

/** Fetch the auth token from the relay server (CORS-protected). */
async function fetchToken() {
  try {
    const res = await fetch(CK_TOKEN_ENDPOINT);
    if (res.ok) {
      authToken = await res.text();
    }
  } catch {
    // ThreadKeeper not running — will retry on next sync
    authToken = '';
  }
}

async function syncTabs() {
  try {
    // Ensure we have a token
    if (!authToken) {
      await fetchToken();
      if (!authToken) return; // still no token — server not available
    }

    const tabs = await chrome.tabs.query({});
    const data = tabs
      .filter(t => t.url && /^https?:\/\//.test(t.url))
      .map(t => ({
        url: t.url,
        title: t.title || t.url,
        active: t.active,
        windowId: t.windowId,
      }));

    const res = await fetch(CK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(data),
    });

    // If we get 401, token may have changed (app restarted) — refetch
    if (res.status === 401) {
      authToken = '';
      await fetchToken();
      if (authToken) {
        // Retry once with new token
        await fetch(CK_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify(data),
        });
      }
    }
  } catch {
    // ThreadKeeper not running — silently ignore
  }
}

function schedulSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(syncTabs, 300);
}

// Initial sync on service worker startup
fetchToken().then(() => syncTabs());

// Sync when tabs change
chrome.tabs.onCreated.addListener(schedulSync);
chrome.tabs.onRemoved.addListener(schedulSync);
chrome.tabs.onActivated.addListener(schedulSync);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === 'complete' || info.url || info.title) schedulSync();
});
chrome.windows.onCreated.addListener(schedulSync);
chrome.windows.onRemoved.addListener(schedulSync);
