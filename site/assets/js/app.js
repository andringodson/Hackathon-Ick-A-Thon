// Rushcast app shell: routing, views, live updates, alerts, install, i18n.

import { Engine, campusParts, atCampusHour, levelOf } from './engine.js';
import { createStore } from './store.js';
import { startBackground } from './bg.js';
import { forecastChart, sparkline, heatmap, attachTips } from './charts.js';
import { LANGS, detectLang, setLang, lang, t, formatTime, formatDay, formatDate, formatDateTime, formatHour, formatNumber, relativeMinutes } from './i18n.js';
import { icon, esc, toast, openSheet, closeSheet, initSheet, haptic } from './ui.js';
import { initFx, endSplash, redrawLogo, moveChipIndicator, burst, themeReveal } from './fx.js';

const DATA = new URL('../../data/', import.meta.url);
const REPO = 'https://github.com/andringodson/Hackathon-Ick-A-Thon';
const TICK_MS = 5000; // live feel: values glide every few seconds
const CHART_MS = 30000;
const NAV = [
  { id: 'home', href: '#/', icon: 'home' },
  { id: 'live', href: '#/live', icon: 'live' },
  { id: 'map', href: '#/map', icon: 'map' },
  { id: 'insights', href: '#/insights', icon: 'chart' },
  { id: 'about', href: '#/about', icon: 'info' },
];
const CATS = ['all', 'food', 'study', 'services', 'fitness'];

let engine;
let store;
let view = null; // { route, update?, cleanup? }
let deferredInstall = null;
let inAppNav = 0;
let bg = null; // live background api
const ui = { cat: 'all', sort: 'quietest', mapStep: 0, mapSel: null };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const facName = (f) => t(`facname.${f.id}`);
const facShort = (f) => t(`facshort.${f.id}`);
const pctText = (v) => `${Math.round(v)}<small>%</small>`;

