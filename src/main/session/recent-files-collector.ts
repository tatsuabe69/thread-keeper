import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const RECENT_DIR = path.join(
  os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent'
);

/**
 * Returns the actual target paths of recent files by resolving .lnk shortcuts
 * via PowerShell WScript.Shell.  Falls back to .lnk paths on error (Windows
 * still follows shortcuts when opened with shell.openPath).
 */
export async function collectRecentFiles(): Promise<string[]> {
  try {
    if (!fs.existsSync(RECENT_DIR)) return [];

    // Use PowerShell to resolve each .lnk to its actual target path
    const script =
      '$sh = New-Object -ComObject WScript.Shell; ' +
      '$r = Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Recent" -Filter "*.lnk" | ' +
      '  Sort-Object LastWriteTime -Descending | Select-Object -First 15 | ' +
      '  ForEach-Object { ' +
      '    try { $t = $sh.CreateShortcut($_.FullName).TargetPath; if ($t) { $t } } catch {} ' +
      '  } | Where-Object { $_ -ne $null -and $_ -ne \'\' }; ' +
      'if ($r) { $r | ConvertTo-Json -Compress } else { \'[]\' }';

    const { stdout } = await execFileAsync(
      'powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000 }
    );

    const raw = JSON.parse(stdout.trim() || '[]');
    const resolved = (Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [])
      .filter(Boolean) as string[];
    return resolved.slice(0, 10);

  } catch (e) {
    console.error('[TK] recent-files-collector error:', e);
    // Fallback: return .lnk paths directly (shell.openPath follows shortcuts)
    return collectRecentFilesLnk();
  }
}

/** Fallback: returns the full paths of .lnk files in the Recent folder */
function collectRecentFilesLnk(): string[] {
  try {
    if (!fs.existsSync(RECENT_DIR)) return [];
    return fs
      .readdirSync(RECENT_DIR)
      .filter(f => f.endsWith('.lnk'))
      .map(f => {
        const fullPath = path.join(RECENT_DIR, f);
        let mtime = new Date(0);
        try { mtime = fs.statSync(fullPath).mtime; } catch { /* ignore */ }
        return { lnk: fullPath, mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, 10)
      .map(x => x.lnk);
  } catch {
    return [];
  }
}
