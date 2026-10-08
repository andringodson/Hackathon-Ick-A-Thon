// "Liquid light" background: glossy colour orbs rendered as metaballs in a
// WebGL fragment shader. They merge and split like a lava lamp, lean toward the
// pointer, speed up with campus crowd energy, and glide to a new palette on
// every route change. Rendered at reduced resolution (the glass on top blurs it
// anyway), paused when hidden, gentler under reduced motion, 2D fallback.

const PALETTES = {
  home: ['#ff3d9a', '#7c4dff', '#00d4ff', '#ff8a3d'],
  live: ['#00e0a4', '#00a2ff', '#7c4dff', '#d6ff3d'],
  map: ['#00c2ff', '#2dffb3', '#5b6cff', '#ff5ec4'],
  insights: ['#9b5cff', '#ff4d6d', '#ffb02e', '#3d7bff'],
  about: ['#ff6a3d', '#ff2e93', '#8a5cff', '#2ee6ff'],
  facility: ['#ff8a3d', '#ff3d9a', '#3d8bff', '#22e3c2'],
};
const LIGHT_MIX = 0.38; // pastel the orbs in light mode

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uMouseOn;
uniform float uEnergy;
uniform float uLight;
uniform vec3 uCol[4];

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float t = uTime;

  float field = 0.0;
  vec3 tint = vec3(0.0);
  float fit = min(aspect, 1.0);
  float spreadX = max(aspect, 0.85) * 0.55;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float sp = 0.06 + 0.012 * fi;
    vec2 c = vec2(
      sin(t * sp * 1.3 + fi * 1.7) * spreadX * fit + sin(t * sp * 0.7 + fi) * 0.1 * fit,
      cos(t * sp + fi * 2.3) * 0.4 + sin(t * sp * 0.5 + fi * 0.8) * 0.08
    );
    float r = (0.1 + 0.03 * sin(t * 0.35 + fi * 1.9)) * (0.85 + uEnergy * 0.4) * (0.45 + 0.55 * fit);
    vec2 d = p - c;
    float v = r * r / (dot(d, d) + 1e-4);
    field += v;
    float k = mod(fi, 4.0);
    vec3 col = k < 0.5 ? uCol[0] : k < 1.5 ? uCol[1] : k < 2.5 ? uCol[2] : uCol[3];
    tint += col * v;
  }
  // The pointer is a small orb that pulls the liquid toward it.
  vec2 m = (uMouse - 0.5) * vec2(aspect, 1.0);
  float mv = 0.012 * uMouseOn / (dot(p - m, p - m) + 2e-3);
  field += mv;
  tint += mix(uCol[0], uCol[2], 0.5) * mv;

  vec3 col = tint / max(field, 1e-4);
  float body = smoothstep(0.85, 1.6, field);
  float glow = smoothstep(0.12, 1.0, field);
  float rim = smoothstep(0.78, 0.95, field) - smoothstep(0.95, 1.35, field);
  float sheen = pow(clamp(1.0 - abs(field - 2.2) / 2.2, 0.0, 1.0), 6.0);

  vec3 dark = (col * (body * 0.78 + glow * 0.3) + rim * vec3(1.0) * 0.22 + sheen * 0.12) * 0.82;
  vec3 base = vec3(0.94, 0.95, 0.975);
  vec3 light = mix(base, mix(col, vec3(1.0), ${LIGHT_MIX.toFixed(2)}), clamp(body * 0.85 + glow * 0.5, 0.0, 1.0)) + rim * 0.12;
  vec3 outc = mix(dark, light, uLight);
  outc += (hash(gl_FragCoord.xy + fract(t)) - 0.5) * 0.025; // grain kills banding
  gl_FragColor = vec4(outc, 1.0);
}`;

export function startBackground(canvas) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  const lowEnd = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  const state = {
    from: PALETTES.home.map(hex),
    to: PALETTES.home.map(hex),
    mixT: 1,
    energy: 0.4,
    energyTarget: 0.4,
    boost: 0,
    mouse: [0.5, 0.5],
    mouseSm: [0.5, 0.5],
    mouseOn: 0,
    mouseOnTarget: 0,
    light: 0,
    lightTarget: 0,
  };
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  const currentColors = () => {
    const k = easeInOut(Math.min(1, state.mixT));
    return state.from.map((c, i) => c.map((v, j) => v + (state.to[i][j] - v) * k));
  };
  const api = {
    setRoute(route) {
      const pal = PALETTES[route] || PALETTES.home;
      state.from = currentColors();
      state.to = pal.map(hex);
      state.mixT = 0;
      state.boost = reduce.matches ? 0.4 : 1.6; // swirl on navigation
    },
    setEnergy(e) {
      state.energyTarget = Math.max(0, Math.min(1, e));
    },
  };

  function readTheme() {
    const th = document.documentElement.dataset.theme;
    state.lightTarget = th === 'light' || (th !== 'dark' && matchMedia('(prefers-color-scheme: light)').matches) ? 1 : 0;
  }
  readTheme();
  state.light = state.lightTarget;
  new MutationObserver(readTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);

  window.addEventListener('pointermove', (e) => {
    state.mouse = [e.clientX / innerWidth, 1 - e.clientY / innerHeight];
    state.mouseOnTarget = finePointer.matches || e.pointerType === 'touch' ? 1 : 0;
  }, { passive: true });
  window.addEventListener('pointerdown', (e) => {
    state.mouse = [e.clientX / innerWidth, 1 - e.clientY / innerHeight];
    state.mouseOnTarget = 1;
  }, { passive: true });
  document.addEventListener('pointerleave', () => (state.mouseOnTarget = 0));
  window.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') state.mouseOnTarget = 0; }, { passive: true });

  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) return fallback2d(canvas, state, api, currentColors);

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    console.warn('WebGL background unavailable:', err);
    return fallback2d(canvas, state, api, currentColors);
  }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = Object.fromEntries(['uRes', 'uTime', 'uMouse', 'uMouseOn', 'uEnergy', 'uLight', 'uCol'].map((n) => [n, gl.getUniformLocation(prog, n)]));

  const scale = lowEnd ? 0.35 : 0.5;
  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth * scale));
    const h = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  let raf = 0;
  let last = performance.now();
  let time = Math.random() * 100;
  let acc = 0;
  const minFrame = lowEnd ? 1000 / 30 : 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    acc += Math.min(64, now - last);
    last = now;
    if (acc < minFrame) return;
    const step = acc / 1000;
    acc = 0;
    stepState(state, step, reduce.matches);
    time += step * (reduce.matches ? 0.45 : 1) * (1 + state.boost * 2.2) * (0.8 + state.energy * 0.6);

    gl.uniform2f(u.uRes, canvas.width, canvas.height);
    gl.uniform1f(u.uTime, time);
    gl.uniform2f(u.uMouse, state.mouseSm[0], state.mouseSm[1]);
    gl.uniform1f(u.uMouseOn, state.mouseOn);
    gl.uniform1f(u.uEnergy, state.energy);
    gl.uniform1f(u.uLight, state.light);
    gl.uniform3fv(u.uCol, new Float32Array(currentColors().flat()));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const play = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  const pause = () => { cancelAnimationFrame(raf); raf = 0; };
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()));
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); pause(); });
  play();
  return api;
}

function stepState(s, dt, reduced) {
  s.mixT = Math.min(1, s.mixT + dt / 1.6);
  s.boost = Math.max(0, s.boost - dt * 1.4);
  s.energy += (s.energyTarget - s.energy) * Math.min(1, dt * 0.8);
  s.light += (s.lightTarget - s.light) * Math.min(1, dt * 3);
  s.mouseOn += (s.mouseOnTarget - s.mouseOn) * Math.min(1, dt * 2.5);
  const k = Math.min(1, dt * (reduced ? 1.5 : 3.5));
  s.mouseSm = [s.mouseSm[0] + (s.mouse[0] - s.mouseSm[0]) * k, s.mouseSm[1] + (s.mouse[1] - s.mouseSm[1]) * k];
}

/** No WebGL: soft radial orbs on a 2D canvas, same palette logic. */
function fallback2d(canvas, state, api, currentColors) {
  const ctx = canvas.getContext('2d');
  let t = 0;
  let last = performance.now();
  const draw = (now) => {
    requestAnimationFrame(draw);
    if (document.hidden) return;
    const dt = Math.min(64, now - last) / 1000;
    last = now;
    stepState(state, dt, false);
    t += dt * (1 + state.boost * 2);
    const w = (canvas.width = Math.round(canvas.clientWidth / 2));
    const h = (canvas.height = Math.round(canvas.clientHeight / 2));
    ctx.fillStyle = state.light > 0.5 ? '#eff1f6' : '#000';
    ctx.fillRect(0, 0, w, h);
    const cols = currentColors().map((c) => c.map((v) => Math.round(v * 255)));
    for (let i = 0; i < 6; i++) {
      const x = w * (0.5 + 0.4 * Math.sin(t * (0.07 + i * 0.01) + i * 1.7));
      const y = h * (0.5 + 0.35 * Math.cos(t * (0.06 + i * 0.012) + i * 2.3));
      const r = Math.min(w, h) * (0.35 + 0.1 * Math.sin(t * 0.3 + i));
      const [cr, cg, cb] = cols[i % 4];
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgb(${cr} ${cg} ${cb} / 0.55)`);
      g.addColorStop(1, `rgb(${cr} ${cg} ${cb} / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  };
  requestAnimationFrame(draw);
  return api;
}
