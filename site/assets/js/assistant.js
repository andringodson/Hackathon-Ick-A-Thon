// Rush AI — built-in campus assistant.
// Tier 1 (always on, offline, free): an on-device intent engine that answers from
// the live crowd engine — status, best time, hours, forecasts, recommendations,
// comparisons, break planning, rush alerts — and can act (report, alert, navigate).
// Tier 2 (progressive): Chrome's built-in model (Prompt API / Gemini Nano) for
// open-ended questions, grounded with a live snapshot. Tier 3 (optional):
// CONFIG.aiEndpoint, e.g. the Supabase Edge Function in supabase/functions/ask.

import { CONFIG } from './config.js';
import { atCampusHour, levelOf } from './engine.js';

const FAC_ALIASES = {
  canteen: ['canteen', 'cafeteria', 'cafe', 'main canteen'],
  mess: ['mess', 'hostel mess', 'dining hall', 'dining'],
  'food-court': ['food court', 'foodcourt', 'juice bar', 'juice'],
  library: ['library', 'lib', 'central library'],
  lab: ['computer lab', 'comp lab', 'lab', 'computers'],
  print: ['print shop', 'printing', 'print', 'xerox', 'photocopy', 'photo copy'],
  stationery: ['stationery', 'stationary', 'pens', 'notebook'],
  admin: ['admin office', 'admin', 'fee office', 'fees', 'fee', 'accounts office'],
  gym: ['gym', 'fitness centre', 'fitness center', 'workout'],
};
const CAT_WORDS = {
  food: ['eat', 'food', 'hungry', 'lunch', 'breakfast', 'dinner', 'snack', 'meal', 'coffee', 'tea', 'chai', 'khana', 'saapadu', 'sapadu', 'oota', 'bhojan'],
  study: ['study', 'studying', 'read', 'seat', 'seats', 'revise', 'revision', 'padhai', 'padippu'],
  services: ['print', 'xerox', 'photocopy', 'stationery', 'fee', 'fees', 'office', 'document'],
  fitness: ['gym', 'workout', 'exercise', 'fitness', 'train'],
};
const LEVEL_WORDS = [
  [0, ['empty', 'quiet', 'free', 'no one', 'nobody', 'dead']],
  [1, ['moderate', 'okay', 'ok', 'medium', 'some people', 'average']],
  [2, ['crowded', 'packed', 'full', 'busy', 'rush', 'jam', 'long queue', 'queue']],
];
const PAGES = { map: '#/map', insights: '#/insights', live: '#/live', home: '#/', about: '#/about' };

