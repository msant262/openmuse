"""Collector report distinguishes a short demonstration from a complete soak."""
import copy
import unittest
from soak_hybrid import report


def row(elapsed):
    return {"host":"vps","elapsedSeconds":elapsed,"memoryAvailableBytes":6000000000,
        "temperatureCelsius":50,"apiReachable":True,"apiHealthRoundTripMs":10,
        "managed":{"browser":{"currentBytes":1024,"peakBytes":2048,"events":{"oom_kill":0}}}}


class SoakContracts(unittest.TestCase):
    def test_short_missing_and_interrupted_captures_do_not_claim_24_hours(self):
        self.assertFalse(report([row(0),row(60)])["completed24Hours"])
        sparse=[row(0),row(86400)]
        self.assertFalse(report(sparse)["completed24Hours"])
        full=[row(t) for t in range(0,86401,60)]
        self.assertTrue(report(full)["completed24Hours"])
        gapped=[value for value in full if not 1000<value["elapsedSeconds"]<1300]
        self.assertFalse(report(gapped)["completed24Hours"])
    def test_report_preserves_failure_and_measured_peak_without_claiming_chat_or_ack(self):
        rows=[row(0),row(60)];rows[-1]["apiReachable"]=False;rows[-1]["apiHealthRoundTripMs"]=None
        rows[-1]["managed"]["browser"]["events"]["oom_kill"]=1
        result=report(rows)
        self.assertEqual(result["apiFailures"],1);self.assertEqual(result["managed"]["browser"]["peakBytes"],2048)
        self.assertEqual(result["managed"]["browser"]["oomKillCount"],1)
        self.assertIn("desktop input ACK p95",result["pendingPhysicalMeasurements"])
        self.assertFalse(result["effectsDispatched"])


if __name__=="__main__":unittest.main()
