"""The web's separator catalogue is the Python registry, generated.

The web app used to keep its own copy of `MODELS`, typed by hand and three
entries deep out of six, with a default named by string. That is how the
quality ordering stopped reaching the producer. These tests hold the generated
file to the registry and hold the generator to the rules the registry states
about itself.
"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from gen_stem_models import TS_PATH, ranked_models, render_ts, splits  # noqa: E402

from lockedgroove.stems.separate import (  # noqa: E402
    DEFAULT_STEMS,
    MODELS,
    TIER_RANK,
    best_model,
    resolve_model,
)


def test_generated_file_is_current():
    assert TS_PATH.exists(), "run scripts/gen_stem_models.py"
    assert TS_PATH.read_text() == render_ts(), "run scripts/gen_stem_models.py"


def test_every_model_reaches_the_web():
    """No model may be quietly withheld: the web listed three of six for months."""
    assert set(ranked_models()) == set(MODELS)


def test_models_are_rendered_best_first():
    ranked = ranked_models()
    tiers = [TIER_RANK[MODELS[m]["tier"]] for m in ranked]
    assert tiers == sorted(tiers)
    assert ranked[0] == "bs_roformer", "the reference tier leads"


def test_no_split_is_made_by_a_weak_or_stand_in_model():
    """Those tiers exist to label a row, never to be asked for."""
    for split in splits():
        assert MODELS[split["bestModel"]]["tier"] not in ("weak", "stand_in")


def test_kuielab_makes_no_split_of_its_own():
    """It is the model that cost 17.6 dB of 8-20 kHz on a real upload."""
    assert MODELS["kuielab_other"]["tier"] == "weak"
    assert ["other"] not in [s["stems"] for s in splits()]


def test_exactly_one_split_is_the_default_and_it_is_DEFAULT_STEMS():
    defaults = [s for s in splits() if s["isDefault"]]
    assert len(defaults) == 1
    assert set(defaults[0]["stems"]) == set(DEFAULT_STEMS)


def test_the_default_split_is_offered_first():
    assert splits()[0]["isDefault"]


def test_each_split_names_the_model_the_worker_would_pick():
    """The web's `bestModel` and `resolve_model` must not be able to disagree."""
    for split in splits():
        assert split["bestModel"] == best_model(split["stems"])
        choice = resolve_model(None, split["stems"], available=None)
        assert choice.model == split["bestModel"]


def test_every_model_listed_for_a_split_actually_makes_it():
    for split in splits():
        for model in split["models"]:
            assert set(split["stems"]) <= set(MODELS[model]["stems"])


def test_the_vocal_split_resolves_to_the_reference_tier():
    """The split that "de-trumpet this" leans on must not land on a U-net."""
    vocal = next(s for s in splits() if set(s["stems"]) == {"vocals", "instrumental"})
    assert vocal["bestTier"] == "reference"
    assert vocal["bestModel"] == "bs_roformer"


def test_an_sdr_is_never_rendered_without_its_basis():
    ts = TS_PATH.read_text()
    for model in ranked_models():
        spec = MODELS[model]
        if spec["sdr"] is not None:
            assert spec["sdr_basis"] in ts
