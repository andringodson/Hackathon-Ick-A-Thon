// Shared helpers for the Rushcast API (Vercel functions + Neon Postgres).
import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL);

const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://andringodson.github.io').split(',').map((s) => s.trim());

export function cors(req, res) {
  const origin = req.headers.origin || '';
  const ok = !origin || ORIGINS.includes(origin) || ORIGINS.includes('*') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (origin && ok) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return false;
  }
  if (!ok) {
    send(res, 403, { error: 'origin_not_allowed' });
    return false;
  }
  return true;
}

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

/** Server-to-server calls (ingest, prune) carry Authorization: Bearer INGEST_TOKEN. */
export function authorized(req) {
  const token = process.env.INGEST_TOKEN;
  return !!token && req.headers.authorization === `Bearer ${token}`;
}

export const FACILITY_RE = /^[a-z0-9-]{2,32}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
