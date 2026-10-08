// Public runtime config. The deploy workflow rewrites this file from the
// repository variables SUPABASE_URL and SUPABASE_ANON_KEY (the anon key is
// public by design; row-level security protects the data). Empty = demo mode.
export const CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
