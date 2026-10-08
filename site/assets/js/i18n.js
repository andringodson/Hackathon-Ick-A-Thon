// Six-language UI: English plus Hindi, Tamil, Malayalam, Kannada and Telugu.
// Dictionaries load on demand; English is always the fallback.

export const LANGS = [
  { code: 'en', native: 'English', locale: 'en-IN', font: null },
  { code: 'hi', native: 'हिन्दी', locale: 'hi-IN', font: 'Noto+Sans+Devanagari' },
  { code: 'ta', native: 'தமிழ்', locale: 'ta-IN', font: 'Noto+Sans+Tamil' },
  { code: 'ml', native: 'മലയാളം', locale: 'ml-IN', font: 'Noto+Sans+Malayalam' },
  { code: 'kn', native: 'ಕನ್ನಡ', locale: 'kn-IN', font: 'Noto+Sans+Kannada' },
  { code: 'te', native: 'తెలుగు', locale: 'te-IN', font: 'Noto+Sans+Telugu' },
];

const BASE = new URL('../i18n/', import.meta.url);
let fallback = {};
let dict = {};
let current = LANGS[0];

async function fetchDict(code) {
  const res = await fetch(new URL(`${code}.json`, BASE));
  if (!res.ok) throw new Error(`i18n ${code}: HTTP ${res.status}`);
  return res.json();
}

function loadFont(lang) {
  if (!lang.font || document.querySelector(`link[data-font="${lang.code}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.dataset.font = lang.code;
  link.href = `https://fonts.googleapis.com/css2?family=${lang.font}:wght@400;500;600;700&display=swap`;
  document.head.append(link);
}

export function detectLang() {
  let saved = null;
  try { saved = localStorage.getItem('rc.lang'); } catch {}
  if (saved && LANGS.some((l) => l.code === saved)) return saved;
  const nav = (navigator.languages || [navigator.language || 'en']).map((l) => l.slice(0, 2));
  return nav.find((c) => LANGS.some((l) => l.code === c)) || 'en';
}

export async function setLang(code) {
  const lang = LANGS.find((l) => l.code === code) || LANGS[0];
  if (!Object.keys(fallback).length) fallback = await fetchDict('en');
  try {
    dict = lang.code === 'en' ? fallback : await fetchDict(lang.code);
    current = lang;
  } catch {
    dict = fallback;
    current = LANGS[0];
  }
  loadFont(current);
  document.documentElement.lang = current.code;
  try { localStorage.setItem('rc.lang', current.code); } catch {}
  return current;
}

export const lang = () => current;

export function t(key, vars) {
  let s = dict[key] ?? fallback[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}

const CAMPUS_TZ = 'Asia/Kolkata';
const fmtCache = new Map();
function fmt(kind, opts) {
  const key = `${current.locale}|${kind}`;
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(current.locale, { timeZone: CAMPUS_TZ, ...opts }));
  return fmtCache.get(key);
}

export const formatTime = (date) => fmt('time', { hour: 'numeric', minute: '2-digit' }).format(date);
export const formatHour = (date) => fmt('hour', { hour: 'numeric' }).format(date);
export const formatDay = (date) => fmt('day', { weekday: 'short' }).format(date);
export const formatDate = (date) => fmt('date', { day: 'numeric', month: 'short' }).format(date);
export const formatDateTime = (date) => fmt('dt', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(date);
export const formatNumber = (n) => new Intl.NumberFormat(current.locale).format(n);

export function relativeMinutes(date, now = new Date()) {
  const mins = Math.round((now - date) / 60000);
  if (mins < 1) return t('time.justNow');
  return t('time.minAgo', { n: formatNumber(mins) });
}
