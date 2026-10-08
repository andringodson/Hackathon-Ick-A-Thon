// Small UI kit: icons, escaping, toasts, and a bottom sheet with drag-to-dismiss.

export const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms); } catch {}
}

// ---------- Toasts ----------
const toastRegion = () => document.querySelector('.toasts');
export function toast(message, { type = 'ok', duration = 3600 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(type === 'error' ? 'x' : type === 'bell' ? 'bell' : 'check')}<span>${esc(message)}</span>`;
  toastRegion().append(el);
  let remaining = duration;
  let started = Date.now();
  let timer = setTimeout(dismiss, remaining);
  // Pause the timer while the tab is hidden, so toasts aren't missed.
  const onVis = () => {
    if (document.hidden) {
      clearTimeout(timer);
      remaining -= Date.now() - started;
    } else {
      started = Date.now();
      timer = setTimeout(dismiss, Math.max(800, remaining));
    }
  };
  document.addEventListener('visibilitychange', onVis);
  el.addEventListener('click', dismiss);
  function dismiss() {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVis);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }
  return dismiss;
}

// ---------- Sheet ----------
const sheet = () => document.querySelector('[data-sheet]');
let onCloseCb = null;

export function openSheet(html, { onClose } = {}) {
  const dlg = sheet();
  dlg.querySelector('[data-sheet-body]').innerHTML = html;
  dlg.classList.remove('closing');
  dlg.style.transform = '';
  onCloseCb = onClose || null;
  if (!dlg.open) dlg.showModal();
  return dlg;
}

export function closeSheet() {
  const dlg = sheet();
  if (!dlg.open || dlg.classList.contains('closing')) return;
  dlg.classList.add('closing');
  dlg.style.transform = '';
  setTimeout(() => {
    dlg.close();
    dlg.classList.remove('closing');
    onCloseCb?.();
    onCloseCb = null;
  }, 220);
}

export function initSheet() {
  const dlg = sheet();
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    closeSheet();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeSheet(); // backdrop click
    if (e.target.closest('[data-close]')) closeSheet();
  });

  // Drag to dismiss: velocity or distance, damped when dragging upward.
  const handle = dlg.querySelector('[data-sheet-handle]');
  let startY = 0;
  let startT = 0;
  let dy = 0;
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    dragging = true;
    startY = e.clientY;
    startT = performance.now();
    dy = 0;
    handle.setPointerCapture(e.pointerId);
    dlg.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dy = e.clientY - startY;
    const shown = dy < 0 ? -Math.sqrt(-dy) * 2 : dy;
    dlg.style.transform = `translateY(${shown}px)`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    dlg.classList.remove('dragging');
    const velocity = dy / Math.max(1, performance.now() - startT);
    if (dy > dlg.offsetHeight * 0.3 || velocity > 0.11) closeSheet();
    else dlg.style.transform = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
