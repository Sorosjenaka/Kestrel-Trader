import sys
import os
import unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from watchdog_sltp import decide_touch, fmt_qty

class TestWatchdogBasic(unittest.TestCase):
    def test_decide_touch_long(self):
        self.assertEqual(decide_touch(0.0020341, "LONG", 0.0020492, 0.0021243), ("SL", 0.0020492))
        self.assertEqual(decide_touch(0.0020492, "LONG", 0.0020492, 0.0021243), ("SL", 0.0020492))
        self.assertEqual(decide_touch(0.0021243, "LONG", 0.0020492, 0.0021243), ("TP", 0.0021243))
        self.assertIsNone(decide_touch(0.00207, "LONG", 0.0020492, 0.0021243))

    def test_decide_touch_short(self):
        self.assertEqual(decide_touch(0.001848, "SHORT", 0.001843, 0.001762), ("SL", 0.001843))
        self.assertEqual(decide_touch(0.001762, "SHORT", 0.001843, 0.001762), ("TP", 0.001762))
        self.assertIsNone(decide_touch(0.0018, "SHORT", 0.001843, 0.001762))

    def test_decide_touch_priorities_and_empty(self):
        self.assertEqual(decide_touch(0.0015, "LONG", 0.0020492, 0.0016), ("SL", 0.0020492))
        self.assertEqual(decide_touch(0.0022, "LONG", None, 0.0021243), ("TP", 0.0021243))
        self.assertIsNone(decide_touch(0.0022, "LONG", None, None))

    def test_fmt_qty(self):
        self.assertEqual(fmt_qty(35971.0), "35971")
        self.assertEqual(fmt_qty(0.001813), "0.001813")
        self.assertEqual(fmt_qty(2158.50000000), "2158.5")

if __name__ == "__main__":
    unittest.main()
