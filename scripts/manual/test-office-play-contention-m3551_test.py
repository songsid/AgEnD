"""Evidence-parser controls only; no browser, CPU load, network or Fleet."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec = importlib.util.spec_from_file_location("office_proof", Path(__file__).with_name("test-office-play-contention-m3551.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Reports(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(); self.addCleanup(self.root.cleanup)
        self.path = Path(self.root.name) / "result.json"
    def valid(self): return {"pass": True, "cases": {m.CASE: {k: True for k in m.REQUIRED}}}
    def read(self, value):
        self.path.write_text(json.dumps(value)); return m.read_result(self.path)
    def test_positive_boolean_and_detail_checks(self):
        d = self.valid(); d["cases"][m.CASE]["person found"] = {"pass": True, "detail": {"x": 1, "y": 2}}
        self.assertEqual(self.read(d)["checks"], len(m.REQUIRED))
    def test_missing_invalid_and_empty_reports(self):
        for text in (None, "{", "{}", '{"pass":true,"cases":{}}'):
            with self.subTest(text=text):
                self.path.unlink(missing_ok=True)
                if text is not None: self.path.write_text(text)
                with self.assertRaises(ValueError): m.read_result(self.path)
    def test_wrong_extra_and_unexercised_cases(self):
        for cases in ({"wrong": {}}, {m.CASE: {}}, {m.CASE: self.valid()["cases"][m.CASE], "extra": {}}):
            with self.assertRaises(ValueError): self.read({"pass": True, "cases": cases})
    def test_false_missing_failed_or_extra_checks(self):
        for mode in ("false", "detail-false", "missing", "extra", "failed", "top-false"):
            d = self.valid(); c = d["cases"][m.CASE]
            if mode == "false": c["card: Pat and Feed"] = False
            elif mode == "detail-false": c["person found"] = {"pass": False}
            elif mode == "missing": del c["pointer clock: live before gesture"]
            elif mode == "extra": c["unreviewed check"] = True
            elif mode == "failed": c["failed"] = []
            else: d["pass"] = False
            with self.subTest(mode=mode):
                with self.assertRaises(ValueError): self.read(d)
if __name__ == "__main__": unittest.main()
