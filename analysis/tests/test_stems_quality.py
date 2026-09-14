"""Separation quality: the ordering, the default, and what a row has to record.

Separation is the irreversible step. A weak separator on a real upload threw
away 17.6 dB of 8-20 kHz energy that a strong one preserved exactly, so the
rules these tests hold are: the best available model wins by default, nothing
trades quality for compute, and every row says which model ran and how good it
is - because a claim made from a stem is only as good as the stem.
"""

from __future__ import annotations

import types
import uuid

import numpy as np
import pytest
import soundfile as sf

from lockedgroove.db import InMemoryDatabase
from lockedgroove.ingest import sha256_file
from lockedgroove.jobs import run_job
from lockedgroove.stems import separate
from lockedgroove.stems.separate import (
    DEFAULT_MODEL,
    DEFAULT_STEMS,
    MODELS,
    TIER_CONFIDENCE,
    TIERS,
    FakeSeparator,
    _flatten_model_files,
    best_model,
    model_label,
    models_for,
    quality_of,
    resolve_model,
)
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import Pattern, drum_loop, to_stereo

USER = str(uuid.uuid4())
SR = 22050


# ---------------------------------------------------------------------------
# the registry and the ordering
# ---------------------------------------------------------------------------


def test_every_entry_declares_what_it_takes_to_judge_it():
    for key, spec in MODELS.items():
        assert spec["tier"] in TIERS, key
        assert spec["family"] and spec["label"] and spec["stems"], key
        assert spec["sdr"] is None or spec["sdr"] > 0, key
        assert spec["sdr_basis"], key           # where the number came from, or that there isn't one


def test_the_order_is_by_quality_and_the_weak_family_is_last():
    order = models_for()
    tiers = [MODELS[m]["tier"] for m in order]
    assert tiers == sorted(tiers, key=TIERS.index), order
    assert MODELS[order[0]]["tier"] == "reference"
    assert MODELS[order[-1]]["tier"] == "weak"
    assert MODELS[order[-1]]["family"] == "kuielab"


def test_within_a_tier_the_higher_published_sdr_wins():
    reference = [m for m in models_for() if MODELS[m]["tier"] == "reference"]
    sdrs = [MODELS[m]["sdr"] or -1.0 for m in reference]
    assert sdrs == sorted(sdrs, reverse=True)


def test_the_default_is_derived_from_the_ordering_not_hard_coded():
    assert DEFAULT_MODEL == best_model(DEFAULT_STEMS)
    assert MODELS[DEFAULT_MODEL]["tier"] in ("reference", "strong")
    assert set(DEFAULT_STEMS) <= set(MODELS[DEFAULT_MODEL]["stems"])


def test_a_two_stem_ask_gets_the_reference_tier():
    chosen = best_model(["vocals", "instrumental"])
    assert MODELS[chosen]["tier"] == "reference"
    assert quality_of(chosen).confidence == TIER_CONFIDENCE["reference"]


def test_availability_narrows_the_choice_and_the_reason_says_so():
    choice = resolve_model(stems_wanted=["vocals", "instrumental"], available=["mdxnet_inst_hq"])
    assert choice.model == "mdxnet_inst_hq"
    assert choice.downgraded is True
    assert "not installed" in choice.reason
    assert choice.quality.tier == "baseline"


def test_nothing_installed_is_an_error_not_a_quiet_downgrade():
    with pytest.raises(ValueError, match="no installed separator"):
        resolve_model(stems_wanted=DEFAULT_STEMS, available=[])


def test_a_weak_model_can_be_asked_for_but_the_row_says_what_it_is():
    choice = resolve_model("kuielab_other", stems_wanted=["other"])
    assert choice.model == "kuielab_other"
    assert choice.quality.tier == "weak"
    assert choice.quality.confidence < 0.4
    assert "cannot be recovered" in choice.quality.note
    assert choice.downgraded is True and "higher quality" in choice.reason


def test_asking_for_a_model_that_cannot_produce_the_stems_is_refused():
    with pytest.raises(ValueError, match="does not produce"):
        resolve_model("kuielab_other", stems_wanted=DEFAULT_STEMS)
    with pytest.raises(ValueError, match="not installed"):
        resolve_model("bs_roformer", available=["htdemucs_ft"])
    with pytest.raises(ValueError, match="unknown stem model"):
        resolve_model("nope")


def test_the_stand_in_is_never_mistaken_for_a_separation():
    quality = quality_of(DEFAULT_MODEL, stand_in=True)
    assert quality.tier == "stand_in"
    assert quality.is_stand_in is True
    assert quality.sdr is None
    assert quality.confidence <= 0.2
    assert model_label(DEFAULT_MODEL, stand_in=True).endswith("-fake")
    assert "not a separation model" in quality.note


def test_the_quality_row_has_everything_a_downstream_claim_needs():
    row = quality_of(DEFAULT_MODEL).to_row()
    assert set(row) == {"model_family", "model_tier", "model_sdr", "model_sdr_basis", "is_stand_in",
                        "quality_confidence", "quality_note"}
    assert 0.0 <= row["quality_confidence"] <= 1.0


def test_the_separator_listing_is_read_through_whatever_shape_it_arrives_in():
    assert set(_flatten_model_files({"A": {"x.ckpt": "X"}, "B": ["y.onnx"]})) == {"x.ckpt", "y.onnx"}
    assert _flatten_model_files(None) == []
    assert FakeSeparator().available_models() == set(MODELS)


