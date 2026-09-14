"""A report that is still being written says so, and says what is still coming.

The seams pass turned the first analysis from a ladder of step names into real
numbers arriving one at a time (docs/HANDOFF_seams.md): ``analyze_task`` writes
``files.report`` after every stage instead of once at the end. The risk that
buys is a half-written report being mistaken for a finished one, so the rule is
a single field -- ``report.pending`` is set while it is partial and ``None``
when it is done -- and these are the tests that hold every layer to it.
"""

from __future__ import annotations

import types
import uuid

import numpy as np
import pytest
import soundfile as sf

from lockedgroove import ANALYSIS_VERSION
from lockedgroove.db import InMemoryDatabase
from lockedgroove.ingest import sha256_file
from lockedgroove.jobs import run_job
from lockedgroove.pipeline import analyze_array
from lockedgroove.report import AnalysisReport, KeyEdit, effective, is_partial
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import Pattern, drum_loop, to_stereo

USER = str(uuid.uuid4())
SR = 22050
STAGES = ["tempo", "beats", "key"]


@pytest.fixture
def library(tmp_path):
    storage = LocalStorage(tmp_path / "bucket")
    y = to_stereo(drum_loop(90.0, 2, Pattern.boom_bap(), sr=SR), width=0.3)
    wav = tmp_path / "beat.wav"
    sf.write(wav, y.T, SR, subtype="PCM_16")
    sha = sha256_file(str(wav))
    storage_path = f"library/{USER}/{sha[:2]}/{sha}.wav"
    storage.upload(storage_path, str(wav))
    db = InMemoryDatabase()
    file = db.insert_file({
        "user_id": USER, "sha256": sha, "original_filename": "beat.wav",
        "storage_path": storage_path, "size_bytes": wav.stat().st_size, "status": "queued",
    })
    return types.SimpleNamespace(db=db, storage=storage, file=file, sha=sha)


def _analyze_job(db, file, **params):
    return db.insert_job({"user_id": USER, "file_id": file["id"], "kind": "analyze", "params": params})


def _reports_written(db) -> list[dict]:
    """Every report the job left on the row, in order, as raw jsonb.

    ``writes_to`` records the row as it stood after each update, so this is what
    a reader subscribed to Realtime would have seen, one push at a time.
    """
    return [w["report"] for w in db.writes_to("files", "update") if w.get("report")]


# ---------------------------------------------------------------------------
# the pipeline
# ---------------------------------------------------------------------------


def test_on_partial_is_called_once_per_stage_and_every_call_is_marked_partial():
    y = drum_loop(90.0, 1, Pattern.boom_bap(), sr=SR)
    seen: list[dict] = []
    analyze_array(y, SR, stages=STAGES, on_partial=lambda r: seen.append(r.to_json_dict()))

    assert len(seen) == len(STAGES)
    assert all(is_partial(s) for s in seen)
    # each call knows what has run and what has not, by the report's own names
    assert [s["pending"]["done"] for s in seen] == [["tempo"], ["tempo", "beats"], ["tempo", "beats", "key"]]
    assert [s["pending"]["stages"] for s in seen] == [["beats", "key"], ["key"], []]
    assert [s["pending"]["fraction"] for s in seen] == [pytest.approx(1 / 3), pytest.approx(2 / 3), 1.0]


def test_the_first_partial_already_carries_a_real_measurement():
    """The point of the whole feature: a tempo at twenty seconds, not a step name."""
    y = drum_loop(90.0, 2, Pattern.boom_bap(), sr=SR)
    seen: list[AnalysisReport] = []
    analyze_array(y, SR, stages=STAGES, on_partial=lambda r: seen.append(r.model_copy(deep=True)))

    first = seen[0]
    assert first.tempo is not None
    assert first.tempo.bpm == pytest.approx(90.0, abs=3.0)
    assert first.tempo.confidence > 0.0
    # and nothing that has not run is invented
    assert first.key is None
    assert first.pending is not None and "key" in first.pending.stages


def test_the_returned_report_is_never_partial():
    y = drum_loop(90.0, 1, Pattern.boom_bap(), sr=SR)
    report = analyze_array(y, SR, stages=STAGES)
    assert report.pending is None
    assert not is_partial(report)
    assert not is_partial(report.to_json_dict())


def test_a_stage_that_fails_still_counts_as_run(monkeypatch):
    """Otherwise a consumer waits forever for a measurement that is not coming."""
    import lockedgroove.pipeline as pipeline

    real = pipeline._stage_fn

    def boom(module_name: str):
        if module_name == "key":
            raise RuntimeError("no key stage today")
        return real(module_name)

    monkeypatch.setattr(pipeline, "_stage_fn", boom)
    seen: list[dict] = []
    report, ctx = analyze_array(
        drum_loop(90.0, 1, Pattern.boom_bap(), sr=SR), SR, stages=STAGES,
        on_partial=lambda r: seen.append(r.to_json_dict()), return_context=True,
    )
    assert "key" in ctx.errors
    assert seen[-1]["pending"]["done"] == STAGES
    assert seen[-1]["pending"]["stages"] == []
    assert report.key is None and report.pending is None


def test_a_broken_partial_callback_does_not_break_the_analysis():
    def explode(_report):
        raise RuntimeError("the database is down")

    report = analyze_array(drum_loop(90.0, 1, Pattern.boom_bap(), sr=SR), SR, stages=STAGES, on_partial=explode)
    assert report.tempo is not None
    assert report.pending is None


