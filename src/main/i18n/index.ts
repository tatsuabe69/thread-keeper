/**
 * i18n/index.ts
 *
 * Translation loader for the main process.
 * JSON files live in src/main/i18n/ and are packaged via electron-builder.
 * At runtime, __dirname = <appRoot>/dist/main/i18n/,
 * so we resolve 3 levels up then into src/main/i18n/.
 *
 * Supported languages: ja, en, it, de, fr, zh
 */

import * as fs from 'fs';
import * as path from 'path';

export type SupportedLang = 'ja' | 'en' | 'it' | 'de' | 'fr' | 'zh';

export const SUPPORTED_LANGUAGES: { code: SupportedLang; label: string }[] = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'zh', label: '中文' },
];

// Cache loaded translations to avoid repeated file reads
const translationCache: Map<string, Record<string, unknown>> = new Map();

/**
 * Resolve the directory containing JSON translation files.
 * __dirname at runtime = <appRoot>/dist/main/i18n/
 * JSON files at         = <appRoot>/src/main/i18n/*.json
 */
function getI18nDir(): string {
  return path.join(__dirname, '..', '..', '..', 'src', 'main', 'i18n');
}

/**
 * Load translations for the given language code.
 * Falls back to 'ja' if the requested language file is not found.
 */
export function loadTranslations(lang: string): Record<string, unknown> {
  // Validate lang to prevent path traversal
  const safeLang = /^[a-z]{2}$/.test(lang) ? lang : 'ja';

  if (translationCache.has(safeLang)) {
    return translationCache.get(safeLang)!;
  }

  const i18nDir = getI18nDir();
  const filePath = path.join(i18nDir, `${safeLang}.json`);
  const fallbackPath = path.join(i18nDir, 'ja.json');

  let translations: Record<string, unknown>;
  try {
    if (fs.existsSync(filePath)) {
      translations = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else {
      // Fallback to Japanese
      console.warn(`[TK] Translation file not found: ${safeLang}.json — falling back to ja`);
      translations = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    }
  } catch (err) {
    console.warn('[TK] Failed to load translations:', (err as Error).message);
    translations = {};
  }

  translationCache.set(safeLang, translations);
  return translations;
}

/**
 * Clear the translation cache (useful when language setting changes).
 */
export function clearTranslationCache(): void {
  translationCache.clear();
}

/**
 * Get a single translation string from a loaded translations object.
 * Supports parameter substitution: t(translations, 'key', { n: 5 }) → replaces {n} with 5
 */
export function t(
  translations: Record<string, unknown>,
  key: string,
  params?: Record<string, string | number>,
): string {
  let val = translations[key];
  if (val === undefined || val === null) return key; // return key as-is if not found

  if (typeof val !== 'string') return String(val);

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = (val as string).replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }

  return val as string;
}

/**
 * Returns the list of available language files by scanning the i18n directory.
 */
export function getAvailableLanguages(): { code: string; label: string }[] {
  const i18nDir = getI18nDir();
  return SUPPORTED_LANGUAGES.filter(lang => {
    const filePath = path.join(i18nDir, `${lang.code}.json`);
    return fs.existsSync(filePath);
  });
}
