// Forecast engine: turns the trained model + live signals into crowd levels,
// wait times, nowcasts and recommendations. Pure functions over campus time (IST).

const IST_MS = 330 * 60000;
const Z80 = 1.2816;
const REPORT_VALUE = [15, 55, 88]; // empty / moderate / crowded -> occupancy %
const REPORT_WINDOW_MIN = 45;
const NOWCAST_DECAY_MIN = 90;

export const LEVELS = ['quiet', 'moderate', 'packed'];

export function levelOf(pct) {
  if (pct < 40) return 'quiet';
  if (pct < 75) return 'moderate';
  return 'packed';
}

export function campusParts(date) {
  const ist = new Date(date.getTime() + IST_MS);
  return {
    day: (ist.getUTCDay() + 6) % 7, // 0 = Monday
    hour: ist.getUTCHours() + ist.getUTCMinutes() / 60 + ist.getUTCSeconds() / 3600,
    dateKey: ist.toISOString().slice(0, 10),
  };
}

/** Date at a campus-local hour on the same campus day as `date`. */
export function atCampusHour(date, hour) {
  const ist = new Date(date.getTime() + IST_MS);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MS;
  return new Date(midnight + hour * 3600000);
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dayType = (d) => (d < 5 ? 'weekday' : d === 5 ? 'saturday' : 'sunday');

export class Engine {
  constructor(catalog, model) {
    this.catalog = catalog;
    this.model = model;
    this.facilities = catalog.facilities;
    this.byId = new Map(this.facilities.map((f) => [f.id, f]));
    this.readings = new Map(); // facility -> { people, ts }
    this.reportsFor = () => [];
    this.simulateSensor = true;
    this.overrides = new Map(); // facility -> { pct, until } (live-session rush demo)
  }

  static async load(base) {
    const [catalog, model] = await Promise.all(
      ['facilities.json', 'model.json'].map((f) => fetch(new URL(f, base)).then((r) => {
        if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
        return r.json();
      })),
    );
    return new Engine(catalog, model);
  }

  // ---------- calendar & hours ----------
  event(date) {
    const key = campusParts(date).dateKey;
    return this.catalog.calendar?.find((e) => e.from <= key && key <= e.to) || null;
  }

  isOpen(fac, date) {
    const { day, hour } = campusParts(date);
    return (fac.hours[dayType(day)] || []).some(([a, b]) => hour >= a && hour < b);
  }

  /** Next open/close transition, scanning forward in 5-minute steps. */
  nextChange(fac, date) {
    const open = this.isOpen(fac, date);
    const step = 5 * 60000;
    const t0 = Math.ceil(date.getTime() / step) * step;
    for (let t = t0; t < t0 + 8 * 86400000; t += step) {
      const d = new Date(t);
      if (this.isOpen(fac, d) !== open) {
        return { open, at: d, sameDay: campusParts(d).dateKey === campusParts(date).dateKey };
      }
    }
    return { open, at: null, sameDay: false };
  }

  dayWindow(fac, date) {
    const ranges = fac.hours[dayType(campusParts(date).day)] || [];
    if (!ranges.length) return null;
    return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
  }

  // ---------- model ----------
  effect(fac, date) {
    const ev = this.event(date);
    if (!ev) return 1;
    return this.model.facilities[fac.id]?.effects?.[ev.type] ?? 1;
  }

  /** Typical occupancy (%) and spread from the model, with calendar effect. */
  typical(fac, date) {
    const m = this.model.facilities[fac.id];
    if (!m || !this.isOpen(fac, date)) return { mean: 0, spread: 0 };
    const { day, hour } = campusParts(date);
    const pos = (hour * 60) / this.model.slot_minutes - 0.5;
    const i = clamp(Math.floor(pos), 0, m.mean[day].length - 1);
    const j = clamp(i + 1, 0, m.mean[day].length - 1);
    const f = clamp(pos - i, 0, 1);
    const lerp = (arr) => arr[day][i] * (1 - f) + arr[day][j] * f;
    const k = this.effect(fac, date);
    return { mean: clamp(lerp(m.mean) * k, 0, 100), spread: Math.max(2, lerp(m.spread) * k) };
  }

  /** Simulated Wi-Fi sensor for demo mode: deterministic, so every device agrees. */
  simSensor(fac, date) {
    if (!this.isOpen(fac, date)) return 0;
    const typ = this.typical(fac, date).mean;
    const { dateKey } = campusParts(date);
    const seed = hash(fac.id + dateKey);
    const minute = date.getTime() / 60000;
    const bucket = Math.floor(minute / 5);
    const frac = minute / 5 - bucket;
    const jitter = (hash(`${fac.id}:${bucket}`) * (1 - frac) + hash(`${fac.id}:${bucket + 1}`) * frac - 0.5) * 0.06;
    const wave = 0.07 * Math.sin((minute / 47) * Math.PI * 2 + seed * 6.28) + 0.045 * Math.sin((minute / 13) * Math.PI * 2 + seed * 12.1);
    const bias = (hash(`${fac.id}${dateKey}b`) - 0.5) * 0.16;
    return clamp(typ * (1 + wave + bias + jitter) + 3 * wave, 0, 100);
  }

  sensor(fac, date) {
    const r = this.readings.get(fac.id);
    if (r && Math.abs(date - r.ts) < 20 * 60000) return { pct: clamp((r.people / fac.capacity) * 100, 0, 100), kind: 'live' };
    if (this.simulateSensor) return { pct: this.simSensor(fac, date), kind: 'sim' };
    return null;
  }

  /** Live estimate: sensor blended with recency-weighted crowd reports. */
  estimate(fac, date = new Date()) {
    if (!this.isOpen(fac, date)) return { open: false, pct: 0, level: 'closed', reports: 0, confidence: 'high' };
    const sensor = this.sensor(fac, date);
    const typ = this.typical(fac, date);
    const base = sensor ? sensor.pct : typ.mean;
    const wBase = sensor ? 1 : 0.4;
    let num = wBase * base;
    let den = wBase;
    let disagreement = 0;
    const reports = this.reportsFor(fac.id).filter((r) => date - r.at < REPORT_WINDOW_MIN * 60000 && r.at <= date);
    for (const r of reports) {
      const age = (date - r.at) / 60000;
      const w = 0.5 * Math.exp(-age / 20);
      const v = REPORT_VALUE[r.level];
      num += w * v;
      den += w;
      disagreement += Math.abs(v - base);
    }
    let pct = clamp(num / den, 0, 100);
    const ov = this.overrides.get(fac.id);
    if (ov && ov.until > date.getTime()) pct = Math.max(pct, ov.pct);
    const avgGap = reports.length ? disagreement / reports.length : 0;
    const confidence = !sensor && !reports.length ? 'low' : avgGap > 35 || !sensor ? 'medium' : 'high';
    return { open: true, pct, level: levelOf(pct), reports: reports.length, confidence, typical: typ.mean };
  }

  /** Nowcast: typical curve + current deviation that decays over ~90 minutes. */
  forecast(fac, from = new Date(), hours = 3, stepMin = 15) {
    const now = this.estimate(fac, from);
    const delta = now.open ? now.pct - this.typical(fac, from).mean : 0;
    const points = [];
    for (let m = 0; m <= hours * 60; m += stepMin) {
      const t = new Date(from.getTime() + m * 60000);
      if (!this.isOpen(fac, t)) {
        points.push({ t, closed: true });
        continue;
      }
      const typ = this.typical(fac, t);
      const pct = m === 0 && now.open ? now.pct : clamp(typ.mean + delta * Math.exp(-m / NOWCAST_DECAY_MIN), 0, 100);
      const half = Z80 * typ.spread * (1 + m / 180);
      points.push({ t, pct, lo: clamp(pct - half, 0, 100), hi: clamp(pct + half, 0, 100), typical: typ.mean });
    }
    return points;
  }

  at(fac, date, now = new Date()) {
    if (Math.abs(date - now) < 60000) return this.estimate(fac, now);
    const p = this.forecast(fac, now, Math.max(0.25, (date - now) / 3600000), Math.max(1, (date - now) / 60000)).at(-1);
    return p.closed ? { open: false, pct: 0, level: 'closed' } : { open: true, pct: p.pct, level: levelOf(p.pct) };
  }

  /** Queue wait (Little's law) or free space, from occupancy %. */
  capacityInfo(fac, pct) {
    if (fac.metric === 'seats') {
      return { kind: fac.category === 'fitness' ? 'spots' : 'seats', n: Math.max(0, Math.round(fac.capacity * (1 - pct / 100))) };
    }
    const u = pct / 100;
    const share = fac.queueShare ?? (fac.category === 'services' ? 0.85 : 0.3);
    const queue = fac.capacity * u * share * (0.25 + 0.75 * u * u);
    const minutes = (queue * fac.serviceMin) / fac.servers;
    return { kind: 'wait', n: minutes < 1 ? 0 : Math.round(minutes) };
  }

  bestTime(fac, from = new Date(), hours = 4) {
    const pts = this.forecast(fac, from, hours, 15).filter((p) => !p.closed);
    if (!pts.length) return null;
    const best = pts.reduce((a, b) => (b.pct < a.pct - 0.5 ? b : a));
    const isNow = best.t - from < 60000 || best.pct >= pts[0].pct - 3;
    return { t: isNow ? from : best.t, pct: isNow ? pts[0].pct : best.pct, now: isNow };
  }

  trend(fac, from = new Date()) {
    const pts = this.forecast(fac, from, 0.5, 30);
    if (pts.length < 2 || pts[0].closed || pts[1].closed) return 'steady';
    const diff = pts[1].pct - pts[0].pct;
    return diff > 5 ? 'rising' : diff < -5 ? 'falling' : 'steady';
  }

  /** Biggest predicted peak in the next `hours` for every open facility. */
  upcomingPeaks(from = new Date(), hours = 3, threshold = 70) {
    const out = [];
    for (const fac of this.facilities) {
      const pts = this.forecast(fac, from, hours, 15).filter((p) => !p.closed);
      if (!pts.length) continue;
      const peak = pts.reduce((a, b) => (b.pct > a.pct ? b : a));
      if (peak.pct >= threshold && peak.t - from > 10 * 60000) {
        const before = pts.filter((p) => p.t < peak.t && p.pct < 60).at(-1);
        out.push({ fac, t: peak.t, pct: peak.pct, goBefore: before?.t ?? null });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /** Full-day curve for charts: typical band for the whole day, live path up to now. */
  dayCurve(fac, now = new Date(), stepMin = 10) {
    const win = this.dayWindow(fac, now);
    if (!win) return null;
    const start = atCampusHour(now, Math.floor(win[0]));
    const end = atCampusHour(now, Math.ceil(win[1]));
    const typical = [];
    const live = [];
    for (let t = start.getTime(); t <= end.getTime(); t += stepMin * 60000) {
      const d = new Date(t);
      const open = this.isOpen(fac, d);
      const typ = this.typical(fac, d);
      typical.push({ t: d, open, mean: typ.mean, lo: clamp(typ.mean - Z80 * typ.spread, 0, 100), hi: clamp(typ.mean + Z80 * typ.spread, 0, 100) });
      if (d <= now && this.simulateSensor) live.push({ t: d, open, pct: open ? this.simSensor(fac, d) : 0 });
    }
    const cast = this.forecast(fac, now, 3, stepMin).filter((p) => p.t <= end);
    return { start, end, typical, live, cast };
  }

  /** Average occupancy per weekday x hour (for heatmaps). */
  weekGrid(fac, fromHour = 6, toHour = 22) {
    const m = this.model.facilities[fac.id];
    const per = 60 / this.model.slot_minutes;
    return Array.from({ length: 7 }, (_, d) => {
      const ranges = fac.hours[dayType(d)] || [];
      return Array.from({ length: toHour - fromHour }, (_, k) => {
        const h = fromHour + k;
        const open = ranges.some(([a, b]) => h + 0.5 >= a && h + 0.5 < b);
        const slots = m.mean[d].slice(h * per, (h + 1) * per);
        return open ? slots.reduce((a, b) => a + b, 0) / slots.length : null;
      });
    });
  }
}
