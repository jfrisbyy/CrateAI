"""lockedgroove: analysis, loops, stems, chops, combine, re-voice, breakdown.

Working name for the CrateAI compute package. Every public function here is a
pure function over audio arrays or an explicit job runner; nothing in this
package can turn a URL into a library file (principle 3).
"""

ANALYSIS_VERSION = 1
SCHEMA_VERSION = "3.0"

__all__ = ["ANALYSIS_VERSION", "SCHEMA_VERSION"]
