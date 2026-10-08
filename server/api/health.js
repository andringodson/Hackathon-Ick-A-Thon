// GET /api/health → { ok, db_ms, reports_24h, readings_24h }
// POST /api/health with Bearer INGEST_TOKEN also prunes old rows (called every 6 h by CI).
import { authorized, cors, send, sql } from './_lib.js';

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  const t0 = Date.now();
  try {
    if (req.method === 'POST' && authorized(req)) {
      await sql`delete from reports where created_at < now() - interval '90 days'`;
      await sql`delete from readings where ts < now() - interval '120 days'`;
    }
    const [r] = await sql`select (select count(*) from reports where created_at > now() - interval '24 hours')::int as reports_24h,
                                 (select count(*) from readings where ts > now() - interval '24 hours')::int as readings_24h`;
    send(res, 200, { ok: true, db_ms: Date.now() - t0, ...r }, { 'Cache-Control': 'no-store' });
  } catch (err) {
    send(res, 503, { ok: false, error: String(err.message || err).slice(0, 120) });
  }
}
