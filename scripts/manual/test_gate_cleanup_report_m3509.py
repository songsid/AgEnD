import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("gate_rehearsal", Path(__file__).with_name("test-gate-cleanup-contention-m3509.py"))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Reports(unittest.TestCase):
    def report(self, cases):
        return {"testResults": [{"assertionResults": cases}]}
    def cases(self):
        return [{"fullName": name, "status": "passed"} for name in module.CASES]
    def read(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            if data is not None: path.write_text(json.dumps(data))
            return module.read_cases(path)
    def test_current_positive(self):
        self.assertEqual(len(self.read(self.report(self.cases() + [{"fullName": "filtered", "status": "pending"}]))), 3)
    def test_missing_or_empty(self):
        for data in [None, {}, {"testResults": []}, self.report([])]:
            with self.subTest(data=data), self.assertRaises(ValueError): self.read(data)
    def test_missing_wrong_duplicate_and_extra(self):
        cases = self.cases()
        for bad in [cases[:-1], cases[:-1] + [{"fullName": "wrong", "status": "passed"}], cases + [cases[0]], cases + [{"fullName": "extra", "status": "passed"}]]:
            with self.subTest(bad=bad), self.assertRaises(ValueError): self.read(self.report(bad))
    def test_intended_must_run_and_pass(self):
        for state in ["failed", "pending", "skipped"]:
            cases = self.cases(); cases[0]["status"] = state
            with self.subTest(state=state), self.assertRaises(ValueError): self.read(self.report(cases))
if __name__ == "__main__": unittest.main()
