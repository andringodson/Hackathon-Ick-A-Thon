"""Rushcast processing layer.

Builds the crowd-forecast model that the web app serves as `data/model.json`.

Pipeline
--------
1. Ingest occupancy history per facility at 15-minute resolution.
   * If SUPABASE_URL + SUPABASE_SERVICE_KEY are set and a facility has at least
     two weeks of real readings in the `readings` table, those are used.
   * Otherwise a realistic synthetic history is generated from the facility
     catalogue (timetable-driven peaks, deadline/exam weeks, Wi-Fi noise).
2. Convert Wi-Fi device counts to people with a per-facility devices-per-person
   ratio calibrated against manual headcount audits (least squares).
3. Fit a recency-weighted seasonal profile (weekday x 15-min slot) with a
   per-slot spread, smoothed across neighbouring slots.
4. Backtest on the last two weeks against a naive "same slot last week"
   baseline, and measure how often reality lands inside the p10-p90 band.

Only numpy is required, so it runs in a few seconds inside GitHub Actions.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

SLOT_MIN = 15
SLOTS = 24 * 60 // SLOT_MIN  # 96 slots per day
DAYS = 7
WEEKS = 10
TEST_WEEKS = 2
DECAY = 0.85  # default weight multiplier per week of age
# Hyper-parameters, auto-tuned per facility on every run (walk-forward validation).
PARAMS = {"decay": DECAY, "kernel": 5}
GRID = [{"decay": d, "kernel": k} for d in (0.7, 0.8, 0.85, 0.9, 0.95) for k in (3, 5, 7)]
Z80 = 1.2816  # p10-p90 half width in standard deviations

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "site" / "data" / "facilities.json"


def day_type(d: int) -> str:
    return "weekday" if d < 5 else ("saturday" if d == 5 else "sunday")


def open_mask(fac: dict, d: int) -> np.ndarray:
    hours = np.arange(SLOTS) * SLOT_MIN / 60 + SLOT_MIN / 120  # slot centre
    mask = np.zeros(SLOTS, dtype=bool)
    for start, end in fac["hours"].get(day_type(d), []):
        mask |= (hours >= start) & (hours < end)
    return mask


def base_curve(fac: dict, d: int) -> np.ndarray:
    """Typical occupancy fraction for one day, from the timetable peaks."""
    hours = np.arange(SLOTS) * SLOT_MIN / 60 + SLOT_MIN / 120
    curve = np.full(SLOTS, fac.get("base", 0.05))
    for centre, width, amp in fac["peaks"].get(day_type(d), []):
        curve += amp * np.exp(-0.5 * ((hours - centre) / width) ** 2)
    return np.clip(curve, 0, 1) * open_mask(fac, d)


# --------------------------------------------------------------------------
# Synthetic telemetry (stands in for Wi-Fi controller exports in the demo)
# --------------------------------------------------------------------------

NORMAL, DEADLINE, EXAM = 0, 1, 2
FLAG_NAMES = {DEADLINE: "deadline", EXAM: "exam"}


def history_flags() -> np.ndarray:
    """Academic-calendar flag per (week, day). Known in advance, so usable as a regressor."""
    flags = np.zeros((WEEKS, DAYS), dtype=int)
    for w in (2, 6, 8):  # assignment submission weeks: Thu + Fri rush
        flags[w, 3:5] = DEADLINE
    for w in (4, 9):  # mid-semester and end-semester exam preparation
        flags[w, :] = EXAM
    return flags


def synth_history(fac: dict, rng: np.random.Generator, flags: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (devices, people) arrays shaped (WEEKS, DAYS, SLOTS)."""
    cap = fac["capacity"]
    sens = fac.get("sensitivity", {})
    people = np.zeros((WEEKS, DAYS, SLOTS))
    for w in range(WEEKS):
        for d in range(DAYS):
            curve = base_curve(fac, d)
            factor = rng.normal(1.0, 0.07)
            if flags[w, d] == DEADLINE:
                factor *= 1 + sens.get("deadline", 0)
            elif flags[w, d] == EXAM:
                factor *= 1 + sens.get("exam", 0)
            # Slow drift within the day (weather, events) + slot-level noise.
            drift = 1 + 0.08 * np.sin(np.linspace(0, math.tau, SLOTS) + rng.uniform(0, math.tau))
            noise = rng.lognormal(0, 0.09, SLOTS)
            expected = np.clip(curve * factor * drift * noise, 0, 1.05) * cap
            people[w, d] = rng.poisson(expected) * open_mask(fac, d)
    ratio = rng.uniform(1.25, 1.55)  # phones + laptops + watches per person
    leakage = rng.poisson(0.04 * cap, people.shape)  # walkway devices bleeding in
    devices = np.round(people * ratio + leakage)
    return devices, people