/** Count smoothly from the last shown value to the new one. */
function tween(el, to, fmt = pctText, dur = 900) {
  if (to == null) {
    cancelAnimationFrame(el._raf);
    el._v = null;
    el.innerHTML = '—';
    return;
  }
  const from = el._v ?? 0;
  el._v = to;
  cancelAnimationFrame(el._raf);
  if (Math.abs(from - to) < 0.5) {
    el.innerHTML = fmt(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    const e = 1 - (1 - k) ** 3;
    el.innerHTML = fmt(from + (to - from) * e);
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}
const intText = (v) => `${Math.round(v)}`;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- state helpers ----------
function facState(fac, now = new Date()) {
  const est = engine.estimate(fac, now);
  return {
    est,
    cap: est.open ? engine.capacityInfo(fac, est.pct) : null,
    trend: est.open ? engine.trend(fac, now) : 'steady',
    best: engine.bestTime(fac, now, 4),
    change: engine.nextChange(fac, now),
    cast: engine.forecast(fac, now, 3, 15),
  };
}

function capText(cap) {
  if (!cap) return '—';
  if (cap.kind === 'wait') return cap.n ? t('unit.wait', { n: formatNumber(cap.n) }) : t('unit.noWait');
  return t(`unit.${cap.kind}`, { n: formatNumber(cap.n) });
}

function hoursText(change, now = new Date()) {
  if (!change.at) return t('time.closedToday');
  const when = change.sameDay ? formatTime(change.at) : `${formatDay(change.at)} ${formatTime(change.at)}`;
  return change.open ? t('time.closesAt', { time: when }) : t('time.opensAt', { time: when });
}

function bestText(best) {
  if (!best) return '';
  return best.now ? t('best.now') : t('best.at', { time: formatTime(best.t) });
}

function trendHtml(trend) {
  const ic = trend === 'rising' ? 'up' : trend === 'falling' ? 'down' : 'flat';
  return `${icon(ic)}${t(`trend.${trend}`)}`;
}

/** Patch every [data-b] inside a [data-fac] root with fresh values. */
function bindFac(root, fac, st) {
  const lvl = st.est.level;
  const prevLevel = root.dataset.level;
  root.dataset.level = lvl;
  if (prevLevel && prevLevel !== lvl) {
    root.classList.remove('lvl-flash');
    void root.offsetWidth;
    root.classList.add('lvl-flash');
  }
  for (const el of $$('[data-b]', root)) {
    switch (el.dataset.b) {
      case 'pct': tween(el, st.est.open ? st.est.pct : null); break;
      case 'levelLabel': el.textContent = t(`level.${lvl}`); break;
      case 'meter': el.style.setProperty('--v', st.est.open ? (st.est.pct / 100).toFixed(3) : 0); break;
      case 'cap': el.textContent = st.est.open ? capText(st.cap) : hoursText(st.change); break;
      case 'best': el.textContent = st.est.open ? bestText(st.best) : ''; break;
      case 'trend': el.innerHTML = st.est.open ? trendHtml(st.trend) : ''; break;
      case 'hours': el.textContent = hoursText(st.change); break;
      case 'spark': el.innerHTML = st.cast.some((p) => !p.closed) ? sparkline(st.cast) : ''; break;
      default: break;
    }
  }
}

function facCard(fac, i = 0) {
  return `<a class="card card-link fac-card" href="#/f/${fac.id}" data-fac="${fac.id}" style="--i:${i}">
    <div class="fc-top">
      <div class="ring-gauge">
        <svg viewBox="0 0 80 80" aria-hidden="true"><circle class="rg-track" cx="40" cy="40" r="33"/><circle class="rg-val" data-b="meter" cx="40" cy="40" r="33" pathLength="100"/></svg>
        <span class="rg-num" data-b="pct"></span>
      </div>
      <div class="fc-info">
        <span class="fac-name"><strong>${esc(facName(fac))}</strong><span>${esc(fac.where)}</span></span>
        <span class="fc-tags"><span class="pill"><span data-b="levelLabel"></span></span><span class="trend small muted" data-b="trend"></span></span>
      </div>
      ${icon('next', 'card-go')}
    </div>
    <div class="meta">
      <span>${icon('clock')}<span data-b="cap"></span></span>
      <span data-b="best"></span>
    </div>
    <div data-b="spark" aria-label="${t('live.next3h')}"></div>
  </a>`;
}

function bindAllCards(root, now = new Date()) {
  for (const el of $$('[data-fac]', root)) {
    const fac = engine.byId.get(el.dataset.fac);
    if (fac) bindFac(el, fac, facState(fac, now));
  }
}

const footer = () => `<footer class="footer"><span>${t('footer.made')}</span><a href="${REPO}" target="_blank" rel="noopener">${t('footer.source')} ↗</a></footer>`;

// ---------- views ----------
function homeView(root) {
  const now = new Date();
  const states = engine.facilities.map((f) => ({ f, st: facState(f, now) }));
  const open = states.filter((s) => s.st.est.open);
  const pulse = open.length ? open.reduce((a, s) => a + s.st.est.pct, 0) / open.length : 0;
  const bets = open
    .filter((s) => s.st.trend !== 'rising')
    .sort((a, b) => a.st.est.pct - b.st.est.pct)
    .slice(0, 3);
  const alerts = engine.upcomingPeaks(now, 3, 70).slice(0, 4);

  root.innerHTML = `
    <section class="hero stagger">
      <div class="hero-copy" style="--i:0">
        <span class="eyebrow"><span class="dot"></span>${t('home.eyebrow')}</span>
        <h1 class="h1">${t('home.title1')}<br /><span class="gradient-text">${t('home.title2')}</span></h1>
        <p class="lead">${t('home.lead')}</p>
        <div class="btn-row">
          <a class="btn btn-primary" href="#/live">${icon('live')}${t('action.seeLive')}</a>
          <a class="btn" href="#/map">${icon('map')}${t('action.openMap')}</a>
          <button class="btn btn-ghost" type="button" data-action="install" hidden>${icon('download')}${t('action.install')}</button>
        </div>
      </div>
      <div class="card hero-live" style="--i:1">
        <div class="hl-head"><span class="updated" data-clock>${formatTime(now)}</span><span>${t('home.pulse')} <b data-home="pulse2"></b></span></div>
        <ul class="hl-list">
          ${engine.facilities.map((f) => `<li data-fac="${f.id}"><a href="#/f/${f.id}">${icon(f.icon)}<span>${esc(facShort(f))}</span></a><span class="meter"><i data-b="meter"></i></span><span class="hl-pct" data-b="pct"></span></li>`).join('')}
        </ul>
      </div>
      <div class="pulse-strip" style="--i:2">
        <div class="card stat"><div class="label">${icon('users')}${t('home.pulse')}</div><div class="value" data-home="pulse"></div></div>
        <div class="card stat"><div class="label">${icon('clock')}${t('home.open')}</div><div class="value" data-home="open"></div></div>
        <div class="card stat" data-level="quiet"><div class="label"><i class="swatch"></i>${t('home.quietCount')}</div><div class="value" data-home="quiet"></div></div>
        <div class="card stat" data-level="packed"><div class="label"><i class="swatch"></i>${t('home.packedCount')}</div><div class="value" data-home="packed"></div></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><div><h2 class="h2">${t('home.bestBets')}</h2><p>${t('home.bestBetsSub')}</p></div><a class="btn btn-ghost" href="#/live">${t('action.viewAll')}${icon('next')}</a></div>
      <div class="grid-cards stagger">${(bets.length ? bets : open.slice(0, 3)).map((s, i) => facCard(s.f, i)).join('') || `<p class="empty">${t('level.closed')}</p>`}</div>
    </section>

    <section class="section">
      <div class="section-head"><div><h2 class="h2">${t('home.headsUp')}</h2><p>${t('home.headsUpSub')}</p></div></div>
      <div class="alert-list stagger">
        ${alerts.length ? alerts.map((a, i) => `
          <a class="card card-link alert" href="#/f/${a.fac.id}" data-level="${levelOf(a.pct)}" style="--i:${i}">
            <span class="fac-icon">${icon(a.fac.icon)}</span>
            <p><strong>${t('home.alert', { name: esc(facName(a.fac)), pct: Math.round(a.pct), time: formatTime(a.t) })}</strong>
            ${a.goBefore ? ` ${t('home.alertGo', { time: formatTime(a.goBefore) })}` : ''}</p>
            ${icon('next', 'card-go')}
          </a>`).join('') : `<div class="card"><p class="empty">${t('home.noAlerts')}</p></div>`}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2 class="h2">${t('home.how')}</h2></div>
      <div class="steps stagger">
        ${[['wifi', 1], ['spark', 2], ['hand', 3]].map(([ic, n], i) => `
          <div class="card step" style="--i:${i}">
            <span class="fac-icon">${icon(ic)}</span>
            <h3 class="h3"><span class="step-no">0${n}</span> ${t(`home.step${n}`)}</h3>
            <p>${t(`home.step${n}Text`)}</p>
          </div>`).join('')}
      </div>
    </section>
    ${footer()}`;

  const update = () => {
    const n = new Date();
    bindAllCards(root, n);
    const st = engine.facilities.map((f) => engine.estimate(f, n)).filter((e) => e.open);
    const avg = st.length ? st.reduce((a, e) => a + e.pct, 0) / st.length : 0;
    tween($('[data-home="pulse"]', root), avg);
    tween($('[data-home="pulse2"]', root), avg);
    tween($('[data-home="open"]', root), st.length, (v) => `${Math.round(v)}<small>/${engine.facilities.length}</small>`);
    tween($('[data-home="quiet"]', root), st.filter((e) => e.level === 'quiet').length, intText);
    tween($('[data-home="packed"]', root), st.filter((e) => e.level === 'packed').length, intText);
    $('[data-clock]', root).textContent = formatTime(n);
  };
  update();
  return { update };
}

function liveView(root) {
  const render = () => {
    const now = new Date();
    let list = engine.facilities.filter((f) => ui.cat === 'all' || f.category === ui.cat);
    const pct = new Map(list.map((f) => [f.id, engine.estimate(f, now)]));
    const key = (f) => (pct.get(f.id).open ? pct.get(f.id).pct : 999);
    if (ui.sort === 'quietest') list.sort((a, b) => key(a) - key(b));
    if (ui.sort === 'busiest') list.sort((a, b) => (pct.get(b.id).open ? pct.get(b.id).pct : -1) - (pct.get(a.id).open ? pct.get(a.id).pct : -1));
    if (ui.sort === 'name') list.sort((a, b) => facName(a).localeCompare(facName(b), lang().locale));
    $('[data-grid]', root).innerHTML = list.map((f, i) => facCard(f, i)).join('');
    bindAllCards(root, now);
  };

  root.innerHTML = `
    <div class="section-head stagger">
      <div style="--i:0"><h1 class="h2">${t('live.title')}</h1><p>${t('live.sub')}</p></div>
      <span class="updated" style="--i:1" data-updated>${t('time.updated', { time: formatTime(new Date()) })}</span>
    </div>
    <div class="toolbar">
      <div class="chips" role="toolbar" aria-label="${t('cat.all')}" data-chips>
        <span class="chip-ind" aria-hidden="true"></span>
        ${CATS.map((c) => `<button class="chip" type="button" data-cat="${c}" aria-pressed="${ui.cat === c}">${t(`cat.${c}`)}</button>`).join('')}
      </div>
      <label class="sr-only" for="sort">${t('sort.label')}</label>
      <select class="select" id="sort" data-sort>
        ${['quietest', 'busiest', 'name'].map((s) => `<option value="${s}" ${ui.sort === s ? 'selected' : ''}>${t(`sort.${s}`)}</option>`).join('')}
      </select>
    </div>
    <div class="grid-cards stagger" data-grid></div>
    ${footer()}`;
  render();

  root.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cat]');
    if (!chip) return;
    ui.cat = chip.dataset.cat;
    $$('[data-cat]', root).forEach((c) => c.setAttribute('aria-pressed', c === chip));
    moveChipIndicator($('[data-chips]', root));
    render();
  });
  requestAnimationFrame(() => moveChipIndicator($('[data-chips]', root), true));
  document.fonts?.ready.then(() => moveChipIndicator($('[data-chips]', root), true));
  $('[data-sort]', root).addEventListener('change', (e) => {
    ui.sort = e.target.value;
    render();
  });

  return {
    update() {
      bindAllCards(root);
      $('[data-updated]', root).textContent = t('time.updated', { time: formatTime(new Date()) });
    },
  };
}

