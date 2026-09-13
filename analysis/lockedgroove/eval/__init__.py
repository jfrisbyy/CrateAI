"""Accuracy harness support: metric definitions and dataset/report plumbing.

``metrics`` holds the six metrics from BUILD_PACKET section 16, and the six
sample-pair metrics, as pure functions over plain values. ``pairs`` reads the
hand-written sample-pair manifest and measures a pair. ``harness`` turns
datasets on disk (or in memory) into scored results. ``scripts/eval_accuracy.py``
is the CLI over all three. Nothing here imports an analysis stage: the harness
sees the public pipeline (``lockedgroove.pipeline.analyze_array``), the
effective report (``lockedgroove.report.effective``), and -- for sample pairs
only -- the loop finder and the alignment planner, which are the two things
that dataset exists to measure.
"""
