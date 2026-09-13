"""The ``export`` job end to end: storage in, zip out, and who is allowed to be in it.

Runs against the in-memory database and a local bucket, through the real
``run_job`` lifecycle, so the ``usage_events`` row and the failure path are
asserted the same way every other job's are.
"""

from __future__ import annotations

import io
import json
import types
import uuid
import zipfile

import numpy as np
import pytest
import soundfile as sf

from lockedgroove.db import InMemoryDatabase
from lockedgroove.ingest import sha256_file
from lockedgroove.jobs import run_job
from lockedgroove.storage import LocalStorage
from lockedgroove.testing.synth import Pattern, drum_loop, to_stereo

USER = str(uuid.uuid4())
OTHER = str(uuid.uuid4())
SR = 22050


def _upload(storage, tmp_path, db, user, name, seconds=4.0, kind="original", prefix="library"):
    y = to_stereo(drum_loop(90.0, 2, Pattern.boom_bap(), sr=SR), width=0.2)
    need = int(seconds * SR)
    while y.shape[1] < need:
        y = np.concatenate([y, y], axis=1)
    y = y[:, :need]
    wav = tmp_path / f"{name}.wav"
    sf.write(wav, y.T, SR, subtype="PCM_16")
    sha = sha256_file(str(wav))
    path = (f"library/{user}/{sha[:2]}/{sha}.wav" if prefix == "library"
            else f"derived/{user}/{uuid.uuid4()}/{name}.wav")
    storage.upload(path, str(wav))
    return db.insert_file({"user_id": user, "sha256": sha, "original_filename": f"{name}.wav",
                           "storage_path": path, "status": "ready", "duration_s": seconds,
                           "sample_rate": SR, "channels": 2, "kind": kind})


@pytest.fixture
def world(tmp_path):
    storage = LocalStorage(tmp_path / "bucket")
    db = InMemoryDatabase()
    drums = _upload(storage, tmp_path, db, USER, "Masquerade")
    horns = _upload(storage, tmp_path, db, USER, "Moonlight")
    return types.SimpleNamespace(db=db, storage=storage, drums=drums, horns=horns, tmp=tmp_path)


def region(file_id, **over):
    base = {"id": f"r-{uuid.uuid4().hex[:6]}", "file_id": file_id, "start_s": 0.0,
            "duration_s": 2.0, "offset_s": 0.0}
    base.update(over)
    return base


def song_params(world, **over):
    song = {
        "name": "Midnight Flip",
        "bpm": 92.0,
        "beats_per_bar": 4,
        "master_gain": 1.0,
        "key": {"tonic": "F", "mode": "minor", "from_file_name": "Masquerade"},
        "tracks": [
            {"id": "t1", "name": "Drums", "position": 0, "gain": 0.8,
             "provenance": "Masquerade, drums",
             "regions": [region(world.drums["id"], start_s=0.0, duration_s=2.0,
                                lineage_line="Masquerade / drums / bars 1-4",
                                lineage={"file_name": "Masquerade", "stem": "drums",
                                         "separation_model": "roformer-x", "source_bpm": 95.4})]},
            {"id": "t2", "name": "Horns", "position": 1,
             "regions": [region(world.horns["id"], start_s=2.0, duration_s=2.0)]},
        ],
    }
    song.update(over.pop("song", {}))
    params = {"song": song, "format": "flac", "bit_depth": 24, "sample_rate": 44100}
    params.update(over)
    return params


def run_export(world, **over):
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued",
                               "params": song_params(world, **over)})
    return run_job(job["id"], world.db, world.storage)


def zip_of(world, final):
    local = world.storage.download(final["result"]["storage_path"])
    return zipfile.ZipFile(local)


def test_the_zip_holds_a_stem_per_lane_a_tempo_map_a_readme_and_a_manifest(world):
    final = run_export(world)
    assert final["status"] == "done", final.get("error")
    result = final["result"]
    assert result["storage_path"] == f"derived/{USER}/bundles/{final['id']}.zip"
    with zip_of(world, final) as zf:
        names = sorted(zf.namelist())
    folder = "Midnight-Flip_92bpm_Fm"
    assert names == [
        f"{folder}/README.txt",
        f"{folder}/song.json",
        f"{folder}/stems/01_Drums_92bpm_Fm.flac",
        f"{folder}/stems/02_Horns_92bpm_Fm.flac",
        f"{folder}/tempo_map.mid",
        f"{folder}/tempo_map.txt",
    ]


