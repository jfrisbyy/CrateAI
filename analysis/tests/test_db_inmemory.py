"""InMemoryDatabase mirrors the schema's defaults and constraints; SupabaseDatabase speaks PostgREST."""

from __future__ import annotations

import json
import uuid

import numpy as np
import pytest

from lockedgroove.db import DatabaseError, InMemoryDatabase, SupabaseDatabase, filters_to_params, jsonable

USER = str(uuid.uuid4())


def _file_row(sha: str = "a" * 64, **over) -> dict:
    row = {"user_id": USER, "sha256": sha, "original_filename": "x.wav",
           "storage_path": f"library/{USER}/{sha[:2]}/{sha}.wav", "status": "queued"}
    row.update(over)
    return row


def test_insert_file_generates_id_and_defaults():
    db = InMemoryDatabase()
    row = db.insert_file(_file_row())
    uuid.UUID(row["id"])
    assert row["kind"] == "original"
    assert row["analysis_version"] == 0
    assert row["report"] is None
    assert row["created_at"] and row["updated_at"]
    assert db.get_file(row["id"]) == row


def test_insert_file_on_conflict_returns_existing_row():
    db = InMemoryDatabase()
    first = db.insert_file(_file_row())
    again = db.insert_file(_file_row(original_filename="different-name.wav"))
    assert again["id"] == first["id"]
    assert again["original_filename"] == "x.wav"
    assert db.count("files") == 1
    # a different user may hold the same hash
    other = db.insert_file(_file_row(user_id=str(uuid.uuid4())))
    assert other["id"] != first["id"]
    assert db.find_file(USER, "a" * 64)["id"] == first["id"]
    assert db.find_file(USER, "b" * 64) is None


def test_insert_rows_enforces_unique_constraints():
    db = InMemoryDatabase()
    db.insert_rows("files", [_file_row()])
    with pytest.raises(DatabaseError, match="duplicate"):
        db.insert_rows("files", [_file_row()])


def test_check_constraints_and_required_columns():
    db = InMemoryDatabase()
    with pytest.raises(DatabaseError, match="violates check"):
        db.insert_file(_file_row(status="bogus"))
    with pytest.raises(DatabaseError, match="violates check"):
        db.insert_job({"user_id": USER, "kind": "not-a-kind"})
    with pytest.raises(DatabaseError, match="required"):
        db.insert_job({"kind": "analyze"})
    with pytest.raises(DatabaseError, match="end_s"):
        db.insert_rows("loops", [{"user_id": USER, "file_id": "f", "start_s": 2.0, "end_s": 1.0}])
    with pytest.raises(DatabaseError, match="confidence"):
        db.insert_rows("tags", [{"user_id": USER, "file_id": "f", "tag": "x", "confidence": 1.5}])


def test_job_defaults_and_update():
    db = InMemoryDatabase()
    job = db.insert_job({"user_id": USER, "kind": "analyze"})
    assert job["status"] == "queued" and job["params"] == {} and job["result"] is None
    updated = db.update_job(job["id"], {"status": "running", "progress": 0.5})
    assert updated["status"] == "running" and updated["progress"] == 0.5
    assert db.get_job(job["id"])["status"] == "running"
    with pytest.raises(DatabaseError, match="violates check"):
        db.update_job(job["id"], {"status": "sideways"})
    with pytest.raises(DatabaseError, match="not found"):
        db.update_job(str(uuid.uuid4()), {"status": "done"})


def test_update_file_bumps_updated_at_and_returns_copies():
    db = InMemoryDatabase()
    row = db.insert_file(_file_row())
    row["status"] = "mutated-in-caller"  # must not leak into the store
    assert db.get_file(row["id"])["status"] == "queued"
    updated = db.update_file(row["id"], {"status": "ready", "report": {"schema_version": "3.0"}})
    assert updated["status"] == "ready"
    assert updated["updated_at"] >= updated["created_at"]
    fetched = db.get_file(row["id"])
    fetched["report"]["schema_version"] = "9.9"
    assert db.get_file(row["id"])["report"]["schema_version"] == "3.0"


def test_upsert_rows_merges_on_conflict_columns():
    db = InMemoryDatabase()
    f = db.insert_file(_file_row())
    a = db.upsert_rows("tags", [{"user_id": USER, "file_id": f["id"], "tag": "rhodes", "confidence": 0.4}],
                       on_conflict="file_id,tag,source")
    b = db.upsert_rows("tags", [{"user_id": USER, "file_id": f["id"], "tag": "rhodes", "confidence": 0.9},
                                {"user_id": USER, "file_id": f["id"], "tag": "dusty"}],
                       on_conflict="file_id,tag,source")
    assert a[0]["id"] == b[0]["id"]
    assert b[0]["confidence"] == 0.9 and b[0]["source"] == "model"
    assert b[1]["confidence"] == 1.0
    assert db.count("tags") == 2