function campusMapSvg() {
  const spots = engine.facilities.map((f) => {
    const { x, y } = f.map;
    const label = esc(facShort(f));
    const tw = Math.max(60, label.length * 7.4 + 18);
    return `<g class="hotspot" data-fac="${f.id}" transform="translate(${x} ${y})" tabindex="0" role="button" aria-pressed="false" aria-label="${esc(facName(f))}">
      <g class="hs">
        <circle class="halo" r="24"/>
        <circle class="ring" r="21"/>
        <circle class="core" r="16"/>
        <text class="glyph" data-b="mapPct"></text>
        <g class="label"><rect class="tag-bg" x="${-tw / 2}" y="24" width="${tw}" height="22" rx="11"/>
        <text class="tag" y="39" text-anchor="middle">${label}</text></g>
      </g>
    </g>`;
  }).join('');
  const bldg = engine.facilities.map((f) => `<rect class="bldg" x="${f.map.x - 46}" y="${f.map.y - 34}" width="92" height="68" rx="10"/>`).join('');
  const walk = [['admin', 'stationery'], ['stationery', 'canteen'], ['canteen', 'print'], ['print', 'library'], ['library', 'lab'], ['lab', 'mess'], ['lab', 'food-court'], ['food-court', 'gym'], ['canteen', 'food-court'], ['print', 'stationery']]
    .map(([a, b]) => {
      const p = engine.byId.get(a).map;
      const q = engine.byId.get(b).map;
      const mx = (p.x + q.x) / 2 + (q.y - p.y) * 0.12;
      const my = (p.y + q.y) / 2 - (q.x - p.x) * 0.12;
      return `<path class="path" d="M${p.x},${p.y} Q${mx},${my} ${q.x},${q.y}"/>`;
    }).join('');
  return `<svg class="map-svg" viewBox="0 0 1000 600" role="group" aria-label="${t('map.title')}">
    <rect class="ground" x="10" y="10" width="980" height="580" rx="28"/>
    <path class="lawn" d="M60 470 Q160 420 230 500 T420 540 L420 580 L60 580Z"/>
    <ellipse class="lawn" cx="600" cy="120" rx="110" ry="60"/>
    <circle class="lawn" cx="930" cy="330" r="50"/>
    <path class="road" d="M20 330 C 260 300, 420 360, 600 330 S 860 290, 980 320"/>
    <path class="road" d="M520 20 C 540 200, 500 400, 530 590"/>
    ${bldg}${walk}${spots}
  </svg>`;
}

