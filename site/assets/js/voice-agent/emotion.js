// Emotion + "human touch" for spoken replies.
// detectEmotion: picks a delivery style from the words (or a hint from the brain).
// humanize:      adds the small things people say on calls — openers, softeners,
//                breath pauses — sparingly, deterministic per text so it never loops.
// sentences:     splits text into speakable chunks for low-latency streaming.

export const EMOTIONS = ['neutral', 'friendly', 'cheerful', 'excited', 'calm', 'empathetic', 'urgent', 'thinking'];

const RULES = [
  ['urgent', /\b(packed|rush|hurry|now!|alert|warning|crowded|full|avoid|heads up)\b/i],
  ['empathetic', /\b(sorry|closed|unfortunately|can't|cannot|unavailable|failed|no luck|didn't catch)\b/i],
  ['excited', /\b(great news|amazing|awesome|wow)\b|!{2,}/i],
  ['cheerful', /\b(good news|quiet|empty|free|no wait|best time|go now|perfect|easy)\b/i],
  ['friendly', /\b(hi|hello|hey|thanks|welcome|anytime|bye)\b/i],
  ['calm', /\b(average|typically|usually|forecast|expected|around)\b/i],
];

export function detectEmotion(text, hint) {
  if (hint && EMOTIONS.includes(hint)) return hint;
  for (const [emotion, re] of RULES) if (re.test(text)) return emotion;
  return 'neutral';
}

function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

const OPENERS = {
  en: {
    cheerful: ['Good news!', 'Oh nice,', 'Alright,'],
    urgent: ['Heads up —', 'Okay, so,', 'Quick one —'],
    empathetic: ['Ah,', 'Hmm,', 'Sorry,'],
    calm: ['So,', 'Okay,', ''],
    friendly: ['', '', ''],
    neutral: ['', 'Okay,', 'So,'],
    excited: ['Oh wow,', 'Great news!', ''],
  },
};
const FILLERS = {
  en: ['Hmm, let me check.', 'One sec.', 'Let me see.', 'Okay, checking.'],
  hi: ['एक सेकंड।', 'देखती हूँ।'],
  ta: ['ஒரு நிமிடம்.', 'பார்க்கிறேன்.'],
  ml: ['ഒരു നിമിഷം.', 'നോക്കട്ടെ.'],
  kn: ['ಒಂದು ಕ್ಷಣ.', 'ನೋಡುತ್ತೇನೆ.'],
  te: ['ఒక్క క్షణం.', 'చూస్తాను.'],
};

/** Spoken-style rewrite: opener, pauses at dashes/colons, no symbols TTS reads badly. */
export function humanize(text, emotion = 'neutral', lang = 'en') {
  let out = String(text)
    .replace(/•\s*/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/(\d+)\s*%/g, '$1 percent')
    .replace(/~\s*(\d)/g, 'about $1')
    .replace(/\s+—\s+/g, ', ')
    .replace(/\.\s*\./g, '.')
    .trim();
  const pool = OPENERS[lang]?.[emotion];
  if (pool && !/^(hi|hello|hey|good news|okay|so|ah|hmm|sorry|heads up)/i.test(out)) {
    const opener = pool[Math.floor(seeded(out) * pool.length)];
    // Lowercase only a plain first word ("The", "It"), never a name ("Central Library").
    if (opener) out = `${opener} ${/^(The|It|There|This|That|You|Your|Its|A|An)\b/.test(out) ? out.charAt(0).toLowerCase() + out.slice(1) : out}`;
  }
  return out.replace(/([.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

export function filler(lang = 'en', n = 0) {
  const list = FILLERS[lang] || FILLERS.en;
  return list[n % list.length];
}

/** Split into speakable chunks (~sentence), merging very short ones. */
export function sentences(text, max = 220) {
  const parts = String(text).match(/[^.!?।؟]+[.!?।؟]+["')\]]*|[^.!?।؟]+$/g) || [text];
  const out = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (out.length && (out[out.length - 1].length < 12 || p.length < 10) && out[out.length - 1].length + p.length < max) out[out.length - 1] += ` ${p}`;
    else if (p.length > max) out.push(...p.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')).map((s) => s.trim()));
    else out.push(p);
  }
  return out;
}