const asciiRe = (w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
const has = (text, words) => words.some((w) => (/^[\x00-\x7f]+$/.test(w) ? asciiRe(w).test(text) : text.includes(w)));

export function createAssistant(ctx) {
  const { engine, t } = ctx;

  // ---------- understanding ----------
  function aliasesFor(id) {
    const local = [t(`facname.${id}`), t(`facshort.${id}`)].map((s) => s.toLowerCase());
    return [...new Set([...(FAC_ALIASES[id] || []), ...local])].sort((a, b) => b.length - a.length);
  }
  function findFacilities(text) {
    const found = [];
    for (const f of engine.facilities) {
      let best = -1;
      for (const a of aliasesFor(f.id)) {
        const re = /^[\x00-\x7f]+$/.test(a) ? asciiRe(a) : null;
        const idx = re ? text.search(re) : text.indexOf(a);
        if (idx >= 0 && (best < 0 || idx < best)) best = idx;
      }
      if (best >= 0) found.push({ id: f.id, at: best });
    }
    // "lab" is part of "library"-style phrases: drop overlaps where a longer alias matched.
    return found.sort((a, b) => a.at - b.at).map((x) => engine.byId.get(x.id));
  }
  function findCategory(text) {
    for (const [cat, words] of Object.entries(CAT_WORDS)) if (has(text, words)) return cat;
    return null;
  }
  function findLevel(text) {
    for (const [lvl, words] of LEVEL_WORDS.slice().reverse()) if (has(text, words)) return lvl;
    return null;
  }
  function parseWhen(text, now) {
    let m = text.match(/\bin\s+(\d+)\s*(min|mins|minutes|m|hour|hours|hr|hrs|h)\b/);
    if (m) return new Date(now.getTime() + Number(m[1]) * (m[2].startsWith('h') ? 60 : 1) * 60000);
    m = text.match(/\b(?:at|around|by|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/) || text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/) || text.match(/\b(\d{1,2})[:.](\d{2})\b/);
    let day = has(text, ['tomorrow', 'tmrw', 'kal', 'naale', 'nalai', 'repu']) ? 1 : 0;
    let hour = null;
    if (m) {
      hour = Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0);
      if (m[3] === 'pm' && hour < 12) hour += 12;
      if (m[3] === 'am' && hour >= 12) hour -= 12;
      if (!m[3] && hour < 7) hour += 12; // "at 2" on a campus means 2 pm
    } else if (has(text, ['breakfast'])) hour = 8.5;
    else if (has(text, ['lunch'])) hour = 13;
    else if (has(text, ['evening'])) hour = 17.5;
    else if (has(text, ['dinner', 'tonight'])) hour = 20;
    else if (has(text, ['morning'])) hour = 9.5;
    if (hour == null) return day ? new Date(now.getTime() + 86400000) : null;
    return atCampusHour(new Date(now.getTime() + day * 86400000), hour);
  }
  function parseDuration(text) {
    const m = text.match(/(\d+)\s*(min|mins|minutes|m\b|hour|hours|hr|hrs|h\b)/);
    if (m) return Number(m[1]) * (m[2].startsWith('h') ? 60 : 1);
    if (has(text, ['an hour', 'one hour'])) return 60;
    if (has(text, ['half an hour', 'half hour'])) return 30;
    return null;
  }

  // ---------- facts ----------
  const lvlLabel = (l) => t(`level.${l}`).toLowerCase();
  function card(fac, at) {
    return { id: fac.id, at };
  }
  function statusOf(fac, now) {
    const est = engine.estimate(fac, now);
    if (!est.open) return { text: t('ai.closed', { name: ctx.facName(fac), hours: ctx.hoursText(engine.nextChange(fac, now)) }) };
    const cap = ctx.capText(engine.capacityInfo(fac, est.pct));
    const trend = t(`ai.trend.${engine.trend(fac, now)}`);
    return { text: `${t('ai.status', { name: ctx.facName(fac), level: lvlLabel(est.level), pct: Math.round(est.pct), cap })} ${trend}` };
  }
  function bestOf(fac, now) {
    const b = engine.bestTime(fac, now, 6);
    if (!b) return { text: t('ai.closed', { name: ctx.facName(fac), hours: ctx.hoursText(engine.nextChange(fac, now)) }) };
    if (b.now) return { text: t('ai.bestNow', { name: ctx.facName(fac), pct: Math.round(b.pct) }) };
    return { text: t('ai.best', { name: ctx.facName(fac), time: ctx.formatTime(b.t), pct: Math.round(b.pct), level: lvlLabel(levelOf(b.pct)) }) };
  }
  function atTime(fac, when, now) {
    if (!engine.isOpen(fac, when)) return { text: t('ai.atClosed', { name: ctx.facName(fac), time: ctx.formatTime(when) }) };
    const typ = engine.typical(fac, when).mean;
    const st = when - now < 3 * 3600000 && when > now ? engine.at(fac, when, now) : { pct: typ, level: levelOf(typ) };
    return { text: t('ai.at', { time: ctx.formatTime(when), name: ctx.facName(fac), pct: Math.round(st.pct), level: lvlLabel(st.level) }) };
  }
  function recommend(cat, now) {
    const list = engine.facilities
      .filter((f) => (!cat || cat === 'all' || f.category === cat))
      .map((f) => ({ f, est: engine.estimate(f, now) }))
      .filter((x) => x.est.open)
      .sort((a, b) => a.est.pct - b.est.pct)
      .slice(0, 3);
    if (!list.length) {
      const next = engine.facilities
        .filter((f) => !cat || cat === 'all' || f.category === cat)
        .map((f) => ({ f, ch: engine.nextChange(f, now) }))
        .filter((x) => x.ch.at)
        .sort((a, b) => a.ch.at - b.ch.at)[0];
      return { text: t('ai.recommendNone', { next: next ? `${ctx.facName(next.f)}: ${ctx.hoursText(next.ch)}.` : '' }) };
    }
    return { text: t('ai.recommend', { category: t(`ai.cat.${cat || 'all'}`) }), cards: list.map((x) => card(x.f)) };
  }
  function plan(mins, from, cat) {
    const ranked = engine.facilities
      .filter((f) => !cat || f.category === cat)
      .map((f) => {
        const pts = engine.forecast(f, from, Math.max(0.5, mins / 60), 15);
        const open = pts.filter((p) => !p.closed);
        if (open.length < pts.length / 2) return null;
        return { f, avg: open.reduce((a, p) => a + p.pct, 0) / open.length };
      })
      .filter(Boolean)
      .sort((a, b) => a.avg - b.avg)
      .slice(0, 4);
    if (!ranked.length) return { text: t('free.none') };
    return { text: t('ai.plan', { mins, time: ctx.formatTime(from) }), cards: ranked.map((x) => card(x.f)) };
  }
  function peaks(now) {
    const list = engine.upcomingPeaks(now, 3, 65).slice(0, 4);
    if (!list.length) return { text: t('ai.noPeaks') };
    return {
      text: `${t('ai.peaks')}\n${list.map((p) => `• ${t('home.alert', { name: ctx.facName(p.fac), pct: Math.round(p.pct), time: ctx.formatTime(p.t) })}${p.goBefore ? ` ${t('home.alertGo', { time: ctx.formatTime(p.goBefore) })}` : ''}`).join('\n')}`,
      cards: list.map((p) => card(p.fac)),
    };
  }

  /** Main entry: returns { text, cards?, actions?, needsLLM? } */
  async function answer(raw) {
    const text = ` ${raw.toLowerCase().trim()} `;
    const now = new Date();
    const facs = findFacilities(text);
    const fac = facs[0];
    const cat = findCategory(text);
    const when = parseWhen(text, now);

    if (!raw.trim()) return { text: t('ai.greet') };
    if (/^\s*(hi|hii+|hello|hey|hai|namaste|namaskar|vanakkam|hola|yo)\b/.test(text) && raw.length < 25) return { text: t('ai.greet') };
    if (has(text, ['thanks', 'thank you', 'thx', 'dhanyavad', 'nandri', 'nanni', 'dhanyavadagalu'])) return { text: t('ai.thanks') };

    const nav = text.match(/\b(open|show|go to|take me to)\s+(the\s+)?(map|insights|live|home|about)\b/);
    if (nav) {
      ctx.navigate(PAGES[nav[3]]);
      return { text: t('ai.nav', { page: t(`nav.${nav[3]}`) }) };
    }
    if (fac && has(text, ['report', 'mark', 'it is', "it's", 'its'])) {
      const lvl = findLevel(text);
      if (lvl != null) {
        try {
          await ctx.report(fac.id, lvl);
          return { text: t('ai.reportDone', { name: ctx.facName(fac), level: t(['fac.reportEmpty', 'fac.reportModerate', 'fac.reportCrowded'][lvl]).toLowerCase() }), cards: [card(fac)] };
        } catch (err) {
          return { text: t(err.code === 'rate_limited' ? 'report.limited' : 'report.failed') };
        }
      }
    }
    if (fac && has(text, ['alert', 'notify', 'tell me when', 'ping', 'remind', 'let me know'])) {
      ctx.watch(fac.id);
      return { text: t('ai.notifyDone', { name: ctx.facName(fac) }), cards: [card(fac)] };
    }
    if (has(text, ['accurate', 'accuracy', 'model', 'how does this work', 'how does it work', 'reliable', 'trust', 'error'])) {
      const m = engine.model.metrics;
      return { text: t('ai.model', { mae: m.mae, imp: m.improvement }), actions: [{ label: t('nav.about'), hash: '#/about' }] };
    }
    if (!fac && has(text, ['rush', 'peak', 'busiest', 'what is busy', "what's busy", 'whats busy', 'crowded today', 'busy today'])) return peaks(now);
    const mins = parseDuration(text);
    if (mins && has(text, ['free', 'break', 'have', 'got', 'spare', 'gap', 'between classes'])) return plan(Math.min(mins, 240), when && when > now ? when : now, cat);
    if (facs.length >= 2 && has(text, ['or', 'vs', 'versus', 'compare', 'better', 'which', 'aur', 'illa', 'athava'])) {
      const [a, b] = facs;
      const ea = engine.estimate(a, now);
      const eb = engine.estimate(b, now);
      const pa = ea.open ? ea.pct : 101;
      const pb = eb.open ? eb.pct : 101;
      if (!ea.open && !eb.open) return { text: `${statusOf(a, now).text} ${statusOf(b, now).text}`, cards: [card(a), card(b)] };
      if (!ea.open || !eb.open) {
        const openOne = ea.open ? a : b;
        return { text: `${statusOf(ea.open ? b : a, now).text} ${statusOf(openOne, now).text}`, cards: [card(openOne)] };
      }
      return {
        text: t('ai.compare', { a: ctx.facName(a), b: ctx.facName(b), pa: ea.open ? Math.round(pa) : '—', pb: eb.open ? Math.round(pb) : '—', winner: ctx.facName(pa <= pb ? a : b) }),
        cards: [card(a), card(b)],
      };
    }
    if (fac && has(text, ['open', 'close', 'closing', 'opening', 'timing', 'timings', 'hours', 'when does'])) {
      const ch = engine.nextChange(fac, now);
      return { text: ch.open ? t('ai.hoursOpen', { name: ctx.facName(fac), hours: ctx.hoursText(ch) }) : t('ai.closed', { name: ctx.facName(fac), hours: ctx.hoursText(ch) }), cards: [card(fac)] };
    }
    if (fac && has(text, ['best time', 'when should', 'when to', 'good time', 'least crowded', 'avoid', 'when is it quiet', 'when will it be quiet'])) return { ...bestOf(fac, now), cards: [card(fac)] };
    if (fac && when) return { ...atTime(fac, when, now), cards: [card(fac, when)] };
    if (fac) return { ...statusOf(fac, now), cards: [card(fac)], actions: [{ label: t('action.details'), hash: `#/f/${fac.id}` }] };
    if (cat || has(text, ['quiet', 'empty', 'free', 'where', 'seat', 'less crowded', 'not crowded', 'chill'])) {
      if (mins) return plan(Math.min(mins, 240), now, cat);
      return recommend(cat || 'all', now);
    }
    return { text: t('ai.fallback'), needsLLM: true };
  }

  // ---------- optional generative tiers ----------
  function snapshot() {
    const now = new Date();
    return engine.facilities.map((f) => {
      const est = engine.estimate(f, now);
      const ch = engine.nextChange(f, now);
      if (!est.open) return `${f.name}: closed; ${ch.at ? `opens ${ctx.formatTime(ch.at)}` : 'closed today'}`;
      const b = engine.bestTime(f, now, 4);
      return `${f.name}: ${Math.round(est.pct)}% full (${est.level}), ${ctx.capText(engine.capacityInfo(f, est.pct))}, trend ${engine.trend(f, now)}, best time ${b ? (b.now ? 'now' : ctx.formatTime(b.t)) : 'n/a'}, closes ${ch.at ? ctx.formatTime(ch.at) : 'n/a'}`;
    }).join('\n');
  }
  const SYSTEM = (langName) => `You are Rush, the assistant inside Rushcast, a campus crowd predictor for an Indian engineering college. Answer in ${langName}, in at most 3 short sentences, using ONLY the live data provided. If the data does not answer the question, say so briefly and suggest asking about a specific place or time. Never invent places or numbers.`;

  let nano = null;
  let nanoState = 'unknown';
  async function nanoAvailable() {
    if (nanoState !== 'unknown') return nanoState === 'available';
    try {
      const LM = globalThis.LanguageModel;
      nanoState = LM ? await LM.availability() : 'unavailable';
    } catch {
      nanoState = 'unavailable';
    }
    return nanoState === 'available';
  }
  async function askNano(question) {
    if (!nano) nano = await globalThis.LanguageModel.create({ initialPrompts: [{ role: 'system', content: SYSTEM(ctx.lang().native) }] });
    return nano.prompt(`Live campus data (${ctx.formatTime(new Date())}):\n${snapshot()}\n\nQuestion: ${question}`);
  }
  async function askCloud(question) {
    const res = await fetch(CONFIG.aiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(CONFIG.supabaseAnonKey ? { apikey: CONFIG.supabaseAnonKey, Authorization: `Bearer ${CONFIG.supabaseAnonKey}` } : {}) },
      body: JSON.stringify({ question, lang: ctx.lang().native, context: snapshot() }),
    });
    if (!res.ok) throw new Error(`AI endpoint ${res.status}`);
    return (await res.json()).answer;
  }
  async function engineLabel() {
    if (CONFIG.aiEndpoint) return 'cloud';
    return (await nanoAvailable()) ? 'nano' : 'local';
  }
  async function generative(question) {
    if (CONFIG.aiEndpoint) return askCloud(question);
    if (await nanoAvailable()) return askNano(question);
    return null;
  }

  return { answer, generative, engineLabel, snapshot };
}