function mapView(root) {
  const now0 = new Date();
  if (!ui.mapSel) {
    const open = engine.facilities.filter((f) => engine.isOpen(f, now0));
    ui.mapSel = (open[0] || engine.facilities[0]).id;
  }
  root.innerHTML = `
    <div class="section-head stagger"><div style="--i:0"><h1 class="h2">${t('map.title')}</h1><p>${t('map.sub')}</p></div></div>
    <div class="map-wrap">
      <div class="card map-card">
        ${campusMapSvg()}
        <div class="scrubber">
          <div class="scrubber-head"><span>${t('map.when')}</span><strong data-when></strong></div>
          <input type="range" min="0" max="12" step="1" value="${ui.mapStep}" data-scrub aria-label="${t('map.when')}" />
          <div class="legend">
            ${['quiet', 'moderate', 'packed', 'closed'].map((l) => `<span data-level="${l}"><i class="key"></i>${t(`level.${l}`)}</span>`).join('')}
          </div>
        </div>
      </div>
      <div class="card" data-panel></div>
    </div>
    ${footer()}`;

  const scrub = $('[data-scrub]', root);
  const panel = $('[data-panel]', root);

  function render() {
    const now = new Date();
    const at = new Date(now.getTime() + ui.mapStep * 15 * 60000);
    $('[data-when]', root).textContent = ui.mapStep === 0 ? t('time.now') : `${t('map.forecastNote')} · ${formatTime(at)} (${t('time.inMin', { n: formatNumber(ui.mapStep * 15) })})`;
    for (const g of $$('.hotspot', root)) {
      const fac = engine.byId.get(g.dataset.fac);
      const st = engine.at(fac, at, now);
      g.dataset.level = st.level;
      g.setAttribute('aria-pressed', String(g.dataset.fac === ui.mapSel));
      g.setAttribute('aria-label', `${facName(fac)}: ${st.open ? `${Math.round(st.pct)}% · ${t(`level.${st.level}`)}` : t('level.closed')}`);
      $('[data-b="mapPct"]', g).textContent = st.open ? Math.round(st.pct) : '–';
    }
    const fac = engine.byId.get(ui.mapSel);
    const st = engine.at(fac, at, now);
    const full = facState(fac, now);
    panel.dataset.level = st.level;
    panel.innerHTML = `
      <div class="card-title"><span class="fac-icon">${icon(fac.icon)}</span><span class="fac-name"><strong>${esc(facName(fac))}</strong><span>${esc(fac.where)}</span></span></div>
      <div class="row" style="display:flex;align-items:end;justify-content:space-between;margin-block:var(--space-s) 0">
        <div class="big-pct">${st.open ? pctText(st.pct) : '—'}</div>
        <span class="pill">${t(`level.${st.level}`)}</span>
      </div>
      <div class="meter"><i style="--v:${st.open ? (st.pct / 100).toFixed(3) : 0}"></i></div>
      <div class="meta" style="margin-block-end:var(--space-s)">
        <span>${icon('clock')}${st.open ? capText(engine.capacityInfo(fac, st.pct)) : hoursText(full.change)}</span>
        ${ui.mapStep === 0 && st.open ? `<span>${bestText(full.best)}</span>` : ''}
      </div>
      ${sparkline(full.cast)}
      <div class="btn-row" style="margin-block-start:var(--space-s)">
        <a class="btn btn-primary" href="#/f/${fac.id}">${t('action.details')}${icon('next')}</a>
        <button class="btn" type="button" data-report="${fac.id}">${icon('hand')}${t('action.report')}</button>
      </div>`;
  }

  function select(id) {
    ui.mapSel = id;
    haptic(6);
    render();
  }
  root.addEventListener('click', (e) => {
    const g = e.target.closest('.hotspot');
    if (g) select(g.dataset.fac);
  });
  root.addEventListener('keydown', (e) => {
    const g = e.target.closest('.hotspot');
    if (g && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      select(g.dataset.fac);
    }
  });
  scrub.addEventListener('input', () => {
    ui.mapStep = Number(scrub.value);
    render();
  });
  render();
  return { update: render };
}

