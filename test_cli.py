"""Black-box checks against the Release build. Only the Python standard library is needed."""
from pathlib import Path
import subprocess
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
