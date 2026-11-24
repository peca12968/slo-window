"""Compare a delayed worker's actual dispatch order with the Fair Dispatch CLI."""
import argparse
import json
from pathlib import Path
from random import Random
import subprocess
from tempfile import TemporaryDirectory

from replay import Request, Staffing, replay_staffing


def verify(checkout):
    rng = Random(743)
    quanta = {"render": 4, "thumbnail": 2, "export": 1}
    jobs = [{"tenant": rng.choice(list(quanta)), "id": f"job-{i}", "cost": rng.randint(1, 20)}
            for i in range(80)]
    events = [{"enqueue": job} for job in jobs] + [{"dispatch": len(jobs)}]
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "trace.json"
        path.write_text(json.dumps({"quanta": quanta, "events": events}), encoding="utf-8")
        output = subprocess.check_output(["node", str(checkout / "replay.mjs"), str(path)], timeout=15)
    expected = [j["id"] for j in json.loads(output)["batches"][0]["jobs"]]
    trace = [Request(job["id"], 0, rng.randint(1, 8), 10000) for job in jobs]
    policy = {"quanta": quanta, "jobs": {j["id"]: j for j in jobs}}
    result = replay_staffing(trace, [Staffing(0, 0), Staffing(1, 1)], len(jobs), fair_policy=policy)
    if result["served"] != len(jobs) or [r["id"] for r in sorted(result["outcomes"], key=lambda r: r["start_ms"])] != expected:
        raise AssertionError("dispatch order differs from Fair Dispatch")
    print(f"Matched all {len(jobs)} dispatches across {len(quanta)} tenants.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    verify(parser.parse_args().checkout.resolve())
