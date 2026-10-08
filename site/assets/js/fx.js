// Micro-interactions: logo intro + redraw, press ripples, magnetic buttons,
// 3D card tilt, sliding chip pill, report burst, dock bounce, theme reveal.
// Everything decorative backs off under prefers-reduced-motion.

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = () => matchMedia('(hover: hover) and (pointer: fine)').matches;
const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

// ---------- Logo ----------
export function redrawLogo() {
  const logo = document.querySelector('.brand .logo');
  if (!logo) return;
  logo.classList.remove('draw');
  void logo.getBoundingClientRect(); // restart the CSS animation
  logo.classList.add('draw');
}

/** Splash: the logo draws itself, then flies into the top bar. */
export async function endSplash(startedAt) {
  const splash = document.querySelector('[data-splash]');
  if (!splash) return;
  const minShow = reduce() ? 350 : 1150;
  await new Promise((r) => setTimeout(r, Math.max(0, minShow - (performance.now() - startedAt))));
  const brandLogo = document.querySelector('.brand .logo');
  const swap = () => {
    splash.remove();
    if (brandLogo) brandLogo.style.viewTransitionName = 'logo';
    redrawLogo();
  };
  if (document.startViewTransition && !reduce()) {
    const vt = document.startViewTransition(swap);
    await vt.finished.catch(() => {});
    if (brandLogo) brandLogo.style.viewTransitionName = '';
  } else {
    await splash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease', fill: 'forwards' }).finished;
    swap();
  }
}

// ---------- Sliding pill for chip groups ----------
export function moveChipIndicator(group, instant = false) {
  const ind = group?.querySelector('.chip-ind');
  const cur = group?.querySelector('[aria-pressed="true"]');
  if (!ind || !cur) return;
  if (instant) ind.style.transition = 'none';
  ind.style.width = `${cur.offsetWidth}px`;
  ind.style.transform = `translateX(${cur.offsetLeft}px)`;
  if (instant) requestAnimationFrame(() => (ind.style.transition = ''));
}

// ---------- Particle burst (report sent) ----------
export function burst(el) {
  if (!el || reduce()) return;
  const r = el.getBoundingClientRect();
  const color = getComputedStyle(el).getPropertyValue('--lvl').trim() || '#fff';
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('i');
    p.className = 'spark-dot';
    p.style.background = i % 3 ? color : '#fff';
    p.style.left = `${cx}px`;
    p.style.top = `${cy}px`;
    document.body.append(p);
    const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 40 + Math.random() * 46;
    p.animate(
      [
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0.2)`, opacity: 0 },
      ],
      { duration: 620 + Math.random() * 260, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    ).finished.then(() => p.remove());
  }
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 420, easing: SPRING });
}

// ---------- Theme switch: circular reveal from the toggle ----------
export function themeReveal(button, apply) {
  if (!document.startViewTransition || reduce()) {
    apply();
    return;
  }
  const r = button.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.documentElement.classList.add('theme-switching');
  const vt = document.startViewTransition(apply);
  vt.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 650, easing: 'cubic-bezier(0.32, 0.72, 0, 1)', pseudoElement: '::view-transition-new(root)' },
    );
  }).catch(() => {});
  vt.finished.finally(() => document.documentElement.classList.remove('theme-switching'));
  button.querySelectorAll('svg').forEach((svg) => svg.animate([{ transform: 'rotate(-120deg) scale(0.4)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600, easing: SPRING }));
}

// ---------- Global listeners ----------
export function initFx() {
  // Ripple where the finger or cursor lands.
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.btn, .chip, .report-btn, .icon-btn, .tab, .lang-opt, .back');
    if (!el || reduce()) return;
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = s.style.height = `${size}px`;
    s.style.left = `${e.clientX - r.left - size / 2}px`;
    s.style.top = `${e.clientY - r.top - size / 2}px`;
    el.append(s);
    s.addEventListener('animationend', () => s.remove());
  }, { passive: true });

  // Dock icons hop when tapped; the globe spins.
  document.addEventListener('click', (e) => {
    if (reduce()) return;
    const tab = e.target.closest('.tab, .nav-link');
    tab?.querySelector('svg')?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.28) translateY(-3px)' }, { transform: 'scale(1)' }], { duration: 460, easing: SPRING });
    const lang = e.target.closest('[data-action="lang"]');
    lang?.querySelector('svg')?.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: 700, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
  });

  if (!fine()) return;

  // Magnetic buttons drift toward the cursor.
  let magnet = null;
  // 3D tilt on cards.
  let tilted = null;
  document.addEventListener('pointermove', (e) => {
    if (reduce()) return;
    const m = e.target.closest('.btn-primary, .icon-btn, .brand, .btn');
    if (magnet && magnet !== m) magnet.style.translate = '';
    magnet = m;
    if (m) {
      const r = m.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
      const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      m.style.translate = `${dx * 8}px ${dy * 6}px`;
    }
    const c = e.target.closest('.card-link, .hero-live');
    if (tilted && tilted !== c) {
      tilted.style.transform = '';
      tilted.classList.remove('tilting');
    }
    tilted = c;
    if (c) {
      const r = c.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      c.classList.add('tilting');
      c.style.transform = `perspective(900px) rotateX(${(-py * 6).toFixed(2)}deg) rotateY(${(px * 8).toFixed(2)}deg) translateY(-4px)`;
    }
  }, { passive: true });
  document.addEventListener('pointerleave', () => {
    if (magnet) magnet.style.translate = '';
    if (tilted) { tilted.style.transform = ''; tilted.classList.remove('tilting'); }
  });
}
