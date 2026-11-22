"""Check real JFR output against the JDK's JSON export using exact nanoseconds."""
from datetime import datetime
from decimal import Decimal
import json
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parent


def interval(values):
    stamp = re.fullmatch(r"(.+T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)", values["startTime"])
    dt = datetime.fromisoformat(stamp[1] + stamp[3].replace("Z", "+00:00"))
    start = int(dt.timestamp()) * 10**9 + int((stamp[2] or "").ljust(9, "0"))
    seconds = re.fullmatch(r"PT([\d.]+)S", values["duration"])[1]
    return start, start + int(Decimal(seconds) * 10**9)


def covered(spans):
    # Repartition the timeline at every observed boundary. Count a cell once if
    # any pause covers it. Suitable as an independent oracle for small captures.
    cuts = sorted({t for span in spans for t in span})
    return sum(b - a for a, b in zip(cuts, cuts[1:]) if any(s <= a and b <= e for s, e in spans))


def p95(values):
    return sorted(values)[(len(values) * 95 - 1) // 100] if values else None


def verify():
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        source = ["PauseLens.java", "CaptureDemo.java", "PauseIndexTest.java"]
        subprocess.run(["javac", "-d", root, *[ROOT / p for p in source]], check=True)
        java = ["java", "-cp", root]
        subprocess.run([*java, "PauseIndexTest"], check=True)
        recording = root / "example.jfr"
        subprocess.run([*java, "-XX:+UseSerialGC", "CaptureDemo", recording], check=True)
        command = [*java, "PauseLens", recording]
        stats = json.loads(subprocess.check_output([*command, "demo.Request"]))
        events = json.loads(subprocess.check_output(["jfr", "print", "--json", "--stack-depth", "0", "--events",
            "demo.Request,jdk.GCPhasePause", recording]))["recording"]["events"]
        ops = [interval(e["values"]) for e in events if e["type"] == "demo.Request"]
        pauses = [interval(e["values"]) for e in events if e["type"] == "jdk.GCPhasePause"]
        overlaps = [covered([(max(a, s), min(b, e)) for s, e in pauses if max(a, s) < min(b, e)])
                    for a, b in ops]
        affected = [b-a for (a, b), n in zip(ops, overlaps) if n]
        unaffected = [b-a for (a, b), n in zip(ops, overlaps) if not n]
        expected = dict(operations=len(ops), with_pause=len(affected), pause_events=len(pauses),
                        pause_wall_ns=covered(pauses), operation_overlap_ns=sum(overlaps),
                        operation_p95_ns=p95(affected + unaffected), with_pause_p95_ns=p95(affected),
                        without_pause_p95_ns=p95(unaffected))
        assert len(ops) == 4 and len(affected) >= 2 and stats == expected, (stats, expected)
        assert any(sum(a <= s and e <= b for a, b in ops) >= 2 for s, e in pauses if e > s)
        empty = json.loads(subprocess.check_output([*command, "demo.IdleRequest"]))
        assert empty["operations"] == 0 and empty["operation_p95_ns"] is None
        invalid = subprocess.run([*command, "demo.Unknown"], capture_output=True)
        assert invalid.returncode == 2 and not invalid.stdout and b"Unknown operation" in invalid.stderr
        print(json.dumps(stats))


if __name__ == "__main__":
    verify()
