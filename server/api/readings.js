// POST /api/readings  Authorization: Bearer INGEST_TOKEN
// Body: [{ facility_id, ts, devices, people }, …]  (from ingest/python or ingest/node)
// GET  /api/readings?days=70  (same auth) → history for the training pipeline.
import { FACILITY_RE, authorized, cors, readJson, send, sql } from './_lib.js';

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET') {
    const days = Math.min(120, Math.max(1, Number(new URL(req.url, 'http://x').searchParams.get('days')) || 70));
    const rows = await sql`select facility_id, ts, devices, people from readings where ts > now() - make_interval(days => ${days}) order by ts`;
    return send(res, 200, rows);
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });

  const body = await readJson(req);
  const rows = (Array.isArray(body) ? body : [body]).slice(0, 2000).filter((r) => FACILITY_RE.test(String(r.facility_id || '')) && !Number.isNaN(Date.parse(r.ts)) && r.devices >= 0 && r.people >= 0);
  if (!rows.length) return send(res, 400, { error: 'no_valid_rows' });
  await sql`insert into readings (facility_id, ts, devices, people)
    select * from unnest(${rows.map((r) => r.facility_id)}::text[], ${rows.map((r) => r.ts)}::timestamptz[], ${rows.map((r) => Math.round(r.devices))}::int[], ${rows.map((r) => Math.round(r.people))}::int[])
    on conflict (facility_id, ts) do update set devices = excluded.devices, people = excluded.people`;
  send(res, 200, { upserted: rows.length });
}