// ============================ UI ============================

export function mountAssistant(ctx) {
  const { t, icon, esc } = ctx;
  const ai = createAssistant(ctx);
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let speak = false;
  try { speak = localStorage.getItem('rc.ai.speak') === '1'; } catch {}

  const fab = document.createElement('button');
  fab.className = 'ai-fab';
  fab.type = 'button';
  fab.setAttribute('aria-haspopup', 'dialog');
  fab.innerHTML = `${icon('spark')}<span class="ai-fab-label"></span>`;
  const panel = document.createElement('section');
  panel.className = 'ai-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.hidden = true;
  document.body.append(fab, panel);

  let history = [];
  try { history = JSON.parse(localStorage.getItem('rc.ai.history') || '[]').slice(-20); } catch {}
  const save = () => { try { localStorage.setItem('rc.ai.history', JSON.stringify(history.slice(-20))); } catch {} };

  function frame() {
    fab.setAttribute('aria-label', t('ai.open'));
    fab.querySelector('.ai-fab-label').textContent = t('ai.title');
    fab.title = t('kbd.hint');
    panel.setAttribute('aria-label', t('ai.title'));
    panel.innerHTML = `
      <header class="ai-head">
        <span class="ai-avatar">${icon('spark')}</span>
        <div class="ai-head-text"><strong>${t('ai.title')}</strong><span class="ai-engine" data-engine>${t('ai.engineLocal')}</span></div>
        <button class="icon-btn ai-call" type="button" data-ai="call" aria-label="${t('voice.call')}" title="${t('voice.call')}">${icon('phone')}</button>
        <button class="icon-btn" type="button" data-ai="speak" aria-pressed="${speak}" aria-label="${t('ai.speak')}" title="${t('ai.speak')}">${icon('volume')}</button>
        <button class="icon-btn" type="button" data-ai="clear" aria-label="${t('ai.clear')}" title="${t('ai.clear')}">${icon('trash')}</button>
        <button class="icon-btn" type="button" data-ai="close" aria-label="${t('action.close')}">${icon('x')}</button>
      </header>
      <div class="ai-log" data-log aria-live="polite"></div>
      <div class="ai-suggest" data-suggest>${[1, 2, 3, 4, 5, 6].map((n) => `<button class="chip" type="button" data-q="${esc(t(`ai.s${n}`))}">${esc(t(`ai.s${n}`))}</button>`).join('')}</div>
      <form class="ai-input" data-form>
        <input type="text" name="q" autocomplete="off" enterkeyhint="send" placeholder="${esc(t('ai.placeholder'))}" aria-label="${esc(t('ai.placeholder'))}" />
        <button class="icon-btn" type="button" data-ai="mic" aria-label="${t('ai.voice')}" title="${t('ai.voice')}">${icon('mic')}</button>
        <button class="icon-btn ai-send" type="submit" aria-label="${t('ai.send')}">${icon('send')}</button>
      </form>
      <p class="ai-foot">${t('ai.privacy')}</p>`;
    renderLog();
    ai.engineLabel().then((e) => {
      const el = panel.querySelector('[data-engine]');
      if (el) {
        el.textContent = t(e === 'cloud' ? 'ai.engineCloud' : e === 'nano' ? 'ai.engineNano' : 'ai.engineLocal');
        el.dataset.kind = e;
      }
    });
  }

  function formatText(s) {
    return esc(s).replace(/\n/g, '<br>');
  }
  function cardsHtml(cards = []) {
    if (!cards.length) return '';
    const now = new Date();
    return `<div class="ai-cards">${cards.map((c) => {
      const fac = ctx.engine.byId.get(c.id);
      const at = c.at ? new Date(c.at) : now;
      const st = c.at ? ctx.engine.at(fac, at, now) : ctx.engine.estimate(fac, now);
      return `<a class="ai-card" href="#/f/${fac.id}" data-level="${st.level}">
        <span class="fac-icon">${icon(fac.icon)}</span>
        <span class="ai-card-name"><strong>${esc(ctx.facName(fac))}</strong><span>${st.open ? ctx.capText(ctx.engine.capacityInfo(fac, st.pct)) : ctx.hoursText(ctx.engine.nextChange(fac, now))}</span></span>
        <span class="ai-card-pct">${st.open ? `${Math.round(st.pct)}%` : '—'}</span>
        <span class="pill">${t(`level.${st.level}`)}</span>
      </a>`;
    }).join('')}</div>`;
  }
  function actionsHtml(actions = []) {
    if (!actions.length) return '';
    return `<div class="ai-actions">${actions.map((a) => `<a class="btn btn-ghost" href="${a.hash}">${esc(a.label)}${icon('next')}</a>`).join('')}</div>`;
  }
  function bubble(m) {
    return m.role === 'user'
      ? `<div class="ai-msg user"><p>${formatText(m.text)}</p></div>`
      : `<div class="ai-msg bot"><span class="ai-avatar sm">${icon('spark')}</span><div class="ai-bot-body"><p data-text>${formatText(m.text)}</p>${cardsHtml(m.cards)}${actionsHtml(m.actions)}</div></div>`;
  }
  function renderLog() {
    const log = panel.querySelector('[data-log]');
    if (!log) return;
    log.innerHTML = (history.length ? history : [{ role: 'bot', text: t('ai.greet') }]).map(bubble).join('');
    log.scrollTop = log.scrollHeight;
  }

  async function typeInto(el, text) {
    if (reduce() || text.length > 400) {
      el.innerHTML = formatText(text);
      return;
    }
    const step = Math.max(1, Math.round(text.length / 45));
    for (let i = 0; i <= text.length; i += step) {
      el.innerHTML = formatText(text.slice(0, i)) + '<span class="ai-caret"></span>';
      await new Promise((r) => setTimeout(r, 14));
    }
    el.innerHTML = formatText(text);
  }

  function say(text) {
    if (!speak) return;
    if (ctx.speak) { ctx.speak(text); return; } // natural neural voice
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/•/g, ''));
    u.lang = ctx.lang().locale;
    speechSynthesis.speak(u);
  }

  let busy = false;
  async function ask(q) {
    if (busy || !q.trim()) return;
    busy = true;
    history.push({ role: 'user', text: q.trim() });
    const log = panel.querySelector('[data-log]');
    log.insertAdjacentHTML('beforeend', bubble(history.at(-1)) + `<div class="ai-msg bot pending"><span class="ai-avatar sm">${icon('spark')}</span><div class="ai-bot-body"><p class="ai-dots"><i></i><i></i><i></i></p></div></div>`);
    log.scrollTop = log.scrollHeight;
    let res;
    try {
      res = await ai.answer(q);
      if (res.needsLLM) {
        const gen = await ai.generative(q).catch(() => null);
        if (gen) res = { text: String(gen).trim() };
      }
    } catch (err) {
      console.warn(err);
      res = { text: t('ai.fallback') };
    }
    await new Promise((r) => setTimeout(r, reduce() ? 0 : 280));
    const msg = { role: 'bot', text: res.text, cards: res.cards?.map((c) => ({ ...c, at: c.at ? c.at.getTime() : undefined })), actions: res.actions };
    history.push(msg);
    save();
    log.querySelector('.pending')?.remove();
    log.insertAdjacentHTML('beforeend', bubble({ ...msg, text: '' }));
    const last = log.lastElementChild;
    const cardsEl = last.querySelectorAll('.ai-cards, .ai-actions');
    cardsEl.forEach((c) => (c.style.opacity = 0));
    await typeInto(last.querySelector('[data-text]'), msg.text);
    cardsEl.forEach((c) => { c.style.opacity = ''; c.classList.add('ai-pop'); });
    log.scrollTop = log.scrollHeight;
    say(msg.text);
    busy = false;
  }

  // ---------- open / close ----------
  function open() {
    if (!panel.hidden) return;
    frame();
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => panel.classList.add('open'));
    setTimeout(() => panel.querySelector('input')?.focus({ preventScroll: true }), 120);
  }
  function close() {
    if (panel.hidden) return;
    panel.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
    setTimeout(() => (panel.hidden = true), 260);
    try { speechSynthesis.cancel(); } catch {}
    fab.focus({ preventScroll: true });
  }

  fab.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = panel.querySelector('input');
    const q = input.value;
    input.value = '';
    ask(q);
  });
  panel.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-q]');
    if (chip) ask(chip.dataset.q);
    const btn = e.target.closest('[data-ai]');
    if (!btn) return;
    const act = btn.dataset.ai;
    if (act === 'close') close();
    if (act === 'clear') { history = []; save(); renderLog(); }
    if (act === 'speak') {
      speak = !speak;
      btn.setAttribute('aria-pressed', String(speak));
      try { localStorage.setItem('rc.ai.speak', speak ? '1' : '0'); } catch {}
      if (!speak) try { speechSynthesis.cancel(); } catch {}
    }
    if (act === 'mic') listen(btn);
    if (act === 'call') { close(); ctx.onCall?.(); }
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('.ai-card, .ai-actions a') && matchMedia('(width < 52rem)').matches) close();
  });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); open(); }
    if (e.key === 'Escape' && !panel.hidden) close();
  });

  let rec = null;
  function listen(btn) {
    if (!SpeechRec) { ctx.toast(t('ai.voiceUnsupported'), { type: 'error' }); return; }
    if (rec) { rec.stop(); return; }
    rec = new SpeechRec();
    rec.lang = ctx.lang().locale;
    rec.interimResults = true;
    const input = panel.querySelector('input');
    const prevPh = input.placeholder;
    input.placeholder = t('ai.listening');
    btn.classList.add('listening');
    rec.onresult = (ev) => {
      const r = ev.results[ev.results.length - 1];
      input.value = r[0].transcript;
      if (r.isFinal) { const q = input.value; input.value = ''; ask(q); }
    };
    rec.onend = () => { rec = null; btn.classList.remove('listening'); input.placeholder = prevPh; };
    rec.onerror = () => rec?.stop();
    rec.start();
  }

  return {
    open,
    close,
    ask: (q) => { open(); ask(q); },
    /** Plain answer for the voice agent (falls through to generative tiers). */
    answer: async (q) => {
      const res = await ai.answer(q);
      if (!res.needsLLM) return res;
      const gen = await ai.generative(q).catch(() => null);
      return gen ? { text: String(gen).trim() } : res;
    },
    relabel: () => { fab.querySelector('.ai-fab-label').textContent = t('ai.title'); if (!panel.hidden) frame(); },
  };
}
