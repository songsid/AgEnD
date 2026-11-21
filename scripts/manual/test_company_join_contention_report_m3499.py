"""Parser-only controls: never spawn a load worker or execute Vitest."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("rehearsal", Path(__file__).with_name("test-resource-contention-m3499.py"))
rehearsal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rehearsal)
TARGET = "a new FleetManager reconstructs the expired journal and starts again from the same private state"

class RestartReport(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "report.json"

    def report(self, cases):
        self.path.write_text(json.dumps({"testResults": [{"assertionResults": cases}]}))
        return self.path

    def test_accepts_exact_passed_target_and_retains_duration(self):
        self.assertEqual(rehearsal.read_restart_cases(self.report([{"fullName": TARGET, "status": "passed", "duration": 123}])),
                         [{"name": TARGET, "status": "passed", "milliseconds": 123}])

    def test_refuses_missing_report(self):
        with self.assertRaises(ValueError):
            rehearsal.read_restart_cases(self.path)

    def test_refuses_invalid_empty_or_malformed_reports(self):
        for raw in ("", "not json", "{}", "null", '[]', '{"testResults":[]}', '{"testResults":[{}]}'):
            with self.subTest(raw=raw):
                self.path.write_text(raw)
                with self.assertRaises(ValueError):
                    rehearsal.read_restart_cases(self.path)

    def test_refuses_zero_skipped_pending_failed_wrong_or_extra_cases(self):
        for cases in ([], [{"fullName": TARGET, "status": "skipped"}], [{"fullName": TARGET, "status": "pending"}],
                      [{"fullName": TARGET, "status": "failed"}], [{"fullName": "wrong target", "status": "passed"}],
                      [{"fullName": TARGET, "status": "passed"}] * 2):
            with self.subTest(cases=cases):
                with self.assertRaises(ValueError):
                    rehearsal.read_restart_cases(self.report(cases))

if __name__ == "__main__":
    unittest.main()
