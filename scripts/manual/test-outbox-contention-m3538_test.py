"""Strict evidence-parser controls; no Vitest, child processes or CPU load."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("outbox_contention", Path(__file__).with_name("test-outbox-contention-m3538.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Reports(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.path = Path(self.root.name) / "report.json"
    def report(self, cases):
        self.path.write_text(json.dumps({"testResults": [{"assertionResults": cases}]}))
        return module.read_cases(self.path)
    def case(self, status="passed", name=None):
        return {"fullName": name or module.CASES[0], "status": status, "duration": 1}
    def test_exact_pass(self):
        self.assertEqual(len(self.report([self.case()])), 1)
    def test_missing_invalid_empty(self):
        for text in (None, "{", "{}", '{"testResults": []}'):
            with self.subTest(text=text):
                self.path.unlink(missing_ok=True)
                if text is not None: self.path.write_text(text)
                with self.assertRaises(ValueError): module.read_cases(self.path)
        with self.assertRaises(ValueError): self.report([])
    def test_nonpassing_wrong_duplicate_extra(self):
        for cases in ([self.case("pending")], [self.case("failed")], [self.case(name="wrong")], [self.case(), self.case()], [self.case(), self.case(name="extra")]):
            with self.subTest(cases=cases):
                with self.assertRaises(ValueError): self.report(cases)
    def test_unselected_skipped_is_permitted(self):
        self.assertEqual(len(self.report([self.case(), self.case("pending", "unselected")])), 1)

if __name__ == "__main__": unittest.main()