function facilityView(root, id) {
  const fac = engine.byId.get(id);
  if (!fac) {
    root.innerHTML = `<a class="back" href="#/live">${icon('back')}${t('action.back')}</a><div class="card"><p>${t('fac.notFound')}</p></div>`;
    return {};
  }
  const m = engine.model.facilities[fac.id];
  const days = Array.from({ length: 7 }, (_, d) => formatDay(new Date(Date.UTC(2026, 0, 5 + d, 6))));
  const hours = Array.from({ length: 16 }, (_, k) => formatHour(atCampusHour(new Date(), 6 + k)));

  root.innerHTML = `
    <a class="back" href="#/live" data-back>${icon('back')}${t('action.back')}</a>
    <div class="detail-head stagger" data-fac="${fac.id}">
      <span class="fac-icon" style="--i:0">${icon(fac.icon)}</span>
      <div style="--i:1;min-width:0;flex:1 1 14rem"><h1 class="h2">${esc(facName(fac))}</h1><p class="muted">${esc(fac.where)} · <span data-b="hours"></span></p></div>
      <span class="pill" style="--i:2"><span data-b="levelLabel"></span></span>
    </div>

    <div class="grid-kpi stagger" style="margin-block:var(--space-m)" data-fac="${fac.id}">
      <div class="card kpi" style="--i:0"><div class="label">${icon('users')}${t('fac.kpiNow')}</div><div class="value" data-b="pct"></div><div class="sub" data-k="conf"></div><div class="meter"><i data-b="meter"></i></div></div>
      <div class="card kpi" style="--i:1"><div class="label">${icon('clock')}${t(fac.metric === 'seats' ? 'fac.kpiSeats' : 'fac.kpiWait')}</div><div class="value" data-k="capN"></div><div class="sub" data-b="cap"></div></div>
      <div class="card kpi" style="--i:2"><div class="label">${icon('up')}${t('fac.kpiNext')}</div><div class="value" data-k="next"></div><div class="sub trend" data-b="trend"></div></div>
      <div class="card kpi" style="--i:3"><div class="label">${icon('spark')}${t('fac.kpiBest')}</div><div class="value" data-k="bestT"></div><div class="sub" data-k="bestP"></div></div>
    </div>

    <div class="two-col">
      <div class="stack">
        <div class="card">
          <div class="section-head" style="margin-block-end:var(--space-xs)"><div><h2 class="h3">${t('fac.chartTitle')}</h2><p class="small">${t('fac.chartSub')}</p></div></div>
          <div class="legend" style="margin-block-end:var(--space-xs)">
            <span><i class="key line" style="background:var(--series-1)"></i>${t('fac.legendTypical')}</span>
            <span><i class="key band" style="background:var(--series-1);opacity:.25"></i>${t('fac.legendBand')}</span>
            <span><i class="key line" style="background:var(--series-2)"></i>${t('fac.legendLive')}</span>
            <span><i class="key dash" style="color:var(--series-2)"></i>${t('fac.legendCast')}</span>
          </div>
          <div data-chart></div>
        </div>
        <div class="card">
          <div class="section-head" style="margin-block-end:var(--space-s)"><div><h2 class="h3">${t('fac.weekTitle')}</h2><p class="small">${t('fac.weekSub')}</p></div></div>
          <div class="scroll-x"><div style="min-width:30rem" data-heat>${heatmap(engine.weekGrid(fac, 6, 22), days, hours, (r, c, v) => `${days[r]} ${hours[c]} · ${v == null ? t('level.closed') : `${Math.round(v)}%`}`)}</div></div>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <h2 class="h3">${t('fac.reportTitle')}</h2>
          <p class="small muted" style="margin-block-start:.25rem">${t('fac.reportSub')}</p>
          ${reportButtons(fac)}
          <div class="toggle-row">
            <div><strong>${t('fac.notify')}</strong><p class="small muted">${t('fac.notifySub')}</p></div>
            <button class="switch" type="button" role="switch" aria-checked="${watching(fac.id)}" data-watch="${fac.id}" aria-label="${t('fac.notify')}"></button>
          </div>
        </div>
        <div class="card"><h2 class="h3" style="margin-block-end:var(--space-xs)">${t('fac.recent')}</h2><ul class="feed" data-feed></ul></div>
        <div class="card">
          <h2 class="h3" style="margin-block-end:var(--space-xs)">${t('fac.modelTitle')}</h2>
          <div class="meta" style="display:grid;gap:.45rem" data-model></div>
        </div>
      </div>
    </div>
    ${footer()}`;

  attachTips($('[data-heat]', root));

  function render() {
    const now = new Date();
    const st = facState(fac, now);
    for (const el of $$('[data-fac]', root)) bindFac(el, fac, st);
    $('.detail-head', root).dataset.level = st.est.level;
    const k = (name) => $(`[data-k="${name}"]`, root);
    k('conf').textContent = st.est.open ? `${t(`level.${st.est.level}`)} · ${t(`fac.confidence.${st.est.confidence}`)}` : t('level.closed');
    k('capN').innerHTML = st.est.open && st.cap ? (st.cap.kind === 'wait' ? `${st.cap.n}<small style="font-size:.5em;color:var(--muted)"> ${t('unit.min')}</small>` : formatNumber(st.cap.n)) : '—';
    const in1h = st.cast.find((p) => p.t - now >= 60 * 60000);
    if (st.est.open && st.cap && st.cap.kind !== 'wait') $('[data-b="cap"]', root).textContent = `/ ${formatNumber(fac.capacity)} · ${capText(st.cap)}`;
    k('next').innerHTML = in1h && !in1h.closed ? pctText(in1h.pct) : '—';
    k('bestT').textContent = st.best ? (st.best.now ? t('time.now') : formatTime(st.best.t)) : '—';
    k('bestP').textContent = st.best ? `~${Math.round(st.best.pct)}% · ${t(`level.${levelOf(st.best.pct)}`)}` : '';

    const chartEl = $('[data-chart]', root);
    if (!chartEl.classList.contains('hovering') && now - (chartEl._at || 0) >= CHART_MS) {
      chartEl._at = now;
      const curve = engine.dayCurve(fac, now);
      if (curve) forecastChart(chartEl, curve, now);
      else chartEl.innerHTML = `<p class="empty">${hoursText(st.change)}</p>`;
    }

    const feed = engine.reportsFor(fac.id).filter((r) => now - r.at < 45 * 60000).slice(0, 8);
    $('[data-feed]', root).innerHTML = feed.length
      ? feed.map((r) => {
        const lv = ['quiet', 'moderate', 'packed'][r.level];
        return `<li data-level="${lv}"><span class="pill">${t(['fac.reportEmpty', 'fac.reportModerate', 'fac.reportCrowded'][r.level])}</span><span class="muted small">${r.mine ? t('report.you') : t('report.by')}</span><time datetime="${r.at.toISOString()}">${relativeMinutes(r.at, now)}</time></li>`;
      }).join('')
      : `<li class="empty">${t('fac.noReports')}</li>`;

    const ev = engine.event(now);
    const effect = ev ? m.effects?.[ev.type] : null;
    $('[data-model]', root).innerHTML = `
      <span>${icon('chart')}${t('fac.modelError', { n: m.metrics.mae })} · ${t('insights.vsNaive', { n: m.metrics.improvement })}</span>
      <span>${icon('wifi')}${st.est.reports ? t('fac.sources', { n: st.est.reports }) : t('fac.sourcesNone')}</span>
      ${ev && effect ? `<span>${icon('calendar')}${t('fac.calendarEffect', { label: t(`event.${ev.type}`), n: Math.round(effect * 100) })}</span>` : ''}
      <span>${icon('clock')}${t('about.trained', { time: formatDateTime(new Date(engine.model.generated_at)) })}</span>`;
  }

  root.addEventListener('click', async (e) => {
    const back = e.target.closest('[data-back]');
    if (back && inAppNav > 0) {
      e.preventDefault();
      history.back();
    }
    const sw = e.target.closest('[data-watch]');
    if (sw) toggleWatch(fac, sw);
  });
  render();
  return { update: render };
}