def calibrate(devices: np.ndarray, people: np.ndarray, rng: np.random.Generator) -> tuple[float, float]:
    """Fit people ~ a * devices + b from 40 manual headcount audits."""
    flat_d, flat_p = devices.ravel(), people.ravel()
    idx = np.flatnonzero(flat_p > 0)
    pick = rng.choice(idx, size=min(40, idx.size), replace=False)
    a, b = np.polyfit(flat_d[pick], flat_p[pick], 1)
    return float(a), float(b)


# --------------------------------------------------------------------------
# Optional: real readings from Supabase
# --------------------------------------------------------------------------

def fetch_real(fac_id: str, cap: int) -> np.ndarray | None:
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        return None
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(weeks=WEEKS)).isoformat()
    query = urllib.parse.urlencode({
        "select": "ts,people",
        "facility_id": f"eq.{fac_id}",
        "ts": f"gte.{since}",
        "order": "ts.asc",
        "limit": "100000",
    })
    req = urllib.request.Request(
        f"{url.rstrip('/')}/rest/v1/readings?{query}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            rows = json.load(resp)
    except Exception as exc:  # network or auth problems fall back to synthetic
        print(f"  ! supabase fetch failed for {fac_id}: {exc}")
        return None
    if len(rows) < 14 * 24 * 2:
        return None
    ist = dt.timezone(dt.timedelta(hours=5, minutes=30))
    latest = dt.datetime.fromisoformat(rows[-1]["ts"].replace("Z", "+00:00")).astimezone(ist)
    week0 = (latest - dt.timedelta(days=latest.weekday(), weeks=WEEKS - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    grid = np.full((WEEKS, DAYS, SLOTS), np.nan)
    for row in rows:
        t = dt.datetime.fromisoformat(row["ts"].replace("Z", "+00:00")).astimezone(ist)
        delta = t - week0
        w, d = delta.days // 7, delta.days % 7
        s = (t.hour * 60 + t.minute) // SLOT_MIN
        if 0 <= w < WEEKS:
            grid[w, d, s] = row["people"]
    return np.clip(grid / cap, 0, 1.2)


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------

def smooth(x: np.ndarray) -> np.ndarray:
    k = PARAMS["kernel"]
    half = k // 2
    kernel = np.array([min(i + 1, k - i) for i in range(k)], dtype=float)  # triangular
    kernel /= kernel.sum()
    return np.convolve(np.pad(x, half, mode="edge"), kernel, mode="valid")


def profile(frac: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Recency-weighted mean and spread per (day, slot). frac: (W, D, S), NaN = missing."""
    weights = PARAMS["decay"] ** np.arange(frac.shape[0])[::-1]
    valid = ~np.isnan(frac)
    wts = weights[:, None, None] * valid
    data = np.nan_to_num(frac)
    total = wts.sum(0)
    mean = np.divide((wts * data).sum(0), total, out=np.zeros_like(total), where=total > 0)
    var = np.divide((wts * (data - mean) ** 2).sum(0), total, out=np.zeros_like(total), where=total > 0)
    std = np.sqrt(var)
    for d in range(DAYS):
        mean[d] = smooth(mean[d]) * mask[d]
        std[d] = np.maximum(smooth(std[d]), 0.03) * mask[d]
    return mean, std


def fit_raw(frac: np.ndarray, mask: np.ndarray, flags: np.ndarray) -> dict:
    """Profile from normal days only, plus a multiplier per calendar flag."""
    normal = np.where((flags == NORMAL)[:, :, None], frac, np.nan)
    mean, std = profile(normal, mask)
    effects = {}
    for flag, name in FLAG_NAMES.items():
        weeks, days = np.nonzero(flags == flag)
        actual = sum(np.nansum(frac[w, d] * mask[d]) for w, d in zip(weeks, days))
        expected = sum(np.sum(mean[d] * mask[d]) for d in days)
        effects[name] = float(np.clip(actual / expected, 0.5, 2.0)) if expected > 0 else 1.0
    return {"mean": mean, "std": std, "effects": effects}


def predict(model: dict, d: int, flag: int) -> np.ndarray:
    factor = model["effects"].get(FLAG_NAMES.get(flag, ""), 1.0)
    return np.clip(model["mean"][d] * factor, 0, 1)


def fit(frac: np.ndarray, mask: np.ndarray, flags: np.ndarray) -> dict:
    """fit_raw + split-conformal band calibration on the most recent week."""
    held = fit_raw(frac[:-1], mask, flags[:-1])
    ratios = []
    for d in range(DAYS):
        actual, sel = frac[-1, d], mask[d] & ~np.isnan(frac[-1, d])
        ratios.append(np.abs(actual[sel] - predict(held, d, flags[-1, d])[sel]) / held["std"][d][sel])
    ratios = np.concatenate(ratios)
    scale = float(np.clip(np.quantile(ratios, 0.8) / Z80, 0.8, 3.0)) if ratios.size else 1.0
    model = fit_raw(frac, mask, flags)
    model["std"] = model["std"] * scale
    model["band_scale"] = scale
    return model


def backtest(frac: np.ndarray, mask: np.ndarray, flags: np.ndarray) -> dict:
    model = fit(frac[:-TEST_WEEKS], mask, flags[:-TEST_WEEKS])
    errs, naive_errs, inside = [], [], []
    n = frac.shape[0]
    for k in range(n - TEST_WEEKS, n):
        for d in range(DAYS):
            actual, prev = frac[k, d], frac[k - 1, d]
            sel = mask[d] & ~np.isnan(actual) & ~np.isnan(prev)
            pred = predict(model, d, flags[k, d])
            errs.append(np.abs(pred[sel] - actual[sel]))
            naive_errs.append(np.abs(prev[sel] - actual[sel]))
            inside.append(np.abs(actual[sel] - pred[sel]) <= Z80 * model["std"][d][sel])
    mae = float(np.concatenate(errs).mean() * 100)
    naive = float(np.concatenate(naive_errs).mean() * 100)
    return {
        "mae": round(mae, 2),
        "naive_mae": round(naive, 2),
        "improvement": round((naive - mae) / naive * 100, 1) if naive else 0.0,
        "coverage": round(float(np.concatenate(inside).mean() * 100), 1),
    }


def tune(frac: np.ndarray, mask: np.ndarray, flags: np.ndarray) -> dict:
    """Pick decay + smoothing by walk-forward validation on data the test weeks never touch."""
    hist, hist_flags = frac[:-TEST_WEEKS], flags[:-TEST_WEEKS]
    best = None
    for cand in GRID:
        PARAMS.update(cand)
        mae = backtest(hist, mask, hist_flags)["mae"]
        if best is None or mae < best[0] - 1e-9:
            best = (mae, dict(cand))
    PARAMS.update(best[1])
    return {**best[1], "validation_mae": best[0], "candidates": len(GRID)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=str(ROOT / "site" / "data" / "model.json"))
    parser.add_argument("--seed", type=int, default=404)
    args = parser.parse_args()

    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    rng = np.random.default_rng(args.seed)
    out: dict = {
        "version": 1,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "slot_minutes": SLOT_MIN,
        "weeks_of_history": WEEKS,
        "method": "Recency-weighted seasonal profile (weekday x 15 min) + academic-calendar multipliers, split-conformal p10-p90 band; decay and smoothing auto-tuned per facility by walk-forward validation",
        "facilities": {},
    }
    sources, all_mae, all_naive, all_cov = set(), [], [], []

    for fac in catalog["facilities"]:
        mask = np.stack([open_mask(fac, d) for d in range(DAYS)])
        real = fetch_real(fac["id"], fac["capacity"])
        if real is not None:
            # Real history carries no calendar labels yet, so every day counts as normal.
            frac, source, calib, flags = real, "live", None, np.zeros((WEEKS, DAYS), dtype=int)
        else:
            flags = history_flags()
            devices, people = synth_history(fac, rng, flags)
            a, b = calibrate(devices, people, rng)
            est_people = np.clip(devices * a + b, 0, None) * mask
            frac, source = est_people / fac["capacity"], "synthetic"
            calib = {"people_per_device": round(a, 3), "offset": round(b, 2)}
        sources.add(source)

        tuning = tune(frac, mask, flags)
        metrics = backtest(frac, mask, flags)
        model = fit(frac, mask, flags)
        mean, std = model["mean"], model["std"]
        all_mae.append(metrics["mae"])
        all_naive.append(metrics["naive_mae"])
        all_cov.append(metrics["coverage"])
        out["facilities"][fac["id"]] = {
            "source": source,
            "calibration": calib,
            "metrics": metrics,
            "effects": {k: round(v, 3) for k, v in model["effects"].items()},
            "band_scale": round(model["band_scale"], 3),
            "tuning": tuning,
            "mean": np.round(np.clip(mean, 0, 1) * 100).astype(int).tolist(),
            "spread": np.round(std * 100).astype(int).tolist(),
        }
        print(f"{fac['id']:<11} decay={tuning['decay']} k={tuning['kernel']} | MAE {metrics['mae']:5.2f} pts | naive {metrics['naive_mae']:5.2f} | band coverage {metrics['coverage']}%")

    out["source"] = "live" if sources == {"live"} else ("mixed" if "live" in sources else "synthetic")
    out["metrics"] = {
        "mae": round(float(np.mean(all_mae)), 2),
        "naive_mae": round(float(np.mean(all_naive)), 2),
        "improvement": round((np.mean(all_naive) - np.mean(all_mae)) / np.mean(all_naive) * 100, 1),
        "coverage": round(float(np.mean(all_cov)), 1),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"\nOverall MAE {out['metrics']['mae']} pts vs naive {out['metrics']['naive_mae']} "
          f"({out['metrics']['improvement']}% better), band coverage {out['metrics']['coverage']}% -> {args.out}")


if __name__ == "__main__":
    main()
