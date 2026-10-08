// Continuous live background: particles drift through a slowly evolving flow
// field and cluster around moving "hotspots", like people flowing across campus.
// Delta-time driven, DPR-capped, paused when hidden, gentler under reduced motion.

export function startBackground(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return () => {};
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  let w = 0;
  let h = 0;
  let dpr = 1;
  let particles = [];
  let rgb = '160 190 255';
  let raf = 0;
  let last = performance.now();
  let t = Math.random() * 1000;
  const pointer = { x: -1e4, y: -1e4, active: false };

  const hotspots = Array.from({ length: 4 }, (_, i) => ({ phase: i * 1.7, r: 0.18 + i * 0.04 }));

  function readColor() {
    rgb = getComputedStyle(document.documentElement).getPropertyValue('--particle').trim() || rgb;
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, w * h > 1.5e6 ? 1.25 : 1.75);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const target = Math.round(Math.min(150, Math.max(45, (w * h) / 9000)));
    while (particles.length < target) particles.push(spawn(true));
    particles.length = target;
  }

  function spawn(anywhere) {
    return {
      x: anywhere ? Math.random() * w : (Math.random() < 0.5 ? -10 : w + 10),
      y: Math.random() * h,
      px: 0,
      py: 0,
      v: 0.35 + Math.random() * 0.65,
      size: 0.8 + Math.random() * 1.6,
      life: Math.random(),
    };
  }

  function hotspotPos(hs) {
    return {
      x: w * (0.5 + 0.38 * Math.sin(t * 0.00011 + hs.phase) * Math.cos(t * 0.00007 + hs.phase * 2)),
      y: h * (0.5 + 0.34 * Math.cos(t * 0.00013 + hs.phase * 1.3)),
    };
  }

  function field(x, y) {
    const s = 0.0016;
    return (
      Math.sin(x * s + t * 0.00018) * 1.4 +
      Math.cos(y * s * 1.3 - t * 0.00014) * 1.2 +
      Math.sin((x + y) * s * 0.6 + t * 0.0001)
    );
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(48, now - last);
    last = now;
    const speed = reduce.matches ? 0.25 : 1;
    t += dt * speed;
    ctx.clearRect(0, 0, w, h);

    const spots = hotspots.map(hotspotPos);
    const step = (dt / 16.7) * speed;

    ctx.lineCap = 'round';
    for (const p of particles) {
      p.px = p.x;
      p.py = p.y;
      const a = field(p.x, p.y);
      let vx = Math.cos(a) * p.v;
      let vy = Math.sin(a) * p.v;
      // Gentle pull toward the nearest hotspot: crowds gather.
      let best = null;
      let bestD = Infinity;
      for (const s of spots) {
        const d = (s.x - p.x) ** 2 + (s.y - p.y) ** 2;
        if (d < bestD) { bestD = d; best = s; }
      }
      const dist = Math.sqrt(bestD) || 1;
      const pull = Math.min(0.5, 120 / dist) * 0.45;
      vx += ((best.x - p.x) / dist) * pull;
      vy += ((best.y - p.y) / dist) * pull;
      // Pointer makes room, like stepping into a crowd.
      if (pointer.active) {
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 140 * 140) {
          const f = (1 - Math.sqrt(d2) / 140) * 2.2;
          vx += (dx / (Math.sqrt(d2) || 1)) * f;
          vy += (dy / (Math.sqrt(d2) || 1)) * f;
        }
      }
      p.x += vx * step;
      p.y += vy * step;
      p.life += 0.0015 * step;
      if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20 || p.life > 1.6) Object.assign(p, spawn(true), { life: 0 });

      const fade = Math.min(1, p.life * 4) * Math.min(1, (1.6 - p.life) * 4);
      ctx.strokeStyle = `rgb(${rgb} / ${0.75 * fade})`;
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.px - (p.x - p.px) * 5, p.py - (p.y - p.py) * 5);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    if (!reduce.matches) {
      ctx.lineWidth = 0.6;
      const max = 86;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x;
          if (dx > max || dx < -max) continue;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < max * max) {
            ctx.strokeStyle = `rgb(${rgb} / ${0.2 * (1 - Math.sqrt(d2) / max)})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    }
  }

  function play() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  readColor();
  resize();
  new ResizeObserver(resize).observe(canvas);
  new MutationObserver(readColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', readColor);
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()));
  window.addEventListener('pointermove', (e) => {
    if (!finePointer.matches) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.active = true;
  }, { passive: true });
  document.addEventListener('pointerleave', () => (pointer.active = false));
  play();
  return pause;
}
