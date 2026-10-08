"""Push Wi-Fi controller association counts into Rushcast (Python client).

Reads a controller export (CSV: timestamp,ap_name,clients), maps each access
point to a facility, averages clients per AP inside 5-minute buckets, sums APs
per facility, converts devices to people with the calibrated ratio, and
upserts rows into the Supabase `readings` table.

    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
    python ingest_wifi.py --csv export.csv --ap-map ../samples/ap-map.json

Use --dry-run to print the rows instead of uploading. Standard library only.
Only aggregate counts leave the campus network: no MAC addresses, no users.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

BUCKET_MIN = 5
DEFAULT_PEOPLE_PER_DEVICE = 0.72


def bucket(ts: str) -> dt.datetime:
    t = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone(dt.timedelta(hours=5, minutes=30)))  # campus local time
    return t.replace(minute=t.minute - t.minute % BUCKET_MIN, second=0, microsecond=0)


def load_calibration(model_path: Path | None) -> dict[str, tuple[float, float]]:
    if not model_path or not model_path.exists():
        return {}
    model = json.loads(model_path.read_text(encoding="utf-8"))
    out = {}
    for fid, fac in model.get("facilities", {}).items():
        cal = fac.get("calibration") or {}
        if "people_per_device" in cal:
            out[fid] = (cal["people_per_device"], cal.get("offset", 0.0))
    return out


def aggregate(rows, ap_map: dict[str, str], calib) -> list[dict]:
    samples: dict[tuple[str, dt.datetime, str], list[int]] = defaultdict(list)
    for row in rows:
        fid = ap_map.get(row["ap_name"].strip())
        if fid:
            samples[(fid, bucket(row["timestamp"]), row["ap_name"])].append(int(row["clients"]))
    per_facility: dict[tuple[str, dt.datetime], float] = defaultdict(float)
    for (fid, ts, _ap), values in samples.items():
        per_facility[(fid, ts)] += sum(values) / len(values)
    readings = []
    for (fid, ts), devices in sorted(per_facility.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        a, b = calib.get(fid, (DEFAULT_PEOPLE_PER_DEVICE, 0.0))
        readings.append({
            "facility_id": fid,
            "ts": ts.isoformat(),
            "devices": round(devices),
            "people": max(0, round(devices * a + b)),
        })
    return readings


def upload_api(readings: list[dict]) -> bool:
    """Rushcast API (Vercel + Neon): RUSHCAST_API + INGEST_TOKEN."""
    api, token = os.environ.get("RUSHCAST_API"), os.environ.get("INGEST_TOKEN")
    if not api or not token:
        return False
    req = urllib.request.Request(
        f"{api.rstrip('/')}/api/readings",
        data=json.dumps(readings).encode(),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(f"Uploaded {len(readings)} readings to {api} (HTTP {resp.status})")
    return True


def upload(readings: list[dict]) -> None:
    if upload_api(readings):
        return
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("Set RUSHCAST_API + INGEST_TOKEN (Rushcast API), or SUPABASE_URL + SUPABASE_SERVICE_KEY.")
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/readings",
        data=json.dumps(readings).encode(),
        method="POST",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(f"Uploaded {len(readings)} readings (HTTP {resp.status})")


def main() -> None:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Upload Wi-Fi association counts to Rushcast")
    parser.add_argument("--csv", required=True, help="controller export: timestamp,ap_name,clients")
    parser.add_argument("--ap-map", default=str(here.parent / "samples" / "ap-map.json"))
    parser.add_argument("--model", default=str(here.parent.parent / "site" / "data" / "model.json"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    ap_map = json.loads(Path(args.ap_map).read_text(encoding="utf-8"))
    with open(args.csv, newline="", encoding="utf-8") as fh:
        readings = aggregate(csv.DictReader(fh), ap_map, load_calibration(Path(args.model)))
    if not readings:
        sys.exit("No rows matched an access point in the AP map.")
    if args.dry_run:
        print(json.dumps(readings, indent=2))
    else:
        upload(readings)


if __name__ == "__main__":
    main()
