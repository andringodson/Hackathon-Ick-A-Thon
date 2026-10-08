// rush-voice-agent — human-sounding, real-time voice calls for the web.
export { VoiceAgent } from './agent.js';
export { NeuralTTS, WebSpeechTTS, ChainTTS } from './tts.js';
export { listenOnce, startVAD, sttSupported } from './listen.js';
export { detectEmotion, humanize, sentences, filler, EMOTIONS } from './emotion.js';
export { ringtone, earcon } from './sounds.js';

/** One-liner: neural voice with browser fallback. */
import { NeuralTTS, WebSpeechTTS, ChainTTS } from './tts.js';
export function createTTS({ endpoint, gender, voice } = {}) {
  return new ChainTTS([endpoint ? new NeuralTTS({ endpoint, gender, voice }) : null, new WebSpeechTTS()]);
}
