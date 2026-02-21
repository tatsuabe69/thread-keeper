import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface WindowInfo {
  name: string;
  title: string;
}

export async function collectWindows(): Promise<WindowInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Set UTF-8 output encoding, then collect windows with titles
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
          'Get-Process | Where-Object MainWindowTitle | Select-Object Name, MainWindowTitle | ConvertTo-Json -Compress',
      ],
      { timeout: 10000, encoding: 'utf8' }
    );

    const trimmed = stdout.trim();
    if (!trimmed) return [];

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return [];
    }

    // PowerShell returns Object (not Array) when there's only 1 result
    const arr = Array.isArray(raw) ? raw : [raw];

    return arr
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        name: String(item['Name'] ?? ''),
        title: String(item['MainWindowTitle'] ?? ''),
      }))
      .filter((w) => w.title.length > 0);
  } catch (e) {
    console.error('[TK] window-collector error:', e);
    return [];
  }
}
