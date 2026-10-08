// Rush Voice: a phone-call style voice agent.
// • Outgoing: "Call Rush" opens a hands-free call — you talk, Rush answers aloud
//   from the live engine, then listens again until you hang up.
// • Incoming: alerts (place got quiet, rush in a live session) ring like a call
//   with a ringtone and vibration; answering speaks the alert and keeps the line
//   open for follow-up questions.
// Speech recognition + synthesis are the browser's own (free, on-device where
// supported). Without speech recognition the call still works with typed replies.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

export function createVoice(ctx) {
  const { t, icon, esc } = ctx;
  let el = null;
  let state = 'idle'; // idle | ringing | connecting | talking | listening | thinking | speaking
  let rec = null;
  let timer = 0;
  let startedAt = 0;
  let audio = null;
  let ringTimer = 0;
  let muted = false;
  let pending = null; // alert text to speak on answer
  let enabled = true;
  try { enabled = localStorage.getItem('rc.voiceAlerts') !== '0'; } catch {}

  // ---------- sound ----------
  function ctxAudio() {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    return audio;
  }
  function tone(freqs, start, dur, gain = 0.08) {
    const ac = ctxAudio();
    const g = ac.createGain();
    g.gain.setValueAtTime(0, ac.currentTime + start);
    g.gain.linearRampToValueAtTime(gain, ac.currentTime + start + 0.02);
    g.gain.setValueAtTime(gain, ac.currentTime + start + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, ac.currentTime + start + dur);
    g.connect(ac.destination);
    for (const f of freqs) {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g);
      o.start(ac.currentTime + start);
      o.stop(ac.currentTime + start + dur + 0.05);
    }
  }
  function ring() {
    const burst = () => {
      try {
        tone([523.25, 659.25], 0, 0.35);
        tone([587.33, 783.99], 0.45, 0.35);
      } catch {}
      try { navigator.vibrate?.([400, 200, 400]); } catch {}
    };
    burst();
    ringTimer = setInterval(burst, 2200);
  }
  function stopRing() {
    clearInterval(ringTimer);
    try { navigator.vibrate?.(0); } catch {}
  }
  const chirp = (up = true) => { try { tone([up ? 880 : 660], 0, 0.09, 0.05); tone([up ? 1175 : 523], 0.1, 0.09, 0.05); } catch {} };

  // ---------- speech ----------
  function pickVoice(locale) {
    const voices = speechSynthesis.getVoices();
    return voices.find((v) => v.lang === locale) || voices.find((v) => v.lang?.startsWith(locale.slice(0, 2))) || null;
  }
  function speak(text) {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window) || muted) { resolve(); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/[•—]/g, ', '));
      u.lang = ctx.lang().locale;
      const v = pickVoice(u.lang);
      if (v) u.voice = v;
      u.rate = 1.02;
      u.onstart = () => setState('speaking');
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
      // Some engines never fire onend; cap the wait by length.
      setTimeout(resolve, 1500 + text.length * 90);
    });
  }
  function listen() {
    return new Promise((resolve) => {
      if (!SpeechRec) { setState('listening'); el?.querySelector('[data-call-input]')?.focus(); pendingType = resolve; return; }
      rec = new SpeechRec();
      rec.lang = ctx.lang().locale;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      let finalText = '';
      rec.onresult = (ev) => {
        const r = ev.results[ev.results.length - 1];
        caption('you', r[0].transcript, !r.isFinal);
        if (r.isFinal) finalText = r[0].transcript;
      };
      rec.onerror = () => {};
      rec.onend = () => { rec = null; resolve(finalText.trim()); };
      setState('listening');
      chirp(true);
      try { rec.start(); } catch { resolve(''); }
    });
  }
  let pendingType = null;

  // ---------- conversation loop ----------
  let loopToken = 0;
  async function converse(opening) {
    const token = ++loopToken;
    if (opening) {
      caption('rush', opening);
      await speak(opening);
    }
    let silent = 0;
    while (token === loopToken && el) {
      const heard = await listen();
      if (token !== loopToken || !el) return;
      if (!heard) {
        silent += 1;
        if (silent >= 2) { await say(t('voice.bye')); return hangup(); }
        continue;
      }
      silent = 0;
      if (/\b(bye|goodbye|hang up|that's all|thats all|stop|end call)\b/i.test(heard)) { await say(t('voice.bye')); return hangup(); }
      setState('thinking');
      const res = await ctx.ask(heard).catch(() => ({ text: t('ai.fallback') }));
      if (token !== loopToken) return;
      await say(res.text);
    }
  }
  async function say(text) {
    caption('rush', text);
    await speak(text);
  }

  // ---------- UI ----------
  function setState(s) {
    state = s;
    if (!el) return;
    el.dataset.state = s;
    const label = el.querySelector('[data-call-status]');
    if (label && s !== 'talking') label.textContent = t(`voice.state.${s}`);
  }
  function caption(who, text, interim = false) {
    const log = el?.querySelector('[data-call-log]');
    if (!log) return;
    let line = log.querySelector('.interim');
    if (!line || !interim) {
      line?.classList.remove('interim');
      if (!interim && line && line.dataset.who === who) { line.textContent = text; line.classList.remove('interim'); log.scrollTop = log.scrollHeight; return; }
      line = document.createElement('p');
      line.dataset.who = who;
      log.append(line);
    }
    line.textContent = text;
    line.classList.toggle('interim', interim);
    log.scrollTop = log.scrollHeight;
  }
  function tick() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const tEl = el?.querySelector('[data-call-time]');
    if (tEl) tEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function build(incoming, subtitle) {
    el?.remove();
    el = document.createElement('div');
    el.className = 'call';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', t('voice.title'));
    el.innerHTML = `
      <div class="call-bg"></div>
      <div class="call-top">
        <span class="call-kind">${icon(incoming ? 'bell' : 'phone')}${t(incoming ? 'voice.incoming' : 'voice.title')}</span>
        <span class="call-time" data-call-time>${incoming ? '' : '00:00'}</span>
      </div>
      <div class="call-orb"><span class="orb-ring"></span><span class="orb-ring r2"></span><span class="orb-core">${icon('spark')}</span></div>
      <h2 class="call-name">Rush AI</h2>
      <p class="call-sub">${esc(subtitle || '')}</p>
      <p class="call-status" data-call-status>${t(incoming ? 'voice.state.ringing' : 'voice.state.connecting')}</p>
      <div class="call-log" data-call-log aria-live="polite"></div>
      <form class="call-type" data-call-type ${SpeechRec ? 'hidden' : ''}>
        <input data-call-input autocomplete="off" placeholder="${esc(t('ai.placeholder'))}" aria-label="${esc(t('ai.placeholder'))}" />
      </form>
      <div class="call-actions">
        ${incoming ? `
          <button class="call-btn decline" type="button" data-call="decline" aria-label="${t('voice.decline')}">${icon('phone')}<span>${t('voice.decline')}</span></button>
          <button class="call-btn accept" type="button" data-call="accept" aria-label="${t('voice.accept')}">${icon('phone')}<span>${t('voice.accept')}</span></button>`
        : `
          <button class="call-btn ghost" type="button" data-call="mute" aria-pressed="false" aria-label="${t('voice.mute')}">${icon('volume')}<span>${t('voice.mute')}</span></button>
          <button class="call-btn decline" type="button" data-call="end" aria-label="${t('voice.end')}">${icon('phone')}<span>${t('voice.end')}</span></button>`}
      </div>`;
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('open'));
    el.addEventListener('click', onClick);
    el.querySelector('[data-call-type]').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = el.querySelector('[data-call-input]');
      const v = input.value.trim();
      input.value = '';
      if (v) caption('you', v);
      pendingType?.(v);
      pendingType = null;
    });
  }
  function swapToActive() {
    const actions = el.querySelector('.call-actions');
    actions.innerHTML = `
      <button class="call-btn ghost" type="button" data-call="mute" aria-pressed="false" aria-label="${t('voice.mute')}">${icon('volume')}<span>${t('voice.mute')}</span></button>
      <button class="call-btn decline" type="button" data-call="end" aria-label="${t('voice.end')}">${icon('phone')}<span>${t('voice.end')}</span></button>`;
    el.querySelector('.call-kind').innerHTML = `${icon('phone')}${t('voice.title')}`;
  }
  async function onClick(e) {
    const b = e.target.closest('[data-call]');
    if (!b) return;
    const act = b.dataset.call;
    if (act === 'decline' || act === 'end') return hangup();
    if (act === 'mute') {
      muted = !muted;
      b.setAttribute('aria-pressed', String(muted));
      if (muted) speechSynthesis.cancel();
    }
    if (act === 'accept') {
      stopRing();
      swapToActive();
      connected();
      const text = pending;
      pending = null;
      converse(`${text} ${t('voice.followUp')}`);
    }
  }
  function connected() {
    startedAt = Date.now();
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    tick();
    chirp(true);
  }
  function hangup() {
    loopToken++;
    stopRing();
    clearInterval(timer);
    try { rec?.abort(); } catch {}
    try { speechSynthesis.cancel(); } catch {}
    pendingType?.('');
    pendingType = null;
    chirp(false);
    if (!el) return;
    const node = el;
    el = null;
    node.classList.remove('open');
    node.classList.add('closing');
    setTimeout(() => node.remove(), 320);
    state = 'idle';
  }

  return {
    get enabled() { return enabled; },
    setEnabled(on) { enabled = on; try { localStorage.setItem('rc.voiceAlerts', on ? '1' : '0'); } catch {} },
    get busy() { return !!el; },
    /** Outgoing call: talk to Rush hands-free. */
    call() {
      if (el) return;
      muted = false;
      build(false, t('voice.sub'));
      setState('connecting');
      ctxAudio();
      setTimeout(() => { connected(); converse(t('voice.greet')); }, 700);
    },
    /** Incoming call for an alert. Rings until answered or declined (30 s). */
    alert(text, subtitle) {
      if (!enabled || el) return false;
      muted = false;
      pending = text;
      build(true, subtitle);
      setState('ringing');
      ring();
      setTimeout(() => { if (pending) hangup(); }, 30000);
      return true;
    },
    hangup,
  };
}
