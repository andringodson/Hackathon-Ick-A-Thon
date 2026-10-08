// Text-to-speech providers with a shared interface:
//   prepare(text, opts) -> Promise<Clip>   (fetch/synthesize ahead of time)
//   Clip.play() -> Promise<void>           (resolves when finished or stopped)
//   Clip.stop()
// NeuralTTS streams Microsoft neural voices from the serverless /api/tts.
// WebSpeechTTS uses the browser's own voices. ChainTTS tries providers in order.

const LOCALES = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', ml: 'ml-IN', kn: 'kn-IN', te: 'te-IN', bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', ur: 'ur-IN' };

export class NeuralTTS {
  constructor({ endpoint, gender = 'female', voice, timeoutMs = 8000 } = {}) {
    if (!endpoint) throw new Error('NeuralTTS needs an endpoint, e.g. https://your-app.vercel.app/api/tts');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.gender = gender;
    this.voice = voice;
    this.timeoutMs = timeoutMs;
    this.name = 'neural';
  }

  url(text, { lang = 'en', emotion = 'neutral' } = {}) {
    const p = new URLSearchParams({ text, lang, emotion, gender: this.gender });
    if (this.voice) p.set('voice', this.voice);
    return `${this.endpoint}?${p}`;
  }

  async prepare(text, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    // GET so the CDN caches repeated phrases (greetings, alerts) for instant replay.
    const res = await fetch(this.url(text, opts), { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const blob = await res.blob();
    if (blob.size < 400) throw new Error('tts empty');
    const src = URL.createObjectURL(blob);
    const audio = new Audio(src);
    audio.preload = 'auto';
    let done = null;
    return {
      provider: this.name,
      audio,
      play() {
        return new Promise((resolve) => {
          done = () => { URL.revokeObjectURL(src); resolve(); };
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done);
        });
      },
      stop() {
        try { audio.pause(); } catch {}
        done?.();
      },
    };
  }
}

export class WebSpeechTTS {
  constructor() {
    this.name = 'webspeech';
    this.available = typeof speechSynthesis !== 'undefined';
  }

  voiceFor(locale) {
    const voices = speechSynthesis.getVoices();
    const lang = locale.slice(0, 2);
    // Prefer "natural/neural/online" voices, which many browsers now ship.
    const score = (v) => (v.lang === locale ? 4 : v.lang?.startsWith(lang) ? 2 : 0) + (/natural|neural|online|premium|enhanced/i.test(v.name) ? 3 : 0) + (/female|neerja|swara|heera|kalpana/i.test(v.name) ? 1 : 0);
    return voices.filter((v) => v.lang?.startsWith(lang)).sort((a, b) => score(b) - score(a))[0] || null;
  }

  async prepare(text, { lang = 'en', emotion = 'neutral' } = {}) {
    if (!this.available) throw new Error('speechSynthesis unavailable');
    const locale = LOCALES[lang] || lang;
    const tune = { cheerful: [1.06, 1.12], excited: [1.1, 1.18], urgent: [1.1, 1.04], empathetic: [0.92, 0.95], calm: [0.95, 0.98], friendly: [1.03, 1.06], thinking: [0.96, 1] }[emotion] || [1, 1];
    let utter = null;
    return {
      provider: this.name,
      play: () => new Promise((resolve) => {
        utter = new SpeechSynthesisUtterance(text);
        utter.lang = locale;
        const v = this.voiceFor(locale);
        if (v) utter.voice = v;
        [utter.rate, utter.pitch] = tune;
        utter.onend = resolve;
        utter.onerror = resolve;
        speechSynthesis.cancel();
        speechSynthesis.speak(utter);
        setTimeout(resolve, 2000 + text.length * 95); // some engines never fire onend
      }),
      stop: () => { try { speechSynthesis.cancel(); } catch {} },
    };
  }
}

/** Try each provider in order; remember a failing one and skip it for a while. */
export class ChainTTS {
  constructor(providers) {
    this.providers = providers.filter(Boolean);
    this.cooldown = new Map();
    this.name = 'chain';
  }

  async prepare(text, opts) {
    let lastErr;
    for (const p of this.providers) {
      if ((this.cooldown.get(p) || 0) > Date.now()) continue;
      try {
        return await p.prepare(text, opts);
      } catch (err) {
        lastErr = err;
        this.cooldown.set(p, Date.now() + 60000);
      }
    }
    throw lastErr || new Error('no tts provider');
  }
}
