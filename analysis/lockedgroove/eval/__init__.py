"""Accuracy harness support: metric definitions and dataset/report plumbing.

``metrics`` holds the six metrics from BUILD_PACKET section 16 as pure
functions over plain values. ``harness`` turns datasets on disk (or in
memory) into scored results. ``scripts/eval_accuracy.py`` is the CLI over
both. Nothing here imports an analysis stage: the harness only sees the
public pipeline (``lockedgroove.pipeline.analyze_array``) and the effective
report (``lockedgroove.report.effective``).
"""
