#!/usr/bin/env python3
"""Score the analysis pipeline on the evaluation datasets (BUILD_PACKET section 16).

    python scripts/eval_accuracy.py --dataset synthetic --no-gate
    python scripts/eval_accuracy.py --dataset all --gates scripts/gates.json --workers 4
    python scripts/eval_accuracy.py --dataset giantsteps_key,ballroom --limit 50 --json out.json --markdown out.md

Datasets: synthetic | giantsteps_tempo | giantsteps_key | ballroom | harmonix | corrections | all
(``all`` runs whatever is present under data/ and skips the rest with a message;
naming a dataset that is missing fails the run when gates are on).

Metrics, per dataset and overall: BPM exact (<= 2 BPM), BPM octave-tolerant
(exact or the truth within 2 BPM of a listed alternate), key exact, key
relative-tolerant (exact, alternate, or relative major/minor), downbeat (median
absolute offset modulo the bar within +-60 ms), structure boundary F-measure at
+-1 bar where labels exist. A metric is skipped where the truth lacks the field
and counted as a miss where the pipeline produced nothing for it.

Results go to data/eval/<timestamp>.json and data/eval/latest.json (+ latest.md).
Exit status 1 when any gate in scripts/gates.json is not met, unless --no-gate.

The ``corrections`` dataset reads the corrections table with the service role
for one account (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EVAL_CORRECTIONS_USER_ID)
and downloads the audio through signed URLs; it is skipped when those are unset.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import pathlib
import sys
import time
from collections.abc import Callable, Mapping
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "analysis"))

from lockedgroove.eval import harness as H  # noqa: E402
from lockedgroove.eval.metrics import METRICS  # noqa: E402

DEFAULT_GATES = ROOT / "scripts" / "gates.json"
DEFAULT_DATA_DIR = ROOT / "data"

# re-exported for tests and other scripts
Dataset = H.Dataset
DatasetOutcome = H.DatasetOutcome
Item = H.Item
evaluate = H.evaluate
run_dataset = H.run_dataset
render_table = H.render_table
render_markdown = H.render_markdown


def load_gates(path: pathlib.Path) -> dict[str, dict[str, float]]:
    raw = json.loads(path.read_text())
    gates: dict[str, dict[str, float]] = {}
    for dataset, metrics in raw.items():
        if dataset.startswith("_") or not isinstance(metrics, Mapping):
            continue
        gates[dataset] = {m: float(v) for m, v in metrics.items() if m in METRICS}
    return gates


def resolve_datasets(spec: list[str]) -> tuple[list[str], bool]:
    names: list[str] = []
    explicit = True
    for chunk in spec:
        for name in chunk.split(","):
            name = name.strip()
            if not name:
                continue
            if name == "all":
                explicit = False
                names.extend(n for n in H.DATASETS if n not in names)
            elif name in H.DATASETS:
                if name not in names:
                    names.append(name)
            else:
                raise SystemExit(f"unknown dataset {name!r}; choose from {', '.join(H.DATASETS)} or all")
    return names, explicit


def score_datasets(names: list[str], data_dir: pathlib.Path, *, limit: int | None, workers: int,
                   stages: list[str] | None, explicit: bool, verbose: bool,
                   env: Mapping[str, str] | None = None, genres: list[str] | None = None,
                   log=print) -> dict[str, H.DatasetOutcome]:
    outcomes: dict[str, H.DatasetOutcome] = {}
    for name in names:
        kwargs: dict = {}
        if name == "corrections":
            kwargs["env"] = env
        if name == "harmonix" and genres:
            kwargs["genres"] = genres
        ds = H.load_dataset(name, data_dir, limit=limit, **kwargs)
        if not ds.items:
            log(f"[{name}] {ds.note or 'no items'}")
            outcomes[name] = H.DatasetOutcome(ds, [], 0.0, requested=explicit)
            continue
        log(f"[{name}] {len(ds.items)} items" + (f", {len(ds.skipped)} without audio/annotation" if ds.skipped else "")
            + f", {workers} worker(s)")
        t0 = time.perf_counter()
        results = H.run_dataset(ds, stages=stages, workers=workers, on_progress=_progress_printer(t0, verbose, log))
        outcomes[name] = H.DatasetOutcome(ds, results, time.perf_counter() - t0, requested=explicit)
    return outcomes


def _progress_printer(t0: float, verbose: bool, log) -> Callable[[str, int, int, H.ItemResult], None]:
    last_print = [0.0]

    def progress(dataset: str, i: int, n: int, res: H.ItemResult) -> None:
        if verbose:
            hits = " ".join(
                f"{m}={'.' if not r.applicable else ('1' if (r.value or 0) >= 1 else f'{r.value:.2f}')}"
                for m, r in res.scores.items())
            err = f"  errors={res.prediction.errors}" if res.prediction.errors else ""
            log(f"  [{dataset} {i}/{n}] {res.id}: {hits} ({res.elapsed_s:.1f}s){err}")
        elif time.perf_counter() - last_print[0] > 15 or i == n:
            last_print[0] = time.perf_counter()
            log(f"  [{dataset}] {i}/{n} done, {time.perf_counter() - t0:.0f}s")

    return progress


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("\n\n", 1)[1])
    ap.add_argument("--dataset", action="append", default=None,
                    help="synthetic|giantsteps_tempo|giantsteps_key|ballroom|harmonix|corrections|all (repeat or comma-separate)")
    ap.add_argument("--limit", type=int, default=None, help="first N items of each dataset")
    ap.add_argument("--workers", type=int, default=max(1, min(4, os.cpu_count() or 1)),
                    help="multiprocessing workers (default: min(4, cpus))")
    ap.add_argument("--stages", default=None, help="comma-separated report fields to run (default: pipeline default)")
    ap.add_argument("--data-dir", type=pathlib.Path, default=DEFAULT_DATA_DIR)
    ap.add_argument("--json", type=pathlib.Path, default=None, help="also write the results JSON here")
    ap.add_argument("--markdown", type=pathlib.Path, default=None, help="also write the markdown report here")
    ap.add_argument("--gates", type=pathlib.Path, default=DEFAULT_GATES)
    ap.add_argument("--genres", default=None,
                    help="harmonix only: comma-separated genres to keep, or 'hiphop' for "
                         "Hip-Hop, R&B and Funk/Disco (the subset this product is for)")
    ap.add_argument("--no-gate", action="store_true", help="report gates but never fail on them")
    ap.add_argument("--no-save", action="store_true", help="do not write data/eval/<timestamp>.json and latest.json")
    ap.add_argument("--verbose", "-v", action="store_true", help="one line per item")
    args = ap.parse_args(argv)

    # missing/failed stages are reported as miss reasons in the table; the pipeline's own
    # warnings only add noise unless asked for
    logging.basicConfig(level=logging.WARNING if args.verbose else logging.ERROR,
                        format="%(levelname)s %(name)s: %(message)s")
    names, explicit = resolve_datasets(args.dataset or ["synthetic"])
    stages = [s.strip() for s in args.stages.split(",") if s.strip()] if args.stages else None
    gates = load_gates(args.gates) if args.gates and args.gates.exists() else {}
    if args.gates and not args.gates.exists() and not args.no_gate:
        print(f"gates file not found: {args.gates}", file=sys.stderr)
        return 2

    genres: list[str] | None = None
    if args.genres:
        genres = (list(H.HARMONIX_GENRES_HIPHOP) if args.genres.strip().casefold() in ("hiphop", "hip-hop")
                  else [g.strip() for g in args.genres.split(",") if g.strip()])
    outcomes = score_datasets(names, args.data_dir, limit=args.limit, workers=args.workers, stages=stages,
                              explicit=explicit, verbose=args.verbose, genres=genres)
    meta: dict[str, Any] = {
        "datasets": names, "limit": args.limit, "workers": args.workers,
        "git_sha": os.environ.get("GITHUB_SHA"), "ci": bool(os.environ.get("CI")),
    }
    doc = H.evaluate(outcomes, gates=gates, enforce_gates=not args.no_gate, stages=stages, meta=meta)

    print()
    print(H.render_table(doc))
    if not args.no_save:
        stamped, latest = H.save_results(doc, args.data_dir / "eval")
        print(f"\nresults: {stamped} and {latest} (+ latest.md)")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(doc, indent=1))
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(H.render_markdown(doc))
    if doc["gates"]["enforced"] and not doc["gates"]["passed"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
