/**
 * tab-relay-server.ts
 *
 * Tiny HTTP server (localhost:9224) that receives tab data
 * from the ThreadKeeper browser extension and holds it in memory.
 *
 * The browser extension POSTs { url, title, active, windowId }[]
 * whenever tabs change. browser-collector.ts reads via getRelayTabs().
 *
 * Security:
 *  - HIGH-02: CORS restricted to browser-extension origins; auth token required
 *  - MEDIUM-02: Request body limited to 1 MB
 */

import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getAppDataDir } from '../platform';

export interface RelayTab {
  url: string;
  title: string;
  active: boolean;
  windowId?: number;
}

const RELAY_PORT = 9224;
const MAX_BODY_BYTES = 1 * 1024 * 1024; // MEDIUM-02: 1 MB limit
const TOKEN_FILE = path.join(getAppDataDir(), '.relay-token');

let latestTabs: RelayTab[] = [];
let server: http.Server | null = null;
let authToken: string = '';

/** Returns the most recent tab snapshot from the browser extension. */
export function getRelayTabs(): RelayTab[] {
  return latestTabs;
}

/** Returns true if at least one tab has been received from the extension. */
export function isRelayConnected(): boolean {
  return latestTabs.length > 0;
}

/** Returns the current auth token (for passing to extension via other channels). */
export function getRelayToken(): string {
  return authToken;
}

// ── HIGH-02: CORS — only allow browser extension origins ─────────────────────
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // no Origin header = same-origin or non-browser
  // Allow Chrome/Edge extensions and Firefox add-ons
  return /^(chrome-extension|moz-extension|extension):\/\//.test(origin);
}

function setCorsHeaders(res: http.ServerResponse, origin: string | undefined): void {
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
}

// ── HIGH-02: Auth token ──────────────────────────────────────────────────────
function generateToken(): string {
  authToken = crypto.randomBytes(32).toString('hex');
  // Write token to file so the extension can read it
  try {
    const dir = path.dirname(TOKEN_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, authToken, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.warn('[TK] Failed to write relay token file:', (err as Error).message);
  }
  return authToken;
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers['authorization'];
  if (!header) return false;
  const parts = header.split(' ');
  return parts[0] === 'Bearer' && parts[1] === authToken;
}

/** Starts the relay HTTP server.  Safe to call multiple times (no-op if already running). */
export function startRelayServer(): void {
  if (server) return;

  generateToken();

  server = http.createServer((req, res) => {
    const origin = req.headers['origin'] as string | undefined;

    // HIGH-02: Reject requests from disallowed origins
    if (origin && !isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    setCorsHeaders(res, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // /ping — lightweight health check (no auth required)
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ThreadKeeper relay OK');
      return;
    }

    // /token — returns auth token (protected by CORS — only extensions can read)
    if (req.method === 'GET' && req.url === '/token') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(authToken);
      return;
    }

    if (req.method === 'POST' && req.url === '/tabs') {
      // HIGH-02: Require auth token on POST
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }

      let body = '';
      let bodyBytes = 0;

      req.on('data', (chunk: Buffer | string) => {
        const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString();
        bodyBytes += Buffer.byteLength(chunkStr);

        // MEDIUM-02: Reject oversized requests
        if (bodyBytes > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Request entity too large');
          req.destroy();
          return;
        }

        body += chunkStr;
      });

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
      // HIGH-02: Require auth for reading tabs too
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(latestTabs));
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
  // Clean up token file
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* ignore */ }
}
