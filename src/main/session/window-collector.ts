import { execFile } from 'child_process';
import { promisify } from 'util';
import { isMac } from '../platform';

const execFileAsync = promisify(execFile);

export interface WindowInfo {
  name: string;
  title: string;
}

async function collectWindowsWin(): Promise<WindowInfo[]> {
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

async function collectWindowsMac(): Promise<WindowInfo[]> {
  try {
    const script = `
      set output to ""
      tell application "System Events"
        set procs to every process whose visible is true
        repeat with p in procs
          set pName to name of p
          try
            set wins to every window of p
            repeat with w in wins
              set wTitle to name of w
              if wTitle is not "" then
                set output to output & pName & "\\t" & wTitle & "\\n"
              end if
            end repeat
          on error
            -- some processes don't allow window access
          end try
        end repeat
      end tell
      return output
    `;

    const { stdout } = await execFileAsync(
      '/usr/bin/osascript', ['-e', script],
      { timeout: 10000, encoding: 'utf8' }
    );

    const trimmed = stdout.trim();
    if (!trimmed) return [];

    return trimmed.split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, ...rest] = line.split('\t');
        return { name: name || '', title: rest.join('\t') || '' };
      })
      .filter(w => w.title.length > 0);
  } catch (e) {
    console.error('[TK] window-collector macOS error:', e);
    return [];
  }
}

export async function collectWindows(): Promise<WindowInfo[]> {
  return isMac ? collectWindowsMac() : collectWindowsWin();
}
