// Call sounds synthesized with Web Audio (no files): a phone-style ringtone and
// short earcons for connect / listen / hang-up.

let ac = null;
const ctx = () => {
  ac ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
};

function tone(freqs, start, dur, gain = 0.07) {
  const a = ctx();
  const g = a.createGain();
  const t0 = a.currentTime + start;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.setValueAtTime(gain, t0 + dur - 0.04);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  g.connect(a.destination);
  for (const f of freqs) {
    const o = a.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
}

/** Starts a ringing pattern (with vibration on phones). Returns stop(). */
export function ringtone() {
  const burst = () => {
    try { tone([523.25, 659.25], 0, 0.35); tone([587.33, 783.99], 0.45, 0.35); } catch {}
    try { navigator.vibrate?.([400, 200, 400]); } catch {}
  };
  burst();
  const id = setInterval(burst, 2200);
  return () => { clearInterval(id); try { navigator.vibrate?.(0); } catch {} };
}

export function earcon(kind = 'connect') {
  try {
    if (kind === 'connect') { tone([880], 0, 0.09, 0.05); tone([1175], 0.1, 0.09, 0.05); }
    if (kind === 'listen') tone([988], 0, 0.06, 0.035);
    if (kind === 'hangup') { tone([660], 0, 0.1, 0.05); tone([523], 0.11, 0.12, 0.05); }
  } catch {}
}