function insightsView(root) {
  const render = () => {
    const now = new Date();
    const m = engine.model.metrics;
    const states = engine.facilities.map((f) => ({ f, est: engine.estimate(f, now) }));
    const open = states.filter((s) => s.est.open);
    const pulse = open.length ? open.reduce((a, s) => a + s.est.pct, 0) / open.length : 0;
    const reportsHour = engine.facilities.reduce((a, f) => a + engine.reportsFor(f.id).filter((r) => now - r.at < 3600000).length, 0);

    const rows = engine.facilities.map((f) => {
      const win = engine.dayWindow(f, now);
      let peak = null;
      let quiet = null;
      if (win) {
        for (let h = win[0]; h < win[1]; h += 0.25) {
          const d = atCampusHour(now, h);
          if (!engine.isOpen(f, d)) continue;
          const v = engine.typical(f, d).mean;
          if (!peak || v > peak.v) peak = { d, v };
          if (d >= now && (!quiet || v < quiet.v)) quiet = { d, v };
        }
      }
      const est = engine.estimate(f, now);
      return `<tr data-level="${est.level}">
        <td><a href="#/f/${f.id}">${esc(facName(f))}</a></td>
        <td class="num"><span class="pill">${est.open ? `${Math.round(est.pct)}%` : t('level.closed')}</span></td>
        <td class="num">${peak ? `${formatTime(peak.d)} · ${Math.round(peak.v)}%` : '—'}</td>
        <td class="num">${quiet ? `${formatTime(quiet.d)} · ${Math.round(quiet.v)}%` : '—'}</td>
        <td class="num">${engine.model.facilities[f.id].metrics.mae} pts</td>
      </tr>`;
    }).join('');

    const hours = Array.from({ length: 16 }, (_, k) => 6 + k);
    const grid = engine.facilities.map((f) => hours.map((h) => {
      const d = atCampusHour(now, h + 0.5);
      return engine.isOpen(f, d) ? engine.typical(f, d).mean : null;
    }));
    const hourLabels = hours.map((h) => formatHour(atCampusHour(now, h)));
    const ev = engine.event(now);
    const today = campusParts(now).dateKey;

    root.innerHTML = `
      <div class="section-head stagger"><div style="--i:0"><h1 class="h2">${t('insights.title')}</h1><p>${t('insights.sub')}</p></div></div>
      <div class="grid-kpi stagger">
        <div class="card kpi" style="--i:0"><div class="label">${icon('users')}${t('home.pulse')}</div><div class="value">${pctText(pulse)}</div><div class="sub">${t('home.open')}: ${open.length}/${engine.facilities.length}</div></div>
        <div class="card kpi" style="--i:1"><div class="label">${icon('hand')}${t('insights.reportsHour')}</div><div class="value">${formatNumber(reportsHour)}</div><div class="sub">${t(store.mode === 'live' ? 'mode.live' : 'mode.demo')}</div></div>
        <div class="card kpi" style="--i:2"><div class="label">${icon('chart')}${t('insights.accuracy')}</div><div class="value">${m.mae}<small style="font-size:.5em;color:var(--muted)"> pts</small></div><div class="sub">${t('insights.vsNaive', { n: m.improvement })}</div></div>
        <div class="card kpi" style="--i:3"><div class="label">${icon('shield')}${t('insights.coverage')}</div><div class="value">${m.coverage}<small style="font-size:.5em;color:var(--muted)">%</small></div><div class="sub">p10–p90</div></div>
      </div>
      <section class="section">
        <div class="table-wrap"><table>
          <thead><tr><th>${t('insights.facility')}</th><th>${t('insights.now')}</th><th>${t('insights.peakToday')}</th><th>${t('insights.quietest')}</th><th>${t('insights.accuracy')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </section>
      <section class="section">
        <div class="section-head"><div><h2 class="h2">${t('insights.heatTitle')}</h2><p>${t('insights.heatSub')}</p></div></div>
        <div class="card"><div class="scroll-x"><div style="min-width:36rem" data-heat>
          ${heatmap(grid, engine.facilities.map((f) => esc(facShort(f))), hourLabels, (r, c, v) => `${esc(facShort(engine.facilities[r]))} ${hourLabels[c]} · ${v == null ? t('level.closed') : `${Math.round(v)}%`}`)}
        </div></div></div>
      </section>
      <section class="section">
        <div class="section-head"><div><h2 class="h2">${t('insights.calendar')}</h2><p>${t('insights.calendarSub')}</p></div></div>
        <div class="alert-list">
          ${engine.catalog.calendar.filter((e) => e.to >= today).map((e) => `
            <div class="card alert">
              <span class="fac-icon">${icon('calendar')}</span>
              <p><strong>${t(`event.${e.type}`)}</strong> · ${formatDate(new Date(`${e.from}T12:00:00+05:30`))}${e.to !== e.from ? ` – ${formatDate(new Date(`${e.to}T12:00:00+05:30`))}` : ''}</p>
              ${ev && ev.from === e.from ? `<span class="pill" data-level="moderate" style="margin-inline-start:auto">${t('insights.activeEvent')}</span>` : ''}
            </div>`).join('')}
        </div>
      </section>
      ${footer()}`;
    $$('[data-heat]', root).forEach(attachTips);
  };
  render();
  return {};
}

function aboutView(root) {
  const m = engine.model.metrics;
  root.innerHTML = `
    <div class="section-head stagger"><div style="--i:0"><span class="eyebrow">${t('about.team')}</span><h1 class="h1" style="font-size:clamp(2rem,1.4rem+3vw,3.4rem);margin-block-start:.5rem">${t('about.title')}</h1></div></div>
    <div class="arch stagger">
      <div class="card" style="--i:0"><h2 class="h3">${icon('x')}${t('about.problem')}</h2><p class="muted">${t('about.problemText')}</p></div>
      <div class="card" style="--i:1"><h2 class="h3">${icon('check')}${t('about.fix')}</h2><p class="muted">${t('about.fixText')}</p></div>
    </div>
    <section class="section">
      <div class="section-head"><h2 class="h2">${t('about.arch')}</h2></div>
      <div class="arch">
        <div class="card"><h3 class="h3">${icon('wifi')}${t('about.data')}</h3><p class="muted small">${t('about.dataText')}</p></div>
        <div class="card"><h3 class="h3">${icon('spark')}${t('about.processing')}</h3><p class="muted small">${t('about.processingText')}</p></div>
        <div class="card"><h3 class="h3">${icon('screen')}${t('about.presentation')}</h3><p class="muted small">${t('about.presentationText')}</p></div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><div><h2 class="h2">${t('about.accuracy')}</h2><p>${t('about.trained', { time: formatDateTime(new Date(engine.model.generated_at)) })} · ${esc(engine.model.method)}</p></div></div>
      <div class="metric-row">
        <div class="card kpi"><div class="label">${t('about.mae')}</div><div class="value">${m.mae} pts</div></div>
        <div class="card kpi"><div class="label">${t('about.naive')}</div><div class="value">${m.naive_mae} pts</div></div>
        <div class="card kpi"><div class="label">${t('about.improvement')}</div><div class="value">${m.improvement}%</div></div>
        <div class="card kpi"><div class="label">${t('about.coverage')}</div><div class="value">${m.coverage}%</div></div>
      </div>
    </section>
    <section class="section">
      <div class="arch">
        <div class="card"><h2 class="h3">${icon('shield')}${t('about.privacy')}</h2><p class="muted small">${t('about.privacyText')}</p></div>
        <div class="card"><h2 class="h3">${icon('wifi')}${t('about.dataMode')} · ${t(store.mode === 'live' ? 'mode.live' : 'mode.demo')}</h2><p class="muted small">${t(store.mode === 'live' ? 'about.liveText' : 'about.demoText')}</p></div>
      </div>
    </section>
    <section class="section">
      <div class="section-head"><h2 class="h2">${t('about.stack')}</h2></div>
      <div class="tag-list">${['Python · NumPy', 'JavaScript (ES modules)', 'Node.js', 'PostgreSQL · Supabase', 'Realtime', 'SQL · PL/pgSQL', 'GitHub Actions', 'GitHub Pages', 'PWA · Service Worker', 'SVG · Canvas', 'Intl · 6 languages'].map((s) => `<span>${s}</span>`).join('')}</div>
    </section>
    <section class="section">
      <div class="card"><h2 class="h3">${t('about.team')}</h2><p class="muted" style="margin-block-start:.35rem">${t('about.teamText')}</p></div>
    </section>
    ${footer()}`;
  return {};
}

