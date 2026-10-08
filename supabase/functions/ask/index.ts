// Optional cloud tier for Rush AI: a Supabase Edge Function that answers
// open-ended questions with a hosted model, grounded in the live snapshot the
// app sends. The app works fully without it (on-device intent engine).
//
// Deploy:  supabase functions deploy ask --no-verify-jwt
// Secrets: supabase secrets set GEMINI_API_KEY=...   (Google AI Studio key)
//          optional GEMINI_MODEL (defaults below)
// Then set CONFIG.aiEndpoint (repo variable AI_ENDPOINT) to
//          https://<project>.supabase.co/functions/v1/ask

const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash';
const KEY = Deno.env.get('GEMINI_API_KEY');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST' || !KEY) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: CORS });

  let body: { question?: string; context?: string; lang?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad_json' }), { status: 400, headers: CORS });
  }
  const question = String(body.question ?? '').slice(0, 500);
  const context = String(body.context ?? '').slice(0, 4000);
  const lang = String(body.lang ?? 'English').slice(0, 40);
  if (!question.trim()) return new Response(JSON.stringify({ error: 'empty' }), { status: 400, headers: CORS });

  const system = `You are Rush, the assistant inside Rushcast, a campus crowd predictor for an Indian engineering college. Answer in ${lang}, in at most 3 short sentences, using ONLY the live data provided. If the data does not answer the question, say so briefly. Never invent places or numbers.`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: `Live campus data:\n${context}\n\nQuestion: ${question}` }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 220 },
    }),
  });
  if (!res.ok) return new Response(JSON.stringify({ error: `model_${res.status}` }), { status: 502, headers: CORS });
  const data = await res.json();
  const answer = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('').trim();
  return new Response(JSON.stringify({ answer: answer || null }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
});
