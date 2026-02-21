/**
 * browser-collector.ts
 *
 * Collects currently open browser tabs (URL + page title) using three strategies:
 *
 *  1. Chrome DevTools Protocol (CDP) — gets ALL open tabs with titles.
 *     Works when Chrome/Edge is started with --remote-debugging-port=9222.
 *     Cross-platform.
 *
 *  2. Pure-PowerShell UI Automation (Windows only, 2-phase warm-up):
 *       Phase 1 — Touch each browser window to wake its lazy UIA provider
 *       Wait   — 1000 ms for providers to become ready
 *       Phase 2 — Find OmniboxViewViews (Chrome/Edge), urlbar-input (Firefox),
 *                  capture URL + window title as tab title.
 *
 *  3. AppleScript (macOS only):
 *       Queries Chrome, Edge, Brave, and Safari for all open tab URLs/titles
 *       via `osascript`.
 *
 *  Key notes:
 *  - Chrome's OmniboxViewViews shows the URL WITHOUT "https://" prefix → we normalize.
 *  - The window title (root.Current.Name) equals the active tab's page title.
 *  - CDP preferred when available; UIA (Windows) / AppleScript (macOS) is the fallback.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import { getRelayTabs } from './tab-relay-server';
import { isMac } from '../platform';

const execFileAsync = promisify(execFile);

// ── Shared type ───────────────────────────────────────────────────────────────

export interface BrowserTab {
  url: string;
  title: string;
  browser: string; // 'chrome' | 'msedge' | 'firefox' | 'brave' | …
}

// ── 1. Chrome DevTools Protocol ───────────────────────────────────────────────

interface CdpTab { type?: string; url?: string; title?: string; }

async function getTabsViaCDP(port = 9222, timeoutMs = 1500): Promise<BrowserTab[]> {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: 'localhost', port, path: '/json', timeout: timeoutMs },
      res => {
        let data = '';
        res.on('data', (c: string) => (data += c));
        res.on('end', () => {
          try {
            const tabs = JSON.parse(data) as CdpTab[];
            resolve(tabs
              .filter(t => t.type === 'page' && t.url && /^https?:\/\//.test(t.url))
              .map(t => ({
                url: t.url!,
                title: t.title?.replace(/\s*[-–|]\s*(Google Chrome|Microsoft Edge|Chromium)\s*$/i, '').trim() || t.url!,
                browser: 'chrome',
              })));
          } catch { resolve([]); }
        });
      }
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

// ── 2. UI Automation via PowerShell ──────────────────────────────────────────
//
// Chrome lazy-inits its UIA provider.  Phase 1 "wakes" each browser window;
// after sleeping 1000 ms the full tree is available for Phase 2 queries.
//
// Output JSON per entry: { proc, url, winTitle }
//   proc     — browser process name
//   url      — address bar value (may lack "https://")
//   winTitle — MainWindow title = active tab page title

const UIA_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes  -ErrorAction SilentlyContinue

$SWA  = [System.Windows.Automation.AutomationElement]
$TScp = [System.Windows.Automation.TreeScope]
$ValP = [System.Windows.Automation.ValuePattern]
$TC   = [System.Windows.Automation.Condition]::TrueCondition

$browsers = @('chrome','msedge','firefox','brave','opera')
$roots    = [System.Collections.Generic.List[hashtable]]::new()

# ── Phase 1: touch every browser window to wake its UIA provider ─────────────
foreach ($n in $browsers) {
  Get-Process -Name $n -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    ForEach-Object {
      try {
        $ptr  = [System.IntPtr]::new([Int64]$_.MainWindowHandle)
        $root = $SWA::FromHandle($ptr)
        if ($root) {
          $null = $root.FindAll($TScp::Children, $TC)
          $roots.Add(@{ name = $n; root = $root })
        }
      } catch {}
    }
}

if ($roots.Count -gt 0) { Start-Sleep -Milliseconds 1000 }

# ── Phase 2: query URLs + window titles ──────────────────────────────────────

# OmniboxViewViews = Chromium address bar (Chrome, Edge, Brave, Opera)
$omniboxCond = [System.Windows.Automation.PropertyCondition]::new(
  $SWA::ClassNameProperty, 'OmniboxViewViews')

# Firefox urlbar-input
$ffCond = [System.Windows.Automation.PropertyCondition]::new(
  $SWA::AutomationIdProperty, 'urlbar-input')

# Generic fallback: Edit + ValuePattern
$editCond = [System.Windows.Automation.AndCondition]::new(
  [System.Windows.Automation.PropertyCondition]::new(
    $SWA::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit),
  [System.Windows.Automation.PropertyCondition]::new(
    $SWA::IsValuePatternAvailableProperty, $true))

$out = [System.Collections.Generic.List[PSObject]]::new()

foreach ($item in $roots) {
  try {
    $root     = $item.root
    # Window title = active tab's page title (e.g. "動画名 - YouTube")
    $winTitle = $root.Current.Name
    $found    = $false

    # Strip " - Google Chrome" / " - Microsoft Edge" suffixes from title
    $cleanTitle = $winTitle -replace '\s*[-\u2013|]\s*(Google Chrome|Microsoft Edge|Chromium|Mozilla Firefox|Brave|Opera)\s*$', ''

    # ── Fast path 1: OmniboxViewViews (Chromium-based browsers)
    if (-not $found) {
      try {
        $el = $root.FindFirst($TScp::Descendants, $omniboxCond)
        if ($el) {
          $v = $el.GetCurrentPropertyValue($ValP::ValueProperty)
          if ($v -and ("$v").Length -gt 3) {
            if ("$v" -notmatch '^https?://') { $v = 'https://' + $v }
            if ("$v" -match '^https?://') {
              $out.Add([PSCustomObject]@{
                proc     = $item.name
                url      = "$v"
                winTitle = $cleanTitle
              })
              $found = $true
            }
          }
        }
      } catch {}
    }

    # ── Fast path 2: Firefox urlbar-input
    if (-not $found) {
      try {
        $el = $root.FindFirst($TScp::Descendants, $ffCond)
        if ($el) {
          $v = ($el.GetCurrentPattern($ValP::Pattern)).Current.Value
          if ($v -match '^https?://') {
            $out.Add([PSCustomObject]@{
              proc     = $item.name
              url      = $v
              winTitle = $cleanTitle
            })
            $found = $true
          }
        }
      } catch {}
    }

    # ── Fallback: generic Edit+ValuePattern scan
    if (-not $found) {
      $edits = $root.FindAll($TScp::Descendants, $editCond)
      foreach ($e in $edits) {
        if ($found) { break }
        try {
          $v = ($e.GetCurrentPattern($ValP::Pattern)).Current.Value
          if ($v -match '^https?://') {
            $out.Add([PSCustomObject]@{
              proc     = $item.name
              url      = $v
              winTitle = $cleanTitle
            })
            $found = $true
          }
        } catch {}
      }
    }
  } catch {}
}

if ($out.Count -eq 0) { Write-Output '[]' }
else { $out | ConvertTo-Json -Compress -Depth 2 }
`.trim();

async function getTabsViaUIA(): Promise<BrowserTab[]> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', UIA_SCRIPT],
      { timeout: 25000, encoding: 'utf8' }
    );

    if (stderr?.trim()) {
      console.warn('[TK] browser-collector UIA stderr:', stderr.trim().substring(0, 200));
    }

    const trimmed = stdout.trim();
    if (!trimmed || trimmed === '[]') return [];

    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { return []; }

    const arr = Array.isArray(raw) ? raw : [raw];

    return arr
      .filter((x): x is Record<string, unknown> =>
        !!x && typeof x === 'object' && typeof x['url'] === 'string')
      .map(x => ({
        url:     String(x['url']),
        title:   String(x['winTitle'] || x['url']),
        browser: String(x['proc'] || 'browser'),
      }))
      .filter(t => /^https?:\/\//.test(t.url));
  } catch (e) {
    console.error('[TK] browser-collector UIA error:', e);
    return [];
  }
}

// ── 3. AppleScript fallback (macOS) ──────────────────────────────────────────

async function getTabsViaAppleScript(): Promise<BrowserTab[]> {
  const browsers = [
    { app: 'Google Chrome', proc: 'chrome' },
    { app: 'Microsoft Edge', proc: 'msedge' },
    { app: 'Brave Browser', proc: 'brave' },
  ];

  const tabs: BrowserTab[] = [];

  for (const b of browsers) {
    try {
      const script = `
        if application "${b.app}" is running then
          tell application "${b.app}"
            set tabList to ""
            repeat with w in windows
              repeat with t in tabs of w
                set tabList to tabList & URL of t & "\\t" & title of t & "\\n"
              end repeat
            end repeat
            return tabList
          end tell
        end if
      `;
      const { stdout } = await execFileAsync(
        '/usr/bin/osascript', ['-e', script],
        { timeout: 5000, encoding: 'utf8' }
      );
      const trimmed = stdout.trim();
      if (!trimmed) continue;
      for (const line of trimmed.split('\n')) {
        if (!line) continue;
        const [url, ...rest] = line.split('\t');
        if (url && /^https?:\/\//.test(url)) {
          tabs.push({
            url,
            title: rest.join('\t') || url,
            browser: b.proc,
          });
        }
      }
    } catch { /* browser not installed or not running */ }
  }

  // Also try Safari
  try {
    const safariScript = `
      if application "Safari" is running then
        tell application "Safari"
          set tabList to ""
          repeat with w in windows
            repeat with t in tabs of w
              set tabList to tabList & URL of t & "\\t" & name of t & "\\n"
            end repeat
          end repeat
          return tabList
        end tell
      end if
    `;
    const { stdout } = await execFileAsync(
      '/usr/bin/osascript', ['-e', safariScript],
      { timeout: 5000, encoding: 'utf8' }
    );
    const trimmed = stdout.trim();
    if (trimmed) {
      for (const line of trimmed.split('\n')) {
        if (!line) continue;
        const [url, ...rest] = line.split('\t');
        if (url && /^https?:\/\//.test(url)) {
          tabs.push({
            url,
            title: rest.join('\t') || url,
            browser: 'safari',
          });
        }
      }
    }
  } catch { /* Safari not running */ }

  return tabs;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function collectBrowserTabs(): Promise<BrowserTab[]> {
  // Priority 1: Extension relay — all tabs, all windows, no special flags needed
  const relayTabs = getRelayTabs();
  if (relayTabs.length > 0) {
    const mapped: BrowserTab[] = relayTabs.map(t => ({
      url:     t.url,
      title:   t.title,
      browser: 'chrome', // extension runs in Chromium-based browser
    }));
    console.log(`[TK] Browser tabs captured: ${mapped.length} (via extension relay)`);
    return mapped.slice(0, 30);
  }

  // Priority 2: CDP — all tabs, requires --remote-debugging-port flag
  // Priority 3: UIA — active tab only, always available
  const [cdpTabs, fallbackTabs] = await Promise.all([
    getTabsViaCDP(),
    isMac ? getTabsViaAppleScript() : getTabsViaUIA(),
  ]);

  // CDP wins over UIA (has all tabs); UIA is the last fallback (one tab per window)
  const merged = cdpTabs.length > 0 ? cdpTabs : fallbackTabs;

  // De-duplicate by URL
  const seen = new Set<string>();
  const unique = merged.filter(t => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });

  console.log(
    `[TK] Browser tabs captured: ${unique.length}` +
    ` (CDP: ${cdpTabs.length}, ${isMac ? 'AppleScript' : 'UIA'}: ${fallbackTabs.length})`
  );
  return unique.slice(0, 30);
}

/** @deprecated Use collectBrowserTabs() instead */
export async function collectBrowserUrls(): Promise<string[]> {
  return (await collectBrowserTabs()).map(t => t.url);
}
