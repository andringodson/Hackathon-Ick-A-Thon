#!/usr/bin/env node
// Push Wi-Fi controller association counts into Rushcast (Node.js client).
//
// Same contract as ../python/ingest_wifi.py, for campuses that run Node:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node ingest-wifi.mjs --csv export.csv [--ap-map ../samples/ap-map.json] [--dry-run]
//
// Zero dependencies (Node 18+). Only aggregate counts are sent: no MACs, no users.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BUCKET_MIN = 5;
const DEFAULT_PEOPLE_PER_DEVICE = 0.72;
const IST_OFFSET = '+05:30';
const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    apMap: path.join(here, '..', 'samples', 'ap-map.json'),
    model: path.join(here, '..', '..', 'site', 'data', 'model.json'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--csv') args.csv = argv[++i];
    else if (flag === '--ap-map') args.apMap = argv[++i];
    else if (flag === '--model') args.model = argv[++i];
    else if (flag === '--dry-run') args.dryRun = true;
  }
  if (!args.csv) throw new Error('Missing --csv <controller export>');
  return args;
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = header.split(',').map((c) => c.trim());
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').trim()]));
  });
}

function bucketIso(ts) {
  const hasZone = /([zZ]|[+-]\d\d:?\d\d)$/.test(ts);
  const t = new Date(hasZone ? ts : ts + IST_OFFSET);
  if (Number.isNaN(t.getTime())) throw new Error(`Bad timestamp: ${ts}`);
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() - (t.getUTCMinutes() % BUCKET_MIN));
  return t.toISOString();
}

async function loadCalibration(modelPath) {
  try {
    const model = JSON.parse(await readFile(modelPath, 'utf8'));
    return Object.fromEntries(
      Object.entries(model.facilities ?? {})
        .filter(([, f]) => f.calibration?.people_per_device)
        .map(([id, f]) => [id, [f.calibration.people_per_device, f.calibration.offset ?? 0]]),
    );
  } catch {
    return {};
  }
}

export function aggregate(rows, apMap, calib) {
  const samples = new Map(); // facility|bucket|ap -> clients[]
  for (const row of rows) {
    const fid = apMap[row.ap_name];
    if (!fid) continue;
    const key = `${fid}|${bucketIso(row.timestamp)}|${row.ap_name}`;
    if (!samples.has(key)) samples.set(key, []);
    samples.get(key).push(Number(row.clients));
  }
  const perFacility = new Map(); // facility|bucket -> devices
  for (const [key, values] of samples) {
    const [fid, ts] = key.split('|');
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    perFacility.set(`${fid}|${ts}`, (perFacility.get(`${fid}|${ts}`) ?? 0) + avg);
  }
  return [...perFacility]
    .map(([key, devices]) => {
      const [facility_id, ts] = key.split('|');
      const [a, b] = calib[facility_id] ?? [DEFAULT_PEOPLE_PER_DEVICE, 0];
      return { facility_id, ts, devices: Math.round(devices), people: Math.max(0, Math.round(devices * a + b)) };
    })
    .sort((x, y) => x.ts.localeCompare(y.ts) || x.facility_id.localeCompare(y.facility_id));
}

async function upload(readings) {
  const { SUPABASE_URL: url, SUPABASE_SERVICE_KEY: key } = process.env;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY (service role, keep it server-side).');
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/readings`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(readings),
  });
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status} ${await res.text()}`);
  console.log(`Uploaded ${readings.length} readings (HTTP ${res.status})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apMap = JSON.parse(await readFile(args.apMap, 'utf8'));
  const rows = parseCsv(await readFile(args.csv, 'utf8'));
  const readings = aggregate(rows, apMap, await loadCalibration(args.model));
  if (!readings.length) throw new Error('No rows matched an access point in the AP map.');
  if (args.dryRun) console.log(JSON.stringify(readings, null, 2));
  else await upload(readings);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
