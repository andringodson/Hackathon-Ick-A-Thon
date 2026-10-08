// Data layer. Live mode = Supabase (Postgres + realtime). Demo mode = local
// reports synced across tabs, plus deterministic simulated community reports.

import { CONFIG } from './config.js';

const LOCAL_KEY = 'rc.reports';
const KEEP_MS = 6 * 3600000;
const COOLDOWN_MS = 3 * 60000;

function deviceId() {
  try {
    let id = localStorage.getItem('rc.device');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('rc.device', id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

class BaseStore {
  constructor(engine) {
    this.engine = engine;
    this.listeners = new Set();
    this.mine = this.loadLocal();
    engine.reportsFor = (id) => this.reportsFor(id);
  }
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(kind) {
    for (const fn of this.listeners) fn(kind);
  }
  loadLocal() {
    try {
      const rows = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
      return rows.map((r) => ({ ...r, at: new Date(r.at) })).filter((r) => Date.now() - r.at < KEEP_MS);
    } catch {
      return [];
    }
  }
  saveLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(this.mine));
    } catch {}
  }
  lastMine(facilityId) {
    return this.mine.filter((r) => r.facility_id === facilityId).sort((a, b) => b.at - a.at)[0] || null;
  }
  cooldownLeft(facilityId) {
    const last = this.lastMine(facilityId);
    return last ? Math.max(0, COOLDOWN_MS - (Date.now() - last.at)) : 0;
  }
  rememberMine(facilityId, level) {
    this.mine.push({ id: `me-${Date.now()}`, facility_id: facilityId, level, at: new Date(), mine: true });
    this.mine = this.mine.filter((r) => Date.now() - r.at < KEEP_MS);
    this.saveLocal();
  }
}

class DemoStore extends BaseStore {
  constructor(engine) {
    super(engine);
    this.mode = 'demo';
    try {
      this.channel = new BroadcastChannel('rushcast');
      this.channel.onmessage = () => {
        this.mine = this.loadLocal();
        this.emit('reports');
      };
    } catch {}
  }

  /** Simulated community: some 5-minute buckets carry a report near the sensor value. */
  community(facilityId, now = new Date()) {
    const fac = this.engine.byId.get(facilityId);
    const out = [];
    const bucketMs = 5 * 60000;
    const last = Math.floor(now.getTime() / bucketMs);
    for (let b = last; b > last - 9; b--) {
      const r = hash(`${facilityId}|r|${b}`);
      if (r > 0.3) continue;
      const at = new Date(b * bucketMs + hash(`${facilityId}|t|${b}`) * bucketMs);
      if (at > now || !this.engine.isOpen(fac, at)) continue;
      const v = this.engine.simSensor(fac, at) + (hash(`${facilityId}|v|${b}`) - 0.5) * 30;
      out.push({ id: `sim-${facilityId}-${b}`, facility_id: facilityId, level: v < 40 ? 0 : v < 75 ? 1 : 2, at });
    }
    return out;
  }

  reportsFor(facilityId) {
    return [...this.mine.filter((r) => r.facility_id === facilityId), ...this.community(facilityId)].sort((a, b) => b.at - a.at);
  }

  async submit(facilityId, level) {
    if (this.cooldownLeft(facilityId) > 0) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
    this.rememberMine(facilityId, level);
    this.channel?.postMessage('reports');
    this.emit('reports');
  }
}

class SupabaseStore extends BaseStore {
  constructor(engine, client) {
    super(engine);
    this.mode = 'live';
    this.client = client;
    this.remote = [];
    this.engine.simulateSensor = false;
  }

  async init() {
    const since = new Date(Date.now() - KEEP_MS).toISOString();
    const [reports, readings] = await Promise.all([
      this.client.from('recent_reports').select('id,facility_id,level,created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(2000),
      this.client.from('latest_readings').select('facility_id,ts,people'),
    ]);
    if (reports.error) throw reports.error;
    this.remote = reports.data.map((r) => ({ ...r, at: new Date(r.created_at) }));
    // Without any recent sensor feed, fall back to simulated readings so the board is never blank.
    if (readings.error || !readings.data.length) this.engine.simulateSensor = true;
    for (const r of readings.data || []) this.engine.readings.set(r.facility_id, { people: r.people, ts: new Date(r.ts) });

    this.client
      .channel('rushcast-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reports' }, ({ new: r }) => {
        if (!this.remote.some((x) => x.id === r.id)) this.remote.unshift({ id: r.id, facility_id: r.facility_id, level: r.level, at: new Date(r.created_at) });
        this.emit('reports');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'readings' }, ({ new: r }) => {
        if (!r?.facility_id) return;
        this.engine.readings.set(r.facility_id, { people: r.people, ts: new Date(r.ts) });
        this.engine.simulateSensor = false;
        this.emit('readings');
      })
      .subscribe();
    return this;
  }

