// Small text helpers shared by the server side (notifications, console).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.mjs';

export function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  if (totalMinutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Loads i18n/<lang>.json (falling back to English) and returns t(key, vars). */
export function loadTranslator(lang) {
  const read = code => JSON.parse(readFileSync(join(ROOT, 'i18n', `${code}.json`), 'utf8'));
  const fallback = read('en');
  let strings = fallback;
  let own = fallback; // the language's own strings, for the forms only it has
  if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) && lang !== 'en') {
    try {
      own = read(lang);
      strings = { ...fallback, ...own };
    } catch {
      console.warn(`No i18n/${lang}.json; using English.`);
    }
  }
  // "key.one" is the form for exactly one, in a language that has one ("1 file", not "1 files").
  const pick = (key, vars) => (vars.n === 1 && own[`${key}.one`] != null ? own[`${key}.one`] : strings[key]);
  return (key, vars = {}) => (pick(key, vars) ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
}
