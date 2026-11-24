"""Verify the compiled log exporter against an independent Bucket Verdict checkout."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "examples/latency.json"
DLL = ROOT / "src/bin/Release/net10.0/access-rollup.dll"


def records(high=False):
    times = ({"north": [100] * 6 + [200] * 3 + [400], "south": [80] * 4 + [150] * 4 + [300] * 2}
             if high else {"north": [0] * 6 + [101] * 3 + [201], "south": [0] * 4 + [81] * 4 + [151] * 2})
    return [{"timestamp": "2026-05-02T07:59:59+08:00", "status": 200, "shard": shard,
             "request_id": f"{shard}-{i}", "duration_ms": value}
            for shard, samples in times.items() for i, value in enumerate(samples)]


def ndjson(rows):
    return "\n".join(json.dumps(row) for row in rows).encode()


def exercise(verdict):
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        previous = None
        for high in (False, True):
            raw = records(high)
            left, right = directory / "first.ndjson", directory / "second.ndjson"
            left.write_bytes(ndjson(raw[:13]))
            right.write_bytes(ndjson(raw[10:]))
            output = subprocess.check_output(["dotnet", DLL, "--dedupe", "--histogram", CONFIG, left, right])
            if previous is not None and previous != output:
                raise AssertionError("Cohorts did not produce identical histograms")
            previous = output
            histogram = directory / "hist.csv"
            histogram.write_bytes(output)
            report = json.loads(subprocess.check_output([sys.executable, verdict, histogram,
                "--quantile", ".9", "--threshold-ms", "120", "--target", ".8"]))
            durations = sorted(item["duration_ms"] for item in raw)
            hits = sum(ms <= 120 for ms in durations)
            quantile = durations[17]
            assert report["requests"] == 20 and report["decision"] == "indeterminate"
            assert report["within_threshold"] == [10, 17] and report["quantile_ms"] == [151, 300]
            assert (hits, quantile) == ((10, 300) if high else (17, 151))
            print(f"23 log rows -> 20 requests, actual hits={hits}, P90={quantile} ms, "
                  f"histogram hits={report['within_threshold']}, P90={report['quantile_ms']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("verdict", type=Path)
    exercise(parser.parse_args().verdict.resolve())