# ---------------------------------------------------------------------------
# effective(), which every consumer reads through
# ---------------------------------------------------------------------------


def test_effective_keeps_a_partial_partial_and_a_finished_report_finished():
    y = drum_loop(90.0, 1, Pattern.boom_bap(), sr=SR)
    seen: list[AnalysisReport] = []
    done = analyze_array(y, SR, stages=STAGES, on_partial=lambda r: seen.append(r.model_copy(deep=True)))

    assert is_partial(effective(seen[0]))
    assert not is_partial(effective(done))


def test_a_correction_applies_to_a_partial_without_finishing_it():
    y = drum_loop(90.0, 1, Pattern.boom_bap(), sr=SR)
    seen: list[AnalysisReport] = []
    analyze_array(y, SR, stages=STAGES, on_partial=lambda r: seen.append(r.model_copy(deep=True)))

    partial = seen[0]
    partial.user_edits.tempo_bpm = 45.0
    partial.user_edits.key = KeyEdit(tonic="F", mode="minor")
    out = effective(partial)

    assert out.tempo is not None and out.tempo.bpm == 45.0  # the correction wins, as always
    assert out.key is not None and out.key.tonic == "F"     # even for a stage that has not run
    assert is_partial(out)                                   # and it is still not a finished report


def test_is_partial_takes_a_model_or_the_raw_jsonb_or_nothing():
    assert not is_partial(None)
    assert not is_partial({})
    assert not is_partial({"pending": None})
    assert is_partial({"pending": {"stages": ["key"], "done": ["tempo"], "fraction": 0.5}})
    assert not is_partial(AnalysisReport.empty())
    assert not is_partial("not a report")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# the job, which is what a producer actually watches
# ---------------------------------------------------------------------------


def test_the_job_publishes_a_partial_per_stage_and_a_finished_report_at_the_end(library):
    db, storage, file = library.db, library.storage, library.file
    final = run_job(_analyze_job(db, file, stages=STAGES)["id"], db, storage)
    assert final["status"] == "done", final["error"]

    reports = _reports_written(db)
    assert len(reports) == len(STAGES) + 1          # one per stage, then the finishing patch
    assert all(is_partial(r) for r in reports[:-1])
    assert not is_partial(reports[-1])
    assert reports[0]["tempo"] is not None          # a real number, before the job is anywhere near done

    row = db.get_file(file["id"])
    assert row["status"] == "ready"
    assert row["report"]["pending"] is None
    assert row["analysis_version"] == ANALYSIS_VERSION


def test_while_the_report_is_partial_the_row_says_so_too(library):
    """An interrupted job must leave a file that is plainly unfinished.

    The partial patch writes ``report`` and nothing else, so the row a reader
    sees still says ``analyzing`` at the old ``analysis_version`` -- a second,
    independent signal for anything that has never heard of ``pending``.
    """
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file, stages=STAGES)["id"], db, storage)

    partial_rows = [w for w in db.writes_to("files", "update") if is_partial(w.get("report"))]
    assert len(partial_rows) == len(STAGES)
    for row in partial_rows:
        assert row["status"] == "analyzing"
        assert row["analysis_version"] == 0


def test_a_partial_carries_the_producers_corrections(library):
    """Principle 7: a progress feature must not be able to erase a correction."""
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file, stages=STAGES)["id"], db, storage)
    db.update_file(file["id"], {"report": {
        **db.get_file(file["id"])["report"],
        "user_edits": {"tempo_bpm": 45.0, "downbeat_phase": None, "first_downbeat_s": None,
                       "key": None, "meter": None, "section_labels": None, "edited_at": None},
    }})
    before = len(db.writes_to("files", "update"))

    run_job(_analyze_job(db, file, stages=STAGES, force=True)["id"], db, storage)

    written = [w["report"] for w in db.writes_to("files", "update")[before:] if w.get("report")]
    assert written and all(r["user_edits"]["tempo_bpm"] == 45.0 for r in written)


def test_a_file_left_with_a_partial_report_is_re_analyzed_rather_than_skipped(library):
    """The idempotency rule must not read a half-written report as an analysis."""
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file, stages=STAGES)["id"], db, storage)
    finished = db.get_file(file["id"])["report"]

    # what a job that died mid-run leaves behind: a partial report under the
    # version the previous run reached
    db.update_file(file["id"], {"report": {**finished, "key": None,
                                           "pending": {"stages": ["key"], "done": ["tempo", "beats"], "fraction": 0.66}}})

    final = run_job(_analyze_job(db, file, stages=STAGES)["id"], db, storage)
    assert final["result"]["skipped"] is False
    row = db.get_file(file["id"])
    assert row["report"]["pending"] is None
    assert row["report"]["key"] is not None


def test_a_finished_report_is_still_skipped_as_idempotent(library):
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file)["id"], db, storage)
    final = run_job(_analyze_job(db, file)["id"], db, storage)
    assert final["result"]["skipped"] is True


def test_the_stored_partial_validates_as_a_report(library):
    """Whatever reads files.report next must be able to parse a partial."""
    db, storage, file = library.db, library.storage, library.file
    run_job(_analyze_job(db, file, stages=STAGES)["id"], db, storage)
    for raw in _reports_written(db):
        parsed = AnalysisReport.model_validate(raw)
        assert parsed.schema_version == "3.0"
        assert np.isfinite(parsed.file.duration_s)
