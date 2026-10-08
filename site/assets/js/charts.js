// Hand-built SVG charts: forecast with band + crosshair tooltip, sparklines, heatmaps.

import { formatHour, formatTime, t } from './i18n.js';

const NS = 'http://www.w3.org/2000/svg';
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

export function isDark() {
  const theme = document.documentElement.dataset.theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return !matchMedia('(prefers-color-scheme: light)').matches;
}

export function rampColor(pct) {
  const ramp = isDark() ? RAMP.slice(2, 12).reverse() : RAMP;
  const x = Math.max(0, Math.min(1, pct / 100)) * (ramp.length - 1);
  const i = Math.floor(x);
  const j = Math.min(ramp.length - 1, i + 1);
  const mix = (a, b, f) => Math.round(a + (b - a) * f);
  const [r1, g1, b1] = [1, 3, 5].map((k) => parseInt(ramp[i].slice(k, k + 2), 16));
  const [r2, g2, b2] = [1, 3, 5].map((k) => parseInt(ramp[j].slice(k, k + 2), 16));
  const f = x - i;
  return `rgb(${mix(r1, r2, f)} ${mix(g1, g2, f)} ${mix(b1, b2, f)})`;
}

/** Split points into runs where pred(point) holds, so closed hours leave gaps. */
function runs(points, pred) {
  const out = [];
  let cur = [];
  for (const p of points) {
    if (pred(p)) cur.push(p);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

const pathOf = (pts, x, y) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p).toFixed(1)},${y(p).toFixed(1)}`).join('');

export function forecastChart(container, curve, now = new Date()) {
  const W = 720;
  const H = 280;
  const m = { l: 36, r: 14, t: 16, b: 28 };
  const x0 = curve.start.getTime();
  const x1 = curve.end.getTime();
  const sx = (d) => m.l + ((d.getTime() - x0) / (x1 - x0)) * (W - m.l - m.r);
  const sy = (v) => m.t + (1 - v / 100) * (H - m.t - m.b);

  let g = '';
  for (const v of [0, 25, 50, 75, 100]) {
    g += `<line class="${v === 0 ? 'axis' : 'gridline'}" x1="${m.l}" x2="${W - m.r}" y1="${sy(v)}" y2="${sy(v)}"/>`;
    g += `<text class="tick" x="${m.l - 8}" y="${sy(v) + 4}" text-anchor="end">${v}%</text>`;
  }
  g += `<line class="threshold" x1="${m.l}" x2="${W - m.r}" y1="${sy(40)}" y2="${sy(40)}"/>`;
  const firstHour = new Date(Math.ceil(x0 / 3600000) * 3600000);
  const span = (x1 - x0) / 3600000;
  const every = span > 10 ? 3 : 2;
  for (let tt = firstHour.getTime(); tt <= x1; tt += 3600000) {
    const d = new Date(tt);
    const hourIst = Math.round(((tt / 3600000) + 5.5) % 24);
    if (hourIst % every) continue;
    g += `<text class="tick" x="${sx(d)}" y="${H - 8}" text-anchor="middle">${formatHour(d)}</text>`;
  }

  const open = runs(curve.typical, (p) => p.open);
  let band = '';
  let typ = '';
  for (const r of open) {
    const top = pathOf(r, (p) => sx(p.t), (p) => sy(p.hi));
    const bottom = r.slice().reverse().map((p) => `L${sx(p.t).toFixed(1)},${sy(p.lo).toFixed(1)}`).join('');
    band += `<path class="band" d="${top}${bottom}Z"/>`;
    typ += `<path class="line-typ" d="${pathOf(r, (p) => sx(p.t), (p) => sy(p.mean))}"/>`;
  }
  let live = '';
  for (const r of runs(curve.live, (p) => p.open)) live += `<path class="line-live" d="${pathOf(r, (p) => sx(p.t), (p) => sy(p.pct))}"/>`;
  let cast = '';
  for (const r of runs(curve.cast, (p) => !p.closed)) if (r.length > 1) cast += `<path class="line-cast" d="${pathOf(r, (p) => sx(p.t), (p) => sy(p.pct))}"/>`;

  let nowMarks = '';
  if (now >= curve.start && now <= curve.end) {
    const nx = sx(now);
    const c0 = curve.cast[0];
    nowMarks = `<line class="now-rule" x1="${nx}" x2="${nx}" y1="${m.t}" y2="${H - m.b}"/>
      <text class="now-label" x="${nx + 6}" y="${m.t + 10}">${t('time.now')}</text>
      ${c0 && !c0.closed ? `<circle class="now-dot" cx="${nx}" cy="${sy(c0.pct)}" r="5"/>` : ''}`;
  }

  container.classList.add('chart');
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('fac.chartTitle')}">
      ${g}${band}${typ}${live}${cast}${nowMarks}
      <line class="cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}"/>
      <circle class="hover-dot" r="4.5" style="fill:var(--series-1)" data-dot="typ"/>
      <circle class="hover-dot" r="4.5" style="fill:var(--series-2)" data-dot="live"/>
      <rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>
    </svg>
    <div class="tooltip" role="status"></div>`;

  const svg = container.querySelector('svg');
  const tip = container.querySelector('.tooltip');
  const cross = svg.querySelector('.cross');
  const dotTyp = svg.querySelector('[data-dot="typ"]');
  const dotLive = svg.querySelector('[data-dot="live"]');
  const byTime = (arr, tt) => arr.reduce((a, b) => (Math.abs(b.t - tt) < Math.abs(a.t - tt) ? b : a), arr[0]);

  function show(evt) {
    const rect = svg.getBoundingClientRect();
    const vx = ((evt.clientX - rect.left) / rect.width) * W;
    const tt = x0 + ((vx - m.l) / (W - m.l - m.r)) * (x1 - x0);
    const p = byTime(curve.typical, tt);
    const liveSrc = tt <= now.getTime() ? curve.live : curve.cast.filter((c) => !c.closed);
    const lp = liveSrc.length ? byTime(liveSrc, tt) : null;
    const px = sx(p.t);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    dotTyp.setAttribute('cx', px);
    dotTyp.setAttribute('cy', sy(p.mean));
    const liveOk = lp && Math.abs(lp.t - p.t) < 16 * 60000 && (lp.open ?? !lp.closed);
    dotLive.style.display = liveOk ? '' : 'none';
    if (liveOk) {
      dotLive.setAttribute('cx', sx(lp.t));
      dotLive.setAttribute('cy', sy(lp.pct));
    }
    container.classList.add('hovering');
    const liveLabel = tt <= now.getTime() ? t('fac.legendLive') : t('fac.legendCast');
    tip.innerHTML = `<strong>${formatTime(p.t)}</strong>
      ${p.open ? `<div class="tt-row"><i class="sw" style="background:var(--series-1)"></i>${t('fac.legendTypical')}<b>${Math.round(p.mean)}%</b></div>
      <div class="tt-row"><i class="sw" style="background:var(--series-1);opacity:.35;height:8px"></i>p10–p90<b>${Math.round(p.lo)}–${Math.round(p.hi)}%</b></div>` : `<div class="tt-row">${t('level.closed')}</div>`}
      ${liveOk ? `<div class="tt-row"><i class="sw" style="background:var(--series-2)"></i>${liveLabel}<b>${Math.round(lp.pct)}%</b></div>` : ''}`;
    const cw = container.clientWidth;
    const left = (px / W) * rect.width;
    const tipW = tip.offsetWidth || 160;
    const tx = left + 14 + tipW > cw ? left - tipW - 14 : left + 14;
    tip.style.setProperty('--tx', `${Math.max(0, tx)}px`);
    tip.style.setProperty('--ty', '8px');
    tip.classList.add('show');
  }
  function hide() {
    container.classList.remove('hovering');
    tip.classList.remove('show');
  }
  const hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointercancel', hide);
}