# ---------------------------------------------------------------------------
# the job
# ---------------------------------------------------------------------------


@pytest.fixture
def world(tmp_path):
    storage = LocalStorage(tmp_path / "bucket")
    db = InMemoryDatabase()
    y = to_stereo(drum_loop(90.0, 2, Pattern.boom_bap(), SR), width=0.2)
    wav = tmp_path / "beat.wav"
    sf.write(wav, np.asarray(y).T, SR, subtype="PCM_16")
    sha = sha256_file(str(wav))
    path = f"library/{USER}/{sha[:2]}/{sha}.wav"
    storage.upload(path, str(wav))
    row = db.insert_file({"user_id": USER, "sha256": sha, "original_filename": "beat.wav", "storage_path": path,
                          "kind": "original", "status": "ready", "duration_s": 2.0, "sample_rate": SR,
                          "channels": 2})

    def job(**params):
        return db.insert_job({"user_id": USER, "file_id": row["id"], "kind": "stems", "params": params})

    return types.SimpleNamespace(db=db, storage=storage, job=job, file=row)


def test_the_job_records_the_model_and_its_quality_on_every_row(world, monkeypatch):
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_STEMS", "1")
    final = run_job(world.job()["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    result = final["result"]
    assert result["model"] == model_label(DEFAULT_MODEL, stand_in=True)
    assert result["quality"]["model_tier"] == "stand_in"
    assert result["model_reason"]
    rows = world.db.select("stems", {"file_id": world.file["id"]})
    assert sorted(r["stem"] for r in rows) == sorted(DEFAULT_STEMS)
    for row in rows:
        assert row["model_family"] == MODELS[DEFAULT_MODEL]["family"]
        assert row["model_tier"] == "stand_in"
        assert row["is_stand_in"] is True
        assert row["model_sdr"] is None
        assert row["model_sdr_basis"]
        assert 0.0 <= row["quality_confidence"] <= 0.2
        assert row["quality_note"]


def test_the_job_picks_the_best_model_when_none_is_named(world, monkeypatch):
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_STEMS", "1")
    final = run_job(world.job(stems=["vocals", "instrumental"])["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    assert final["result"]["model"].startswith(best_model(["vocals", "instrumental"]))
    assert MODELS[best_model(["vocals", "instrumental"])]["tier"] == "reference"


@pytest.mark.parametrize("param", ["fast", "quality", "speed", "preset"])
def test_there_is_no_fast_mode(world, monkeypatch, param):
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_STEMS", "1")
    final = run_job(world.job(**{param: "fast"})["id"], world.db, world.storage)
    assert final["status"] == "failed"
    assert "best available model" in final["error"]


def test_a_bad_stem_list_is_refused_before_any_gpu_time(world, monkeypatch):
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_STEMS", "1")
    final = run_job(world.job(stems="drums")["id"], world.db, world.storage)
    assert final["status"] == "failed" and "list of stem names" in final["error"]


def test_an_explicit_weak_model_still_runs_but_the_rows_are_labelled(world, monkeypatch):
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_STEMS", "1")
    final = run_job(world.job(model="kuielab_other", stems=["other"])["id"], world.db, world.storage)
    assert final["status"] == "done", final["error"]
    assert final["result"]["downgraded"] is True
    row = world.db.select("stems", {"file_id": world.file["id"]})[0]
    assert row["model_family"] == "kuielab"
    assert row["is_stand_in"] is True          # the stand-in ran, so that is what the row says


# --- the sentence a producer reads ------------------------------------------------------------
#
# `ModelChoice.reason` is shown in the Stems tab, off the finished job's result.
# It used to carry a Python list repr into the interface
# ("best available for ['bass', 'drums', 'other', 'vocals']") and count what was
# missing rather than name it, which is no use to the person who decides what
# the image carries.


def test_the_reason_says_the_split_the_way_a_person_would():
    choice = separate.resolve_model(None, ["drums", "bass", "vocals", "other"], available=None)
    assert "drums, bass, vocals and other" in choice.reason
    assert "[" not in choice.reason, "a list repr must not reach the interface"


def test_the_split_keeps_the_registry_order_rather_than_alphabetical():
    assert separate.describe_stems(["drums", "bass", "vocals", "other"]) == "drums, bass, vocals and other"
    assert separate.describe_stems(["vocals", "instrumental"]) == "vocals and instrumental"
    assert separate.describe_stems(["drums"]) == "drums"
    assert separate.describe_stems([]) == "nothing"
    assert separate.describe_stems(["drums", "drums", "bass"]) == "drums and bass"


def test_a_downgrade_names_the_separator_that_was_missing():
    choice = separate.resolve_model(None, ["vocals", "instrumental"], available={"mdx23c_inst_voc"})
    assert choice.downgraded is True
    assert "bs_roformer is higher quality but is not installed here" in choice.reason


def test_a_downgrade_past_several_names_the_best_of_them_and_counts():
    choice = separate.resolve_model(None, ["vocals", "instrumental"], available={"mdxnet_inst_hq"})
    assert choice.downgraded is True
    assert "2 higher-quality separators are not installed here" in choice.reason
    assert "the best of them bs_roformer" in choice.reason


def test_nothing_better_missing_means_nothing_said_about_it():
    choice = separate.resolve_model(None, ["vocals", "instrumental"], available={"bs_roformer"})
    assert choice.downgraded is False
    assert "not installed" not in choice.reason
