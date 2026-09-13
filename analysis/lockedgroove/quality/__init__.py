"""Audio quality: the measurements, the budgets, and the end-to-end check.

``metrics``    band ratios and transient concentration - what a stage did to the signal
``bandwidth``  the true bandwidth of a file, with a method and a confidence
``chain``      source -> separation -> stretch, measured at every step, against a budget
"""

from __future__ import annotations

from .bandwidth import Bandwidth, measure_bandwidth
from .metrics import StageLoss, air_db, band_ratio_db, measure_stage, transient_retention

__all__ = ["Bandwidth", "StageLoss", "air_db", "band_ratio_db", "measure_bandwidth", "measure_stage",
           "transient_retention"]
