"""Real owned-file search contracts, including pagination and safe regex execution."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from .files import Workspace


class WorkspaceSearch(unittest.TestCase):
    def workspace(self, temp):
        ws = Workspace(Path(temp) / "workspace", Path(temp) / "state")
        self.addCleanup(ws.close)
        return ws

    def test_filename_search_traverses_past_the_old_directory_limit_and_pages(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = self.workspace(temp)
            for n in range(1005):
                (ws.root / f"report-{n:04d}.txt").write_text(str(n))
            first = ws.search("/workspace", {"target": "files", "pattern": "*report*", "limit": 2, "offset": 1000})
            self.assertEqual([x["path"] for x in first["results"]], ["/workspace/report-1000.txt", "/workspace/report-1001.txt"])
            self.assertEqual(first["nextOffset"], 1002)
            self.assertFalse(first["complete"])
            final = ws.search("/workspace", {"target": "files", "pattern": "*report*", "limit": 10, "offset": 1002})
            self.assertEqual(len(final["results"]), 3)
            self.assertTrue(final["complete"])
            self.assertEqual(final["totalMatches"], 1005)

    def test_content_regex_search_has_real_lines_context_hash_and_file_filter(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = self.workspace(temp)
            (ws.root / "nested").mkdir()
            (ws.root / "nested" / "budget.txt").write_text("Before\nO orçamento é 200 euros.\nAfter\n", encoding="utf8")
            (ws.root / "other.md").write_text("O orçamento é 100 euros.", encoding="utf8")
            result = ws.search("/workspace", {"pattern": r"(?i)orçamento.*\d+", "file_glob": "*.txt", "context": 1})
            self.assertTrue(result["complete"])
            self.assertEqual(len(result["results"]), 1)
            match = result["results"][0]
            self.assertEqual(match["path"], "/workspace/nested/budget.txt")
            self.assertEqual(match["line"], 2)
            self.assertEqual(match["content"], "O orçamento é 200 euros.")
            self.assertEqual(match["contextBefore"], ["Before"])
            self.assertEqual(match["contextAfter"], ["After"])
            self.assertEqual(len(match["sha256"]), 64)
            count = ws.search("/workspace", {"pattern": "euros", "output_mode": "count"})
            self.assertEqual(sum(x["count"] for x in count["results"]), 2)

    def test_search_never_follows_symlinks_or_reserved_paths_and_reports_unreadable_files(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = self.workspace(temp)
            outside = Path(temp) / "outside.txt"
            outside.write_text("secret outside the workspace")
            (ws.root / "escape").symlink_to(outside)
            (ws.root / ".okami-private").write_text("reserved")
            (ws.root / "good.txt").write_text("visible")
            (ws.root / "binary.bin").write_bytes(b"\xff\x00binary")
            names = ws.search("/workspace", {"target": "files", "pattern": "*"})
            self.assertTrue(names["complete"])
            self.assertEqual({x["path"] for x in names["results"]}, {"/workspace/good.txt", "/workspace/binary.bin"})
            content = ws.search("/workspace", {"pattern": "secret|visible"})
            self.assertEqual([x["content"] for x in content["results"]], ["visible"])
            self.assertTrue(content["complete"], "binary files are intentionally outside UTF-8 content scope")
            with self.assertRaises(ValueError):
                ws.search("/workspace/escape", {"pattern": "secret"})
            with self.assertRaises(ValueError):
                ws.search("/workspace/../outside.txt", {"pattern": "secret"})

    def test_missing_evidence_and_invalid_regex_are_definite_read_failures(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = self.workspace(temp)
            (ws.root / "large.txt").write_text("x" * (256 * 1024 + 1))
            result = ws.search("/workspace", {"pattern": "not found"})
            self.assertFalse(result["complete"])
            self.assertEqual(result["results"], [])
            self.assertEqual(result["skippedFiles"], 1)
            with self.assertRaisesRegex(ValueError, "regex"):
                ws.search("/workspace", {"pattern": "["})
            result = ws.handle({"kind": "file", "args": {"operation": "search", "path": "/workspace", "parameters": {"target": "files", "pattern": "*.txt"}}})
            self.assertEqual(result["results"][0]["path"], "/workspace/large.txt")

    def test_content_pagination_counts_skipped_matches_without_retaining_their_context(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = self.workspace(temp)
            (ws.root / "many.txt").write_text("\n".join(f"match:{n}: orçamento" for n in range(10005)), encoding="utf8")
            result = ws.search("/workspace", {"pattern": "match:", "offset": 10000, "limit": 2, "context": 1})
            self.assertEqual([x["line"] for x in result["results"]], [10001, 10002])
            self.assertEqual(result["results"][0]["content"], "match:10000: orçamento")
            self.assertEqual(result["nextOffset"], 10002)
            self.assertFalse(result["complete"])
            last = ws.search("/workspace", {"pattern": "match:", "offset": 10002, "limit": 10})
            self.assertEqual(len(last["results"]), 3)
            self.assertEqual(last["totalMatches"], 10005)

    def test_a_file_growing_after_stat_cannot_bypass_the_actual_content_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            ws = self.workspace(temp)
            (ws.root / "growing.txt").write_text("small")
            read = ws.read
            def growing(path):
                (ws.root / "growing.txt").write_bytes(b"needle\n" + b"x" * (256 * 1024))
                return read(path)
            with patch.object(ws, "read", side_effect=growing):
                result = ws.search("/workspace", {"pattern": "needle"})
            self.assertEqual(result["results"], [])
            self.assertFalse(result["complete"])
            self.assertEqual(result["skippedFiles"], 1)
            self.assertIn("content_byte_limit", result["limits"])
