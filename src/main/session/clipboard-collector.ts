import { clipboard } from 'electron';

export function collectClipboard(): string {
  try {
    const text = clipboard.readText();
    return text.substring(0, 500);
  } catch {
    return '';
  }
}
