"""Job handlers, one module per ``jobs.kind``.

``lockedgroove.jobs.<kind>.run(job, db, storage, ctx) -> dict`` does the work
for one job row; ``lockedgroove.jobs.runner.run_job`` wraps it in the
lifecycle from docs/CONTRACTS.md section 4 (running -> done | failed) and is
what Modal and the local runner call.

Handlers never take a URL as input: the runner refuses any job whose params
carry a ``url``/``href``/``link``/``uri`` key (principle 3).
"""

from .common import JobContext, JobError
from .runner import KIND_PHASE, run_job

__all__ = ["JobContext", "JobError", "KIND_PHASE", "run_job"]