// ---------- reporting ----------
function reportButtons(fac) {
  return `<div class="report-grid" data-report-for="${fac.id}">
    ${[['quiet', 'fac.reportEmpty', 0], ['moderate', 'fac.reportModerate', 1], ['packed', 'fac.reportCrowded', 2]].map(([lv, key, n]) => `
      <button class="report-btn" type="button" data-level="${lv}" data-send="${n}"><span class="lvl-dot"></span>${t(key)}</button>`).join('')}
  </div>`;
}

async function sendReport(facId, level, btn) {
  haptic(10);
  btn?.setAttribute('aria-pressed', 'true');
  try {
    await store.submit(facId, level);
    burst(btn);
    toast(t('report.thanks'));
    if ($('[data-sheet]').open) closeSheet();
  } catch (err) {
    toast(t(err.code === 'rate_limited' ? 'report.limited' : 'report.failed'), { type: 'error' });
  } finally {
    setTimeout(() => btn?.setAttribute('aria-pressed', 'false'), 900);
  }
}

function openReportSheet(facId) {
  const fac = engine.byId.get(facId);
  openSheet(`<h2 id="sheet-title">${t('report.sheetTitle', { name: esc(facName(fac)) })}</h2><p>${t('fac.reportSub')}</p>${reportButtons(fac)}`);
}

// ---------- quiet alerts ----------
function watchList() {
  try { return JSON.parse(localStorage.getItem('rc.watch') || '[]'); } catch { return []; }
}
function saveWatch(list) {
  try { localStorage.setItem('rc.watch', JSON.stringify(list)); } catch {}
}
const watching = (id) => watchList().includes(id);

async function toggleWatch(fac, sw) {
  const list = watchList();
  if (list.includes(fac.id)) {
    saveWatch(list.filter((x) => x !== fac.id));
    sw.setAttribute('aria-checked', 'false');
    toast(t('notify.off'), { type: 'bell' });
    return;
  }
  saveWatch([...list, fac.id]);
  sw.setAttribute('aria-checked', 'true');
  haptic(8);
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  toast(t(('Notification' in window && Notification.permission === 'denied') ? 'notify.denied' : 'notify.on', { name: facName(fac) }), { type: 'bell' });
}

async function checkWatches() {
  const list = watchList();
  if (!list.length) return;
  const now = new Date();
  const remaining = [];
  for (const id of list) {
    const fac = engine.byId.get(id);
    const est = fac && engine.estimate(fac, now);
    if (!est || !est.open || est.level !== 'quiet') {
      if (fac) remaining.push(id);
      continue;
    }
    const msg = t('notify.fired', { name: facName(fac), pct: Math.round(est.pct) });
    let shown = false;
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) {
          await reg.showNotification('Rushcast', { body: msg, icon: 'assets/icons/icon-192.png', badge: 'assets/icons/badge-96.png', tag: `quiet-${id}`, data: { url: `#/f/${id}` } });
          shown = true;
        }
      } catch {}
    }
    if (!shown || !document.hidden) toast(msg, { type: 'bell', duration: 6000 });
  }
  saveWatch(remaining);
  $$('[data-watch]').forEach((sw) => sw.setAttribute('aria-checked', String(remaining.includes(sw.dataset.watch))));
}

// ---------- shell ----------
let navLang = null;
function moveIndicator(container, instant = false) {
  const ind = $('.nav-ind, .tab-ind', container);
  const cur = $('[aria-current="page"]', container);
  if (!ind || !cur) return;
  if (instant) ind.style.transition = 'none';
  ind.style.width = `${cur.offsetWidth}px`;
  ind.style.transform = `translateX(${cur.offsetLeft}px)`;
  if (instant) requestAnimationFrame(() => (ind.style.transition = ''));
}
function renderNav(route) {
  const currentId = route === 'facility' ? 'live' : route;
  const fresh = navLang !== lang().code;
  if (fresh) {
    navLang = lang().code;
    $('[data-nav]').innerHTML = `<span class="nav-ind" aria-hidden="true"></span>${NAV.map((n) => `<a class="nav-link" href="${n.href}" data-id="${n.id}">${icon(n.icon)}<span>${t(`nav.${n.id}`)}</span></a>`).join('')}`;
    $('[data-tabbar]').innerHTML = `<span class="tab-ind" aria-hidden="true"></span>${NAV.map((n) => `<a class="tab" href="${n.href}" data-id="${n.id}">${icon(n.icon)}<span>${t(`nav.${n.id}`)}</span></a>`).join('')}`;
  }
  for (const a of $$('[data-nav] [data-id], [data-tabbar] [data-id]')) {
    if (a.dataset.id === currentId) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  moveIndicator($('[data-nav]'), fresh);
  moveIndicator($('[data-tabbar]'), fresh);
  $('[data-lang-code]').textContent = lang().code.toUpperCase();
  const chip = $('[data-mode-chip]');
  chip.hidden = false;
  chip.dataset.mode = store.mode;
  chip.textContent = t(store.mode === 'live' ? 'mode.live' : 'mode.demo');
}

const syncInstall = () => $$('[data-action="install"]').forEach((b) => (b.hidden = !canInstall()));

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [first, second] = hash.split('/');
  if (first === 'f' && second) return { route: 'facility', id: decodeURIComponent(second) };
  if (['live', 'map', 'insights', 'about'].includes(first)) return { route: first };
  return { route: 'home' };
}