def test_select_filters_limit_order_and_delete():
    db = InMemoryDatabase()
    f = db.insert_file(_file_row())
    g = db.insert_file(_file_row(sha="b" * 64, parent_file_id=f["id"], kind="stem"))
    loops = db.insert_rows("loops", [
        {"user_id": USER, "file_id": f["id"], "start_s": 0.0, "end_s": 2.0, "origin": "finder", "score": 0.5},
        {"user_id": USER, "file_id": f["id"], "start_s": 2.0, "end_s": 4.0, "origin": "finder", "score": 0.9},
        {"user_id": USER, "file_id": f["id"], "start_s": 4.0, "end_s": 6.0, "origin": "user"},
    ])
    assert len(loops) == 3
    assert [r["id"] for r in db.select("files", {"parent_file_id": None})] == [f["id"]]
    assert [r["id"] for r in db.select("files", {"kind": ["stem", "chop"]})] == [g["id"]]
    finder = db.select("loops", {"file_id": f["id"], "origin": "finder"}, order="score.desc")
    assert [r["score"] for r in finder] == [0.9, 0.5]
    assert len(db.select("loops", {"file_id": f["id"]}, limit=2)) == 2
    assert db.delete_rows("loops", {"file_id": f["id"], "origin": "finder"}) == 2
    assert [r["origin"] for r in db.select("loops")] == ["user"]
    with pytest.raises(DatabaseError, match="without filters"):
        db.delete_rows("loops", {})
    with pytest.raises(DatabaseError, match="without filters"):
        db.update_rows("loops", {}, {"name": "x"})


def test_numpy_values_are_stored_as_plain_json():
    db = InMemoryDatabase()
    job = db.insert_job({"user_id": USER, "kind": "analyze",
                         "params": {"bars": np.array([1, 2, 4]), "top_k": np.int64(12)}})
    assert job["params"] == {"bars": [1, 2, 4], "top_k": 12}
    db.update_job(job["id"], {"result": {"score": np.float32(0.5), "ids": (1, 2)}})
    stored = db.get_job(job["id"])["result"]
    json.dumps(stored)
    assert stored == {"score": 0.5, "ids": [1, 2]}
    assert jsonable({"a": {1, 2}}) in ({"a": [1, 2]}, {"a": [2, 1]})


def test_writes_log_is_available_to_tests():
    db = InMemoryDatabase()
    job = db.insert_job({"user_id": USER, "kind": "analyze"})
    db.update_job(job["id"], {"status": "running"})
    assert [op for op, table, _ in db.writes] == ["insert", "update"]
    assert db.writes_to("jobs", "update")[0]["status"] == "running"


# ---------------------------------------------------------------------------
# PostgREST client against a mock transport
# ---------------------------------------------------------------------------


def test_filters_to_params_postgrest_syntax():
    assert filters_to_params({"id": "abc", "parent": None, "kind": ["stem", "chop"], "muted": False}) == {
        "id": "eq.abc", "parent": "is.null", "kind": 'in.("stem","chop")', "muted": "eq.false",
    }


def _mock_db(handler):
    import httpx

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport, headers={
        "apikey": "svc", "Authorization": "Bearer svc", "Content-Type": "application/json"})
    return SupabaseDatabase("https://proj.supabase.co", "svc", client=client, retries=1)


def test_supabase_get_and_update_job_requests():
    import httpx

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": "j1", "kind": "analyze", "status": "queued"}])
        if request.method == "PATCH":
            body = json.loads(request.content)
            return httpx.Response(200, json=[{"id": "j1", **body}])
        return httpx.Response(500, text="unexpected")

    db = _mock_db(handler)
    job = db.get_job("j1")
    assert job["kind"] == "analyze"
    get = seen[0]
    assert get.url.path == "/rest/v1/jobs"
    assert get.url.params["id"] == "eq.j1" and get.url.params["select"] == "*" and get.url.params["limit"] == "1"
    assert get.headers["apikey"] == "svc" and get.headers["authorization"] == "Bearer svc"

    updated = db.update_job("j1", {"status": "running"})
    assert updated["status"] == "running"
    patch = seen[1]
    assert patch.method == "PATCH" and patch.url.params["id"] == "eq.j1"
    assert patch.headers["prefer"] == "return=representation"


def test_supabase_insert_file_falls_back_to_existing_row_on_conflict():
    import httpx

    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.method == "POST":
            return httpx.Response(201, json=[])  # ignore-duplicates: nothing inserted
        return httpx.Response(200, json=[{"id": "existing", "user_id": USER, "sha256": "a" * 64}])

    db = _mock_db(handler)
    row = db.insert_file(_file_row())
    assert row["id"] == "existing"
    post = seen[0]
    assert post.url.params["on_conflict"] == "user_id,sha256"
    assert "resolution=ignore-duplicates" in post.headers["prefer"]
    assert seen[1].method == "GET" and seen[1].url.params["sha256"] == "eq." + "a" * 64


def test_supabase_upsert_and_delete_and_errors():
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path.endswith("/tags"):
            assert request.url.params["on_conflict"] == "file_id,tag,source"
            assert "resolution=merge-duplicates" in request.headers["prefer"]
            return httpx.Response(201, json=[{"id": "t1"}])
        if request.method == "DELETE":
            assert request.url.params["origin"] == "eq.finder"
            return httpx.Response(200, json=[{"id": "l1"}, {"id": "l2"}])
        return httpx.Response(400, text="bad request")

    db = _mock_db(handler)
    assert db.upsert_rows("tags", [{"tag": "x"}], on_conflict="file_id,tag,source")[0]["id"] == "t1"
    assert db.delete_rows("loops", {"file_id": "f", "origin": "finder"}) == 2
    with pytest.raises(DatabaseError, match="400"):
        db.select("files", {"id": "nope"})
    with pytest.raises(DatabaseError, match="without filters"):
        db.delete_rows("loops", {})
