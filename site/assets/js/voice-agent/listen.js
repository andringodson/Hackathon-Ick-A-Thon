// Listening: speech-to-text (browser SpeechRecognition) and a voice-activity
// detector (VAD) for barge-in — talking over the agent stops it mid-sentence,
// like a real phone call. The mic stream uses echo cancellation so the agent's
// own voice doesn't trigger the VAD.

const Rec = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
const FATAL = ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported'];
const LOCALES = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', ml: 'ml-IN', kn: 'kn-IN', te: 'te-IN', bn: 'bn-IN', mr: 'mr-IN', gu: 'gu-IN', ur: 'ur-IN' };

export const sttSupported = () => !!Rec;

/**
 * Listen for one utterance. Resolves { text, error }.
 * onInterim(text) streams partial transcripts for live captions.
 */
export function listenOnce({ lang = 'en', onInterim, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    if (!Rec) { resolve({ text: '', error: 'unsupported' }); return; }
    const rec = new Rec();
    rec.lang = LOCALES[lang] || lang;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let finalText = '';
    let error = null;
    let heard = false;
    const timer = setTimeout(() => { if (!heard) try { rec.stop(); } catch {} }, timeoutMs);
    rec.onresult = (ev) => {
      heard = true;
      const r = ev.results[ev.results.length - 1];
      onInterim?.(r[0].transcript, !r.isFinal);
      if (r.isFinal) finalText = r[0].transcript;
    };
    rec.onerror = (e) => { error = FATAL.includes(e.error) ? e.error : error; };
    rec.onend = () => { clearTimeout(timer); resolve({ text: finalText.trim(), error }); };
    listenOnce.current = rec;
    try { rec.start(); } catch { clearTimeout(timer); resolve({ text: '', error: 'start-failed' }); }
  });
}
listenOnce.abort = () => { try { listenOnce.current?.abort(); } catch {} };

/**
 * Energy VAD with an adaptive noise floor. Calls onSpeech() once speech has been
 * sustained for `minMs` (ignores coughs and clicks). Returns { stop }.
 */
export async function startVAD({ onSpeech, minMs = 260, sensitivity = 2.6 } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const src = ac.createMediaStreamSource(stream);
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let floor = 0.006;
  let above = 0;
  let last = performance.now();
  let raf = 0;
  let stopped = false;
  const loop = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const dt = now - last;
    last = now;
    if (rms > floor * sensitivity && rms > 0.012) {
      above += dt;
      if (above >= minMs) { above = 0; onSpeech?.(rms); }
    } else {
      above = Math.max(0, above - dt * 2);
      floor = floor * 0.98 + rms * 0.02; // adapt to the room
    }
  };
  raf = requestAnimationFrame(loop);
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      ac.close().catch(() => {});
    },
  };
}
