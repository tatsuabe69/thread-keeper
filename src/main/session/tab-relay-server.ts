/**
 * tab-relay-server.ts
 *
 * Tiny HTTP server (localhost:9224) that receives tab data
 * from the ThreadKeeper browser extension and holds it in memory.
 *
 * The browser extension POSTs { url, title, active, windowId }[]
 * whenever tabs change. browser-collector.ts reads via getRelayTabs().
 */

import * as http from 'http';

export interface RelayTab {
  url: string;
  title: string;
  active: boolean;
  windowId?: number;
}

const RELAY_PORT = 9224;

let latestTabs: RelayTab[] = [];
let server: http.Server | null = null;

/** Returns the most recent tab snapshot from the browser extension. */
export function getRelayTabs(): RelayTab[] {
  return latestTabs;
}

/** Returns true if at least one tab has been received from the extension. */
export function isRelayConnected(): boolean {
  return latestTabs.length > 0;
}

/** Starts the relay HTTP server.  Safe to call multiple times (no-op if already running). */
export function startRelayServer(): void {
  if (server) return;

  server = http.createServer((req, res) => {
    // Allow requests from browser extensions (cross-origin)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/tabs') {
      let body = '';
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed)) {
            latestTabs = (parsed as RelayTab[]).filter(
              t => t.url && /^https?:\/\//.test(t.url)
            );
            console.log(`[TK] Relay: ${latestTabs.length} tabs received from extension`);
          }
        } catch { /* ignore malformed body */ }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/tabs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(latestTabs));
      return;
    }

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ThreadKeeper relay OK');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(RELAY_PORT, '127.0.0.1', () => {
    console.log(`[TK] Tab relay server started on port ${RELAY_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[TK] Tab relay port ${RELAY_PORT} already in use — skipping`);
    } else {
      console.warn('[TK] Tab relay server error:', err.message);
    }
  });
}

export function stopRelayServer(): void {
  server?.close();
  server = null;
}