/** Tiny next-hours sparkline. Returns SVG markup. */
export function sparkline(points) {
  const W = 200;
  const H = 44;
  if (!points.length) return '';
  const t0 = points[0].t.getTime();
  const t1 = points.at(-1).t.getTime() || t0 + 1;
  const sx = (p) => ((p.t.getTime() - t0) / Math.max(1, t1 - t0)) * W;
  const sy = (v) => 4 + (1 - v / 100) * (H - 8);
  let d = '';
  let area = '';
  for (const r of runs(points, (p) => !p.closed)) {
    const line = pathOf(r, sx, (p) => sy(p.pct));
    d += line;
    area += `${line}L${sx(r.at(-1)).toFixed(1)},${H}L${sx(r[0]).toFixed(1)},${H}Z`;
  }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" style="fill:var(--series-1);opacity:.12;stroke:none"/>
    <path d="${d}" style="stroke:var(--series-1);stroke-width:2;fill:none" vector-effect="non-scaling-stroke"/>
    <line x1="0" x2="${W}" y1="${sy(40)}" y2="${sy(40)}" style="stroke:var(--muted);stroke-dasharray:2 4;opacity:.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/** Heatmap grid: rows x cols of % or null (closed). */
export function heatmap(rows, rowLabels, colLabels, describe) {
  const cols = colLabels.length;
  let html = `<div class="heat" style="--cols:${cols}" role="table">`;
  html += `<div class="heat-row heat-hours" role="row"><span></span>${colLabels.map((c, i) => `<span role="columnheader">${i % 2 ? '' : c}</span>`).join('')}</div>`;
  rows.forEach((row, r) => {
    html += `<div class="heat-row" role="row"><span role="rowheader">${rowLabels[r]}</span>`;
    row.forEach((v, c) => {
      const label = describe(r, c, v);
      html += v == null
        ? `<span class="heat-cell closed" role="cell" tabindex="0" data-tip="${label}" aria-label="${label}"></span>`
        : `<span class="heat-cell" role="cell" tabindex="0" style="--cell:${rampColor(v)}" data-tip="${label}" aria-label="${label}"></span>`;
    });
    html += '</div>';
  });
  return `${html}</div><div class="heat-scale"><span>0%</span><i></i><span>100%</span></div>`;
}

/** Shared hover/focus tooltip for any [data-tip] inside container. */
export function attachTips(container) {
  container.style.position = 'relative';
  const tip = document.createElement('div');
  tip.className = 'tooltip';
  container.append(tip);
  const show = (el) => {
    tip.innerHTML = `<strong>${el.dataset.tip}</strong>`;
    const c = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const tipW = tip.offsetWidth || 150;
    let x = r.left - c.left + r.width / 2 - tipW / 2;
    x = Math.max(0, Math.min(c.width - tipW, x));
    tip.style.setProperty('--tx', `${x}px`);
    tip.style.setProperty('--ty', `${r.top - c.top - 44}px`);
    tip.classList.add('show');
  };
  const hide = () => tip.classList.remove('show');
  container.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  container.addEventListener('pointerout', (e) => { if (e.target.closest('[data-tip]')) hide(); });
  container.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  container.addEventListener('focusout', hide);
}
