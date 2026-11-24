"""Calibrate two host clocks, capture real OTLP messages, then check cross-host timing."""
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from examples.capture import capture

ROOT = Path(__file__).resolve().parent


def verify(tool, tmp):
    capture(tmp, batch=True)
    clock = subprocess.check_output([sys.executable, tool / "clock_bracket.py", ROOT / "examples/clock-capture.json", "--pairs"])
    path = tmp / "clock.json"
    path.write_bytes(clock)
    expected = json.loads((ROOT / "examples/clock-bounds.json").read_text(encoding="utf-8"))
    assert json.loads(clock) == expected
    files = [tmp / name for name in ("batch.otlp", "enqueue-a.otlp", "enqueue-b.otlp")]
    report = json.loads(subprocess.check_output([sys.executable, ROOT / "trace_time.py", "--clock-bounds", path, *files]))
    check(report)


def check(report):
    found = {}
    for edge in report["links"]["edges"]:
        corrected = edge["clock_adjusted"]
        assert (corrected["from_host"], corrected["to_host"], corrected["state"]) == ("ingest01", "batch01", "bounded")
        found[edge["linked_name"]] = (edge["start_minus_linked_end_ns"], corrected["lower_ns"], corrected["upper_ns"])
    assert found == {"enqueue A": (40_000_000, 20_000_000, 30_000_000), "enqueue B": (15_000_000, -5_000_000, 5_000_000)}
    print("Verified calibrated bounds A = 20..30 ms and B = -5..5 ms")


if __name__ == "__main__":
    with TemporaryDirectory() as directory:
        verify(Path(sys.argv[1]).resolve(), Path(directory))