  reportsFor(facilityId) {
    const cutoff = Date.now() - KEEP_MS;
    this.remote = this.remote.filter((r) => r.at > cutoff);
    const mineIds = new Set(this.mine.map((r) => r.remoteId).filter(Boolean));
    return [
      ...this.mine.filter((r) => r.facility_id === facilityId),
      ...this.remote.filter((r) => r.facility_id === facilityId && !mineIds.has(r.id)),
    ].sort((a, b) => b.at - a.at);
  }

  async submit(facilityId, level) {
    if (this.cooldownLeft(facilityId) > 0) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
    const { error } = await this.client.from('reports').insert({ facility_id: facilityId, level, device_id: deviceId() });
    if (error) {
      const limited = /rate_limited/.test(error.message || '');
      throw Object.assign(new Error(error.message), { code: limited ? 'rate_limited' : 'failed' });
    }
    this.rememberMine(facilityId, level);
    this.emit('reports');
  }
}

/** Live mode on the Rushcast API (Vercel functions + Neon Postgres, both free). */
class ApiStore extends BaseStore {
  constructor(engine, base) {
    super(engine);
    this.mode = 'live';
    this.base = base.replace(/\/$/, '');
    this.remote = [];
    this.timer = 0;
  }

  async pull() {
    const res = await fetch(`${this.base}/api/state`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`state ${res.status}`);
    const data = await res.json();
    const before = this.remote.length && this.remote[0].id;
    this.remote = data.reports.map((r) => ({ id: r.id, facility_id: r.facility_id, level: r.level, at: new Date(r.created_at) }));
    this.engine.readings.clear();
    for (const r of data.readings) this.engine.readings.set(r.facility_id, { people: r.people, ts: new Date(r.ts) });
    // Real sensor feed when present; otherwise keep the simulated sensor so the board is never blank.
    this.engine.simulateSensor = !data.readings.length;
    if (before !== (this.remote[0] && this.remote[0].id)) this.emit('reports');
  }

  async init() {
    await this.pull();
    const loop = async () => {
      if (!document.hidden) await this.pull().catch(() => {});
      this.timer = setTimeout(loop, 8000);
    };
    this.timer = setTimeout(loop, 8000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.pull().catch(() => {}); });
    return this;
  }

  reportsFor(facilityId) {
    const cutoff = Date.now() - KEEP_MS;
    const mine = this.mine.filter((r) => r.facility_id === facilityId);
    const remote = this.remote.filter((r) => r.facility_id === facilityId && r.at > cutoff && !mine.some((m) => m.remoteId === r.id));
    return [...mine, ...remote].sort((a, b) => b.at - a.at);
  }

  async submit(facilityId, level) {
    if (this.cooldownLeft(facilityId) > 0) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' });
    const res = await fetch(`${this.base}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility_id: facilityId, level, device_id: deviceId() }),
    }).catch(() => null);
    if (!res || !res.ok) throw Object.assign(new Error('report failed'), { code: res && res.status === 429 ? 'rate_limited' : 'failed' });
    const row = await res.json();
    this.rememberMine(facilityId, level);
    this.mine[this.mine.length - 1].remoteId = row.id;
    this.saveLocal();
    this.emit('reports');
  }
}

export async function createStore(engine) {
  if (!CONFIG.supabaseUrl && CONFIG.apiBase) {
    try {
      return await new ApiStore(engine, CONFIG.apiBase).init();
    } catch (err) {
      console.warn('Rushcast API unavailable, using demo data:', err);
    }
  }
  if (CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) {
    try {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      const client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 5 } },
      });
      return await new SupabaseStore(engine, client).init();
    } catch (err) {
      console.warn('Supabase unavailable, using demo data:', err);
    }
  }
  return new DemoStore(engine);
}