def test_every_stem_is_the_same_length_so_they_line_up_dropped_at_zero(world):
    final = run_export(world)
    lengths = set()
    with zip_of(world, final) as zf:
        for name in zf.namelist():
            if name.endswith(".flac"):
                y, sr = sf.read(io.BytesIO(zf.read(name)), always_2d=True)
                lengths.add((y.shape[0], sr, y.shape[1]))
    assert len(lengths) == 1
    (frames, sr, channels) = lengths.pop()
    assert sr == 44100 and channels == 2
    assert frames == final["result"]["length_samples"] == round(4.0 * 44100)


def test_a_lane_is_silent_where_it_is_not_sounding(world):
    final = run_export(world)
    with zip_of(world, final) as zf:
        horns, sr = sf.read(io.BytesIO(zf.read("Midnight-Flip_92bpm_Fm/stems/02_Horns_92bpm_Fm.flac")),
                            always_2d=True)
    # the Horns lane starts at 2 s; everything before it is digital silence
    assert np.max(np.abs(horns[: 2 * sr - 1])) == 0.0
    assert np.max(np.abs(horns[2 * sr:])) > 0.0


def test_the_readme_carries_the_lineage_and_the_manifest_carries_it_as_data(world):
    final = run_export(world)
    with zip_of(world, final) as zf:
        readme = zf.read("Midnight-Flip_92bpm_Fm/README.txt").decode()
        manifest = json.loads(zf.read("Midnight-Flip_92bpm_Fm/song.json"))
    assert "Masquerade / drums / bars 1-4" in readme
    assert "roformer-x" in readme
    assert "92 BPM" in readme
    assert manifest["stems"][0]["regions"][0]["lineage"]["separation_model"] == "roformer-x"
    assert manifest["stems"][0]["regions"][0]["start_bar"] == 1.0
    assert manifest["song"]["key"]["tonic"] == "F"


def test_wav_is_available_and_is_bigger_than_flac_for_the_same_song(world):
    flac = run_export(world)["result"]["size_bytes"]
    wav = run_export(world, format="wav")["result"]["size_bytes"]
    assert wav > flac


def test_sixteen_bit_is_available_for_getting_under_the_cap(world):
    final = run_export(world, bit_depth=16)
    with zip_of(world, final) as zf:
        info = sf.info(io.BytesIO(zf.read("Midnight-Flip_92bpm_Fm/stems/01_Drums_92bpm_Fm.flac")))
    assert info.subtype == "PCM_16"


def test_a_muted_lane_is_left_out_and_named_in_the_result_and_the_readme(world):
    params = song_params(world)
    params["song"]["tracks"][1]["muted"] = True
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "done", final.get("error")
    assert final["result"]["not_exported"] == [{"name": "Horns", "reason": "muted"}]
    with zip_of(world, final) as zf:
        assert not any("Horns" in n and n.endswith(".flac") for n in zf.namelist())
        assert "Horns" in zf.read("Midnight-Flip_92bpm_Fm/README.txt").decode()


def test_include_muted_brings_the_lane_back(world):
    params = song_params(world, include_muted=True)
    params["song"]["tracks"][1]["muted"] = True
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    with zip_of(world, final) as zf:
        assert any("Horns" in n and n.endswith(".flac") for n in zf.namelist())


def test_a_session_with_no_tempo_gets_no_tempo_map_and_says_why(world):
    final = run_export(world, song={"bpm": None, "key": None})
    with zip_of(world, final) as zf:
        names = zf.namelist()
        readme = zf.read("Midnight-Flip/README.txt").decode()
    assert not any(n.endswith("tempo_map.mid") for n in names)
    assert final["result"]["tempo_map"] is False
    assert "no measured tempo" in readme


def test_the_midi_the_session_references_is_in_the_zip(world):
    path = f"derived/{USER}/{world.drums['id']}/midi/drums.mid"
    world.storage.put_bytes(path, b"MThd-not-really-midi")
    midi = world.db.insert_rows("midi", [{"user_id": USER, "source_file_id": world.drums["id"],
                                          "kind": "drums", "storage_path": path}])[0]
    final = run_export(world, midi_ids=[midi["id"]])
    assert final["status"] == "done", final.get("error")
    with zip_of(world, final) as zf:
        assert "Midnight-Flip_92bpm_Fm/midi/01_Drums_drums.mid" in zf.namelist()
        assert zf.read("Midnight-Flip_92bpm_Fm/midi/01_Drums_drums.mid") == b"MThd-not-really-midi"


# --- ownership: principle 6 ----------------------------------------------------


