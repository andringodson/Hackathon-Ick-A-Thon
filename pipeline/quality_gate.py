"""Quality gate for the trained model: fail the build if the forecast got worse.

Checks every facility is present with full 7x96 profiles and sane values, and
that the backtest still clearly beats the naive baseline with a calibrated band.
Exit code 1 blocks the deploy, so a bad retrain never reaches users.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_IMPROVEMENT = 10.0  # % better than "same slot last week"
COVERAGE = (68.0, 93.0)  # p10-p90 band should cover ~80%
MAX_FACILITY_MAE = 15.0  # occupancy points


def main() -> int:
    catalog = json.loads((ROOT / "site/data/facilities.json").read_text(encoding="utf-8"))
    model = json.loads((ROOT / "site/data/model.json").read_text(encoding="utf-8"))
    problems = []
    for fac in catalog["facilities"]:
        m = model["facilities"].get(fac["id"])
        if not m:
            problems.append(f"{fac['id']}: missing from model")
            continue
        for key in ("mean", "spread"):
            grid = m[key]
            if len(grid) != 7 or any(len(row) != 96 for row in grid):
                problems.append(f"{fac['id']}: {key} is not 7x96")
            elif any(v < 0 or v > 100 for row in grid for v in row):
                problems.append(f"{fac['id']}: {key} outside 0-100")
        if m["metrics"]["mae"] > MAX_FACILITY_MAE:
            problems.append(f"{fac['id']}: MAE {m['metrics']['mae']} > {MAX_FACILITY_MAE}")
    overall = model["metrics"]
    if overall["improvement"] < MIN_IMPROVEMENT:
        problems.append(f"improvement {overall['improvement']}% < {MIN_IMPROVEMENT}%")
    if not COVERAGE[0] <= overall["coverage"] <= COVERAGE[1]:
        problems.append(f"band coverage {overall['coverage']}% outside {COVERAGE}")

    print(f"model: MAE {overall['mae']} pts, {overall['improvement']}% better than naive, coverage {overall['coverage']}%")
    if problems:
        print("QUALITY GATE FAILED:\n  " + "\n  ".join(problems))
        return 1
    print("quality gate passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
