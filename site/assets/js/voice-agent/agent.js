// VoiceAgent: a real-time, phone-call style conversation loop.
//
//   const agent = new VoiceAgent({ tts, brain, lang: 'en' });
//   agent.on('state', s => …); agent.on('caption', ({ who, text, interim }) => …);
//   await agent.start('Hi, it's Rush!');   // speaks, then listens, answers, repeats
//   agent.hangup();
//
// • Streams replies sentence by sentence, synthesizing the next while the current
//   one plays, so long answers start in ~0.5 s.
// • Emotion-aware delivery (cheerful / urgent / empathetic …) and human touches.
// • Barge-in: speak over the agent and it stops and listens (VAD + echo cancel).
// • Thinking filler if the brain is slow, silence handling, typed fallback when
//   there's no mic/recognizer (call `agent.reply(text)` from your UI).

import { detectEmotion, filler, humanize, sentences } from './emotion.js';
import { listenOnce, startVAD, sttSupported } from './listen.js';

export class VoiceAgent {
  constructor({ tts, brain, lang = 'en', bargeIn = true, fillerAfterMs = 700, maxSilences = 2, goodbye = /\b(bye|goodbye|hang up|that's all|thats all|end call|stop)\b/i, byeText = 'Okay, bye! Talk soon.' } = {}) {
    if (!tts || !brain) throw new Error('VoiceAgent needs { tts, brain }');
    Object.assign(this, { tts, brain, lang, bargeIn, fillerAfterMs, maxSilences, goodbye, byeText });
    this.state = 'idle';
    this.handlers = {};
    this.token = 0;
    this.current = null;
    this.typed = !sttSupported();
    this.pendingReply = null;
    this.history = [];
  }

  on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
  emit(event, data) { for (const fn of this.handlers[event] || []) try { fn(data); } catch {} }
  setState(s) { this.state = s; this.emit('state', s); }

  /** Speak text with emotion, streaming by sentence; returns false if interrupted. */
  async say(text, { emotion, token = this.token } = {}) {
    const mood = detectEmotion(text, emotion);
    const spoken = humanize(text, mood, this.lang);
    this.emit('caption', { who: 'agent', text, interim: false, emotion: mood });
    const parts = sentences(spoken);
    let next = this.tts.prepare(parts[0], { lang: this.lang, emotion: mood }).catch((e) => e);
    let vad = null;
    let interrupted = false;
    if (this.bargeIn && !this.typed) {
      vad = await startVAD({ onSpeech: () => { interrupted = true; this.current?.stop(); this.emit('bargein'); } }).catch(() => null);
    }
    try {
      for (let i = 0; i < parts.length; i++) {
        const clip = await next;
        if (i + 1 < parts.length) next = this.tts.prepare(parts[i + 1], { lang: this.lang, emotion: mood }).catch((e) => e);
        if (token !== this.token || interrupted) return false;
        if (clip instanceof Error) continue;
        this.current = clip;
        this.setState('speaking');
        await clip.play();
        this.current = null;
        if (token !== this.token || interrupted) return false;
      }
      return true;
    } finally {
      vad?.stop();
    }
  }

  async listen(token) {
    this.setState('listening');
    this.emit('listening');
    if (this.typed) {
      this.emit('typed-mode');
      return new Promise((resolve) => { this.pendingReply = resolve; });
    }
    const { text, error } = await listenOnce({ lang: this.lang, onInterim: (t, interim) => this.emit('caption', { who: 'user', text: t, interim }) });
    if (token !== this.token) return '';
    if (error) {
      this.typed = true; // mic denied/unavailable: keep the call alive with typed replies
      return this.listen(token);
    }
    return text;
  }

  /** Typed reply from the UI (used when there's no mic). */
  reply(text) {
    this.emit('caption', { who: 'user', text, interim: false });
    const r = this.pendingReply;
    this.pendingReply = null;
    r?.(text);
  }

  async think(question, token) {
    this.setState('thinking');
    let fillerPlayed = false;
    const slow = setTimeout(async () => {
      if (token !== this.token) return;
      fillerPlayed = true;
      try { const c = await this.tts.prepare(filler(this.lang, this.history.length), { lang: this.lang, emotion: 'thinking' }); if (token === this.token && this.state === 'thinking') { this.current = c; await c.play(); } } catch {}
    }, this.fillerAfterMs);
    try {
      const res = await this.brain(question, { history: this.history.slice(-6), lang: this.lang });
      return typeof res === 'string' ? { text: res } : res;
    } finally {
      clearTimeout(slow);
      if (fillerPlayed) this.current?.stop();
    }
  }

  /** Run the call loop. `opening` is spoken first (e.g. greeting or alert). */
  async start(opening, { emotion } = {}) {
    const token = ++this.token;
    this.emit('connected');
    if (opening) {
      this.history.push({ role: 'assistant', content: opening });
      await this.say(opening, { emotion, token });
    }
    let silences = 0;
    while (token === this.token) {
      const heard = await this.listen(token);
      if (token !== this.token) return;
      if (!heard) {
        if (++silences >= this.maxSilences) { await this.say(this.byeText, { emotion: 'friendly', token }); this.hangup(); return; }
        continue;
      }
      silences = 0;
      this.history.push({ role: 'user', content: heard });
      if (this.goodbye.test(heard)) { await this.say(this.byeText, { emotion: 'friendly', token }); this.hangup(); return; }
      const res = await this.think(heard, token).catch(() => ({ text: "Sorry, I didn't catch that. Could you say it again?", emotion: 'empathetic' }));
      if (token !== this.token) return;
      this.history.push({ role: 'assistant', content: res.text });
      await this.say(res.text, { emotion: res.emotion, token });
    }
  }

  hangup() {
    this.token++;
    this.current?.stop();
    listenOnce.abort();
    this.pendingReply?.('');
    this.pendingReply = null;
    this.setState('ended');
    this.emit('ended');
  }
}
