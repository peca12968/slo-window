"""Black-box checks against the Release build. Only the Python standard library is needed."""
from pathlib import Path
import json
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
DLL = ROOT / "src/bin/Release/net10.0/access-rollup.dll"
EXAMPLES = ROOT / "examples"


def run(*args, data=b""):
    return subprocess.run(["dotnet", str(DLL), *map(str, args)], input=data,
                          capture_output=True, cwd=ROOT, timeout=15)


class CliTests(unittest.TestCase):
    def test_file_output_matches_dashboard_fixture(self):
        result = run(EXAMPLES / "checkout.ndjson")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.decode().splitlines(),
                         (EXAMPLES / "checkout.csv").read_text().splitlines())

    def test_order_bom_and_blank_lines(self):
        lines = (EXAMPLES / "checkout.ndjson").read_bytes().splitlines()
        result = run("-", data=b"\xef\xbb\xbf" + b"\n\n".join(reversed(lines)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.decode().splitlines(),
                         (EXAMPLES / "checkout.csv").read_text().splitlines())

    def test_no_partial_output_on_late_invalid_input(self):
        good = b'{"timestamp":"2026-05-01T00:00:00Z","status":200}\n'
        for invalid in [b'{}', b'not json', b'{"timestamp":"2026-05-01T00:00:00","status":200}',
                        b'{"timestamp":"2026-05-01T00:00:00Z","status":600}',
                        b'{"timestamp":"2026-05-01T00:00:00Z","status":"200"}']:
            with self.subTest(invalid=invalid):
                result = run(data=good + invalid)
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"Line 2", result.stderr)
                self.assertEqual(result.stdout, b"")

    def test_rejects_empty_and_invalid_utf8(self):
        for data in [b"", b"  \n", b"\xff"]:
            with self.subTest(data=data):
                result = run(data=data)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")

    def test_missing_file(self):
        result = run(EXAMPLES / "missing.ndjson")
        self.assertEqual(result.returncode, 2)
        self.assertTrue(result.stderr)

    def test_rotations_match_original_fixture_in_either_order(self):
        files = [EXAMPLES / f"rotation-{i}.ndjson" for i in (1, 2)]
        raw = run(*files)
        self.assertEqual(raw.returncode, 0, raw.stderr)
        self.assertEqual(raw.stdout.decode().splitlines()[1:],
                         ["2026-05-01,3,2", "2026-05-02,2,0", "2026-05-04,2,1"])
        expected = (EXAMPLES / "checkout.csv").read_text().splitlines()
        for paths in [files, files[::-1], [*files, *files]]:
            with self.subTest(paths=paths):
                result = run("--dedupe", *paths)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.decode().splitlines(), expected)

    def test_mixed_stdin_and_rotated_file_bom_and_empty_part(self):
        with tempfile.TemporaryDirectory() as temp:
            empty = Path(temp) / "empty.ndjson"
            empty.touch()
            second = b"\xef\xbb\xbf" + (EXAMPLES / "rotation-2.ndjson").read_bytes()
            result = run("--dedupe", empty, EXAMPLES / "rotation-1.ndjson", "-", data=second)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.decode().splitlines(),
                             (EXAMPLES / "checkout.csv").read_text().splitlines())
            for args in [("--dedupe", "-", "-"), ("--dedupe", empty), (empty, empty)]:
                failed = run(*args)
                self.assertEqual((failed.returncode, failed.stdout), (2, b""))

    def test_conflicts_report_both_source_locations_even_within_same_day(self):
        first = EXAMPLES / "rotation-1.ndjson"
        for change in [{"status": 502}, {"timestamp": "2026-05-01T23:30:00.0000001Z"}]:
            with self.subTest(change=change):
                record = {"timestamp": "2026-05-01T23:30:00Z", "status": 503, "request_id": "r2", **change}
                result = run("--dedupe", first, "-", data=b"\n" + json.dumps(record).encode())
                self.assertEqual((result.returncode, result.stdout), (2, b""))
                self.assertIn(b"rotation-1.ndjson: Line 2", result.stderr)
                self.assertIn(b"<stdin>: Line 2", result.stderr)
                self.assertIn(b"r2", result.stderr)

    def test_identity_is_case_sensitive_and_non_metric_metadata_is_ignored(self):
        base = {"timestamp": "2026-05-01T23:30:00Z", "status": 503, "request_id": "abc"}
        rows = [base, {**base, "request_id": "ABC"}, {**base, "agent": "changed"}]
        result = run("--dedupe", data="\n".join(map(json.dumps, rows)).encode())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.decode().splitlines()[-1], "2026-05-01,2,2")

    def test_dedupe_requires_valid_id_and_unambiguous_fields(self):
        base = '{"timestamp":"2026-05-01T23:30:00Z","status":503'
        fields = ["", ',"request_id":null', ',"request_id":" "', ',"request_id":7',
                  ',"request_id":"' + "z" * 129 + '"', ',"request_id":"a","request_id":"b"']
        for extra in fields:
            with self.subTest(extra=extra):
                data = (base + extra + "}").encode()
                result = run("--dedupe", data=data)
                self.assertEqual((result.returncode, result.stdout), (2, b""))
                self.assertIn(b"Line 1", result.stderr)
                legacy = run(data=data)
                self.assertEqual(legacy.returncode, 0, legacy.stderr)

    def test_bad_final_file_never_publishes_partial_csv(self):
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / "tail.ndjson"
            for data in [b"{}", b"\xff"]:
                bad.write_bytes(data)
                result = run("--dedupe", EXAMPLES / "rotation-1.ndjson", bad)
                self.assertEqual((result.returncode, result.stdout), (2, b""))
                self.assertIn(b"tail.ndjson", result.stderr)
