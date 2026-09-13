import numpy as np
import pytest

from lockedgroove.analysis.tags import VOCABULARY, zero_shot_tags
from lockedgroove.analysis.tags import run as tags_run
from lockedgroove.embeddings.clap import CLAP_DIM, HashEmbedder, cosine, get_embedder, l2, set_embedder
from lockedgroove.pipeline import Context, analyze_array
from lockedgroove.report import AnalysisReport
from lockedgroove.testing.synth import Pattern, drum_loop, tone

SR = 22050


class RhodesEmbedder:
    """A fake whose text space places 'rhodes' where a warm tone's audio lands."""

    name = "fake-rhodes"

    def __init__(self):
        self.h = HashEmbedder()

    def embed_audio(self, y, sr):
        return self.h.embed_text(["the sound of rhodes"])[0]

    def embed_text(self, texts):
        return self.h.embed_text(texts)


def test_hash_embedder_shapes_and_determinism():
    e = HashEmbedder()
    a = e.embed_audio(tone(60, 1.0, SR), SR)
    b = e.embed_audio(tone(60, 1.0, SR), SR)
    assert a.shape == (CLAP_DIM,) and np.allclose(a, b)
    assert abs(np.linalg.norm(a) - 1) < 1e-5
    t = e.embed_text(["dusty soul", "dusty soul", "bright synth"])
    assert t.shape == (3, CLAP_DIM) and np.allclose(t[0], t[1]) and cosine(t[0], t[2]) < 0.5
    assert cosine(l2(np.ones(3)), np.ones(3)) == pytest.approx(1.0)


def test_zero_shot_ranks_matching_term_first():
    e = RhodesEmbedder()
    tags = zero_shot_tags(e.embed_audio(None, SR), e)
    assert tags[0].tag == "rhodes" and tags[0].confidence >= 0.5
    assert all(t.source == "model" for t in tags)
    assert len(tags) <= 8 and len(VOCABULARY) >= 120


def test_tags_stage_uses_context_embedder_and_pipeline_tolerates_absence(monkeypatch):
    ctx = Context(report=AnalysisReport.empty(), sr=SR, options={"embedder": RhodesEmbedder()})
    out = tags_run(drum_loop(90, 1, Pattern.kick_on_one(), SR), SR, ctx)
    assert out[0].tag == "rhodes" and "audio_embedding" in ctx.options
    set_embedder(None)
    monkeypatch.delenv("LOCKEDGROOVE_FAKE_EMBEDDER", raising=False)
    try:
        import laion_clap  # noqa: F401
        pytest.skip("laion-clap installed; absence path not testable")
    except ImportError:
        pass
    with pytest.raises(ImportError):
        get_embedder()
    report, c = analyze_array(drum_loop(90, 1, Pattern.kick_on_one(), SR), SR, stages=["tags"], return_context=True)
    assert report.tags == [] and "tags" in c.errors
    monkeypatch.setenv("LOCKEDGROOVE_FAKE_EMBEDDER", "1")
    assert get_embedder().name == "hash-fake"
    set_embedder(None)