function render(initial = false) {
  const { route, id } = parseRoute();
  const root = $('#view');
  const swap = () => {
    view?.cleanup?.();
    const fresh = root.cloneNode(false); // drop old listeners
    root.replaceWith(fresh);
    document.body.dataset.route = route;
    bg?.setRoute(route);
    if (!initial) redrawLogo();
    renderNav(route);
    const views = { home: homeView, live: liveView, map: mapView, insights: insightsView, about: aboutView, facility: (el) => facilityView(el, id) };
    view = { route, ...(views[route](fresh) || {}) };
    syncInstall();
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (!initial) fresh.focus({ preventScroll: true });
    revealOnScroll(fresh);
    if (!initial && !document.startViewTransition) {
      fresh.animate(
        reduceMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(28px)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'none' }],
        { duration: 520, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      );
    }
    document.title = `${route === 'facility' && engine.byId.get(id) ? facName(engine.byId.get(id)) : t(`nav.${route === 'facility' ? 'live' : route}`)} · Rushcast`;
  };
  if (!initial && document.startViewTransition) document.startViewTransition(swap);
  else swap();
}

let revealer = null;
function revealOnScroll(root) {
  revealer?.disconnect();
  if (!('IntersectionObserver' in window)) return;
  revealer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        revealer.unobserve(e.target);
      }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  for (const el of $$('.section, .footer', root)) {
    el.classList.add('reveal');
    revealer.observe(el);
  }
}

function pushEnergy() {
  const now = new Date();
  const open = engine.facilities.map((f) => engine.estimate(f, now)).filter((e) => e.open);
  bg?.setEnergy(open.length ? open.reduce((a, e) => a + e.pct, 0) / open.length / 100 : 0.15);
}

function tick() {
  if (document.hidden) return;
  pushEnergy();
  view?.update?.();
  checkWatches();
}

// ---------- theme, language, install ----------
function effectiveTheme() {
  const th = document.documentElement.dataset.theme;
  if (th === 'dark' || th === 'light') return th;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (document.documentElement.dataset.theme !== 'auto') $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));
}
function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  const apply = () => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('rc.theme', next); } catch {}
    applyThemeColor();
    view?.update?.();
  };
  themeReveal($('[data-action="theme"]'), apply);
}

function openLangSheet() {
  openSheet(`<h2 id="sheet-title">${t('action.language')}</h2>
    <div class="lang-list" role="radiogroup">
      ${LANGS.map((l) => `<button class="lang-opt" type="button" role="radio" aria-checked="${l.code === lang().code}" data-lang="${l.code}" lang="${l.code}">
        <span>${l.native} <small>${l.code.toUpperCase()}</small></span>${l.code === lang().code ? icon('check') : ''}</button>`).join('')}
    </div>`);
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canInstall = () => !isStandalone() && (!!deferredInstall || isIos());

async function install() {
  if (deferredInstall) {
    deferredInstall.prompt();
    const { outcome } = await deferredInstall.userChoice;
    deferredInstall = null;
    if (outcome === 'accepted') toast(t('install.done'));
    $$('[data-action="install"]').forEach((b) => (b.hidden = true));
  } else if (isIos()) {
    openSheet(`<h2 id="sheet-title">${t('install.title')}</h2><p>${t('install.ios')}</p><button class="btn btn-primary" type="button" data-close style="width:100%">${t('action.close')}</button>`);
  }
}

function bindGlobal() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (a?.dataset.action === 'theme') toggleTheme();
    if (a?.dataset.action === 'lang') openLangSheet();
    if (a?.dataset.action === 'install') install();
    const rep = e.target.closest('[data-report]');
    if (rep) openReportSheet(rep.dataset.report);
    const send = e.target.closest('[data-send]');
    if (send) sendReport(send.closest('[data-report-for]').dataset.reportFor, Number(send.dataset.send), send);
    const lg = e.target.closest('[data-lang]');
    if (lg) {
      setLang(lg.dataset.lang).then(() => {
        closeSheet();
        render();
      });
    }
  });
  window.addEventListener('hashchange', () => {
    inAppNav++;
    render();
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    $$('[data-action="install"]').forEach((b) => (b.hidden = false));
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    $$('[data-action="install"]').forEach((b) => (b.hidden = true));
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.addEventListener('pointermove', (e) => {
      const card = e.target.closest?.('.card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    }, { passive: true });
  }
  window.addEventListener('online', () => tick());
  window.addEventListener('offline', () => toast(t('offline'), { type: 'error', duration: 5000 }));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => view?.update?.());
  const realign = () => { moveIndicator($('[data-nav]'), true); moveIndicator($('[data-tabbar]'), true); };
  window.addEventListener('resize', realign);
  document.fonts?.ready.then(realign);
}

async function boot() {
  const bootStart = performance.now();
  bg = startBackground($('#flow'));
  initFx();
  initSheet();
  try {
    const [, eng] = await Promise.all([setLang(detectLang()), Engine.load(DATA)]);
    engine = eng;
    store = await createStore(engine);
  } catch (err) {
    console.error(err);
    $('#view').innerHTML = `<div class="card"><p>${t('error.load')}</p></div>`;
    endSplash(bootStart);
    return;
  }
  applyThemeColor();
  bindGlobal();
  store.onChange(() => view?.update?.());
  render(true);
  endSplash(bootStart);
  pushEnergy();
  setInterval(tick, TICK_MS);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { scope: new URL('../../', import.meta.url).pathname }).catch(() => {});
  }
}

boot();
