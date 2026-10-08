// GET /api/state → { reports: [...last 6 h], readings: [...latest per place, last 30 min], now }
// Device ids are never returned. Briefly CDN-cached so many open apps share one query.
import { cors, send, sql } from './_lib.js';

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  try {
    const [reports, readings] = await Promise.all([
      sql`select id, facility_id, level, created_at from reports where created_at > now() - interval '6 hours' order by created_at desc limit 2000`,
      sql`select distinct on (facility_id) facility_id, ts, devices, people from readings where ts > now() - interval '30 minutes' order by facility_id, ts desc`,
    ]);
    send(res, 200, { reports, readings, now: new Date().toISOString() }, { 'Cache-Control': 'public, s-maxage=3, stale-while-revalidate=10' });
  } catch (err) {
    send(res, 503, { error: 'db_unavailable', detail: String(err.message || err).slice(0, 120) });
  }
}
