// Public runtime config. The deploy workflow rewrites this file from the
// repository variables SUPABASE_URL and SUPABASE_ANON_KEY (the anon key is
// public by design; row-level security protects the data). Empty = demo mode.
export const CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  // Optional cloud AI for open-ended questions (see supabase/functions/ask). Empty = on-device only.
  aiEndpoint: '',
  // Live database API (Vercel functions + Neon Postgres). Empty = demo mode.
  apiBase: 'https://rushcast-api.vercel.app',
  // Neural voice for calls and read-aloud (rush-voice-agent on Vercel, free).
  ttsEndpoint: 'https://rush-voice-agent.vercel.app/api/tts',
};
