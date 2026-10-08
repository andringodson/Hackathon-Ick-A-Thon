// Rush Voice: phone-call UI on top of rush-voice-agent (vendored in ./voice-agent).
// • Outgoing: "Call Rush" — a real-time, hands-free conversation in a natural
//   neural voice with emotion, streaming replies and barge-in.
// • Incoming: quiet alerts and live-session rushes ring like a call; answering
//   speaks the alert and keeps the line open for follow-ups.

import { CONFIG } from './config.js';
import { VoiceAgent, createTTS, ringtone, earcon, detectEmotion, humanize } from './voice-agent/index.js';

export function createVoice(ctx) {
  const { t, icon, esc } = ctx;
  const tts = createTTS({ endpoint: CONFIG.ttsEndpoint });
  let el = null;
  let agent = null;
  let stopRing = null;
  let timer = 0;
  let startedAt = 0;
  let pending = null;
  let muted = false;
  let enabled = true;
  try { enabled = localStorage.getItem('rc.voiceAlerts') !== '0'; } catch {}

  const langCode = () => ctx.lang().code;

  function setState(s) {
    if (!el) return;
    el.dataset.state = s;
    const label = el.querySelector('[data-call-status]');
    if (label && t(`voice.state.${s}`) !== `voice.state.${s}`) label.textContent = t(`voice.state.${s}`);
  }

  function caption({ who, text, interim }) {
    const log = el?.querySelector('[data-call-log]');
    if (!log) return;
    const role = who === 'agent' ? 'rush' : 'you';
    let line = log.querySelector('p.interim');
    if (interim) {
      if (!line) {
        line = document.createElement('p');
        line.dataset.who = role;
        line.className = 'interim';
        log.append(line);
      }
      line.textContent = text;
    } else {
      line?.remove();
      const p = document.createElement('p');
      p.dataset.who = role;
      p.textContent = text;
      log.append(p);
    }
    log.scrollTop = log.scrollHeight;
  }

  function tick() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const tEl = el?.querySelector('[data-call-time]');
    if (tEl) tEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function activeButtons() {
    return `
      <button class="call-btn ghost" type="button" data-call="mute" aria-pressed="${muted}" aria-label="${t('voice.mute')}">${icon('volume')}<span>${t('voice.mute')}</span></button>
      <button class="call-btn decline" type="button" data-call="end" aria-label="${t('voice.end')}">${icon('phone')}<span>${t('voice.end')}</span></button>`;
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
      <form class="call-type" data-call-type hidden>
        <input data-call-input autocomplete="off" enterkeyhint="send" placeholder="${esc(t('ai.placeholder'))}" aria-label="${esc(t('ai.placeholder'))}" />
      </form>
      <div class="call-actions">${incoming ? `
        <button class="call-btn decline" type="button" data-call="decline" aria-label="${t('voice.decline')}">${icon('phone')}<span>${t('voice.decline')}</span></button>
        <button class="call-btn accept" type="button" data-call="accept" aria-label="${t('voice.accept')}">${icon('phone')}<span>${t('voice.accept')}</span></button>` : activeButtons()}
      </div>`;
    document.body.append(el);
    el.dataset.state = incoming ? 'ringing' : 'connecting';
    requestAnimationFrame(() => el.classList.add('open'));
    el.addEventListener('click', onClick);
    el.querySelector('[data-call-type]').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = el.querySelector('[data-call-input]');
      const v = input.value.trim();
      input.value = '';
      if (v) agent?.reply(v);
    });
  }

  function newAgent() {
    agent = new VoiceAgent({
      tts: muted ? { prepare: async () => ({ play: async () => {}, stop() {} }) } : tts,
      lang: langCode(),
      brain: async (question) => ctx.ask(question),
      byeText: t('voice.bye'),
    });
    agent.on('state', setState);
    agent.on('caption', caption);
    agent.on('typed-mode', () => {
      const form = el?.querySelector('[data-call-type]');
      if (form) { form.hidden = false; form.querySelector('input')?.focus(); }
    });
    agent.on('ended', () => close());
    return agent;
  }

  function connected() {
    startedAt = Date.now();
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    tick();
    earcon('connect');
  }

  async function onClick(e) {
    const b = e.target.closest('[data-call]');
    if (!b) return;
    const act = b.dataset.call;
    if (act === 'decline' || act === 'end') { agent ? agent.hangup() : close(); return; }
    if (act === 'mute') {
      muted = !muted;
      b.setAttribute('aria-pressed', String(muted));
      if (muted) agent?.current?.stop();
      if (agent) agent.tts = muted ? { prepare: async () => ({ play: async () => {}, stop() {} }) } : tts;
    }
    if (act === 'accept') {
      stopRing?.();
      stopRing = null;
      el.querySelector('.call-actions').innerHTML = activeButtons();
      el.querySelector('.call-kind').innerHTML = `${icon('phone')}${t('voice.title')}`;
      connected();
      const text = pending;
      pending = null;
      newAgent().start(`${text} ${t('voice.followUp')}`);
    }
  }

  function close() {
    stopRing?.();
    stopRing = null;
    clearInterval(timer);
    if (!el) return;
    earcon('hangup');
    const node = el;
    el = null;
    agent = null;
    node.classList.remove('open');
    node.classList.add('closing');
    setTimeout(() => node.remove(), 320);
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
      setTimeout(() => { connected(); newAgent().start(t('voice.greet'), { emotion: 'friendly' }); }, 600);
    },
    /** Incoming call for an alert. Rings until answered or declined (30 s). */
    alert(text, subtitle) {
      if (!enabled || el) return false;
      muted = false;
      pending = text;
      build(true, subtitle);
      stopRing = ringtone();
      setTimeout(() => { if (pending && el) close(); }, 30000);
      return true;
    },
    /** One-off spoken line in the neural voice (used by "read answers aloud"). */
    async speak(text) {
      try {
        const emotion = detectEmotion(text);
        const clip = await tts.prepare(humanize(text, emotion, langCode()), { lang: langCode(), emotion });
        await clip.play();
      } catch {}
    },
    hangup: () => (agent ? agent.hangup() : close()),
  };
}