def test_a_song_that_references_another_users_record_fails_and_reads_nothing(world, tmp_path):
    victim = _upload(world.storage, tmp_path, world.db, OTHER, "Secret")
    params = song_params(world)
    params["song"]["tracks"][1]["regions"][0]["file_id"] = victim["id"]
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed"
    assert "does not belong to this user" in final["error"]
    assert final.get("result") is None


def test_a_row_whose_storage_path_points_outside_the_users_prefix_is_refused(world, tmp_path):
    # The files row is the caller's; only the path gives it away. This is the
    # shape the kit export once got wrong by trusting the path and fetching
    # with the service role.
    victim = _upload(world.storage, tmp_path, world.db, OTHER, "Secret")
    pointer = world.db.insert_file({"user_id": USER, "sha256": "f" * 64, "original_filename": "stolen.wav",
                                    "storage_path": victim["storage_path"], "status": "ready"})
    params = song_params(world)
    params["song"]["tracks"][1]["regions"][0]["file_id"] = pointer["id"]
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed"
    assert "outside this user's storage prefix" in final["error"]


def test_another_users_midi_cannot_be_smuggled_into_the_zip(world):
    path = f"derived/{OTHER}/x/midi/drums.mid"
    world.storage.put_bytes(path, b"someone-elses")
    midi = world.db.insert_rows("midi", [{"user_id": OTHER, "source_file_id": None, "kind": "drums",
                                          "storage_path": path}])[0]
    final = run_export(world, midi_ids=[midi["id"]])
    assert final["status"] == "failed"
    assert "does not belong to this user" in final["error"]


def test_a_missing_record_names_itself_rather_than_rendering_silence(world):
    params = song_params(world)
    params["song"]["tracks"][0]["regions"][0]["file_id"] = str(uuid.uuid4())
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed" and "no longer exists" in final["error"]


# --- refusals ------------------------------------------------------------------


def test_a_song_over_the_cap_is_refused_before_a_single_sample_is_rendered(world):
    params = song_params(world, format="wav", bit_depth=24)
    params["song"]["tracks"] = [
        {"id": f"t{i}", "name": f"L{i}", "position": i,
         "regions": [region(world.drums["id"], start_s=0.0, duration_s=890.0)]}
        for i in range(20)
    ]
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed"
    assert "cap is" in final["error"] and "FLAC" in final["error"]
    assert world.storage.exists(f"derived/{USER}/bundles/{final['id']}.zip") is False


def test_a_song_where_every_lane_is_muted_says_so(world):
    params = song_params(world)
    for track in params["song"]["tracks"]:
        track["muted"] = True
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed" and "every lane" in final["error"]


@pytest.mark.parametrize("bad", [{"format": "mp3"}, {"bit_depth": 32}, {"sample_rate": 96000}])
def test_a_format_the_export_does_not_write_is_refused_by_name(world, bad):
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued",
                               "params": song_params(world, **bad)})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed" and "must be one of" in final["error"]


def test_a_url_in_the_params_is_refused_like_every_other_job(world):
    params = song_params(world)
    params["source_url"] = "https://example.com/track.mp3"
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed" and "principle 3" in final["error"]


# --- metering ------------------------------------------------------------------


def test_an_export_is_metered_as_cpu_time_like_every_other_cpu_job(world):
    final = run_export(world)
    events = world.db.select("usage_events", {"job_id": final["id"]})
    assert [e["kind"] for e in events] == ["cpu_seconds"]
    assert events[0]["user_id"] == USER and events[0]["amount"] >= 0


def test_a_failed_export_is_still_metered(world):
    params = song_params(world)
    params["song"]["tracks"][0]["regions"][0]["file_id"] = str(uuid.uuid4())
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    assert final["status"] == "failed"
    assert world.db.select("usage_events", {"job_id": final["id"]})


def test_the_export_writes_no_files_row_because_it_is_not_a_library_entry(world):
    before = len(world.db.select("files", {"user_id": USER}))
    run_export(world)
    assert len(world.db.select("files", {"user_id": USER})) == before


def test_a_held_back_lane_keeps_its_place_in_the_song_not_in_the_leftovers(world):
    params = song_params(world)
    params["song"]["tracks"][1]["muted"] = True
    job = world.db.insert_job({"user_id": USER, "kind": "export", "status": "queued", "params": params})
    final = run_job(job["id"], world.db, world.storage)
    with zip_of(world, final) as zf:
        readme = zf.read("Midnight-Flip_92bpm_Fm/README.txt").decode()
        manifest = json.loads(zf.read("Midnight-Flip_92bpm_Fm/song.json"))
    assert "02  Horns  (muted)" in readme  # the second lane of the song, not the first leftover
    assert manifest["not_exported"][0]["position"] == 2
