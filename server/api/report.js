// POST /api/report { facility_id, level: 0|1|2, device_id: uuid } → 201 { id, created_at }
// The database trigger enforces 1 report / place / 3 min and 40 / hour per device → 429.
import { FACILITY_RE, UUID_RE, cors, readJson, send, sql } from './_lib.js';

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  const b = await readJson(req);
  const level = Number(b.level);
  if (!FACILITY_RE.test(String(b.facility_id || '')) || ![0, 1, 2].includes(level) || !UUID_RE.test(String(b.device_id || ''))) {
    return send(res, 400, { error: 'invalid_report' });
  }
  try {
    const [row] = await sql`insert into reports (facility_id, level, device_id) values (${b.facility_id}, ${level}, ${b.device_id}) returning id, created_at`;
    send(res, 201, row);
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('rate_limited')) return send(res, 429, { error: 'rate_limited' });
    send(res, 503, { error: 'db_unavailable' });
  }
}
