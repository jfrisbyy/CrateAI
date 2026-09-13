#!/usr/bin/env python3
"""Fetch the public evaluation datasets into data/<dataset>/ (gitignored), resumably.

    python scripts/fetch_public_datasets.py --list                      # what would be fetched, from where
    python scripts/fetch_public_datasets.py --dataset giantsteps_key --limit 3
    python scripts/fetch_public_datasets.py --dataset all

Datasets and sources (all logged to data/SOURCES.md with the fetch date):

  giantsteps_tempo  annotations  github.com/GiantSteps/giantsteps-tempo-dataset (pinned commit)
                    audio        the dataset's own audio_dl.sh sources, in its order: JKU mirror,
                                 then Beatport's documented preview URL geo-samples.beatport.com/lofi/<name>.mp3
  giantsteps_key    annotations  github.com/GiantSteps/giantsteps-key-dataset (pinned commit); audio as above
  ballroom          annotations  github.com/CPJKU/BallroomAnnotations (pinned commit)
                    audio        ISMIR 2004 tempo-induction contest tarball data1.tar.gz (md5 checked)

Item lists live in scripts/datasets/<dataset>.json (file names plus audio md5
sums copied from the annotation repos at the pinned commit), so --list works
offline and every audio download is checksum-verified. Annotations come from
the repository tarball at the pinned commit when that is reachable, else file
by file from raw.githubusercontent.com. Downloads resume with HTTP Range and
are skipped when the file is already present and valid.

This is developer tooling that lives outside the package on purpose: nothing
in the app can turn a URL into audio (principle 3). The audio is used locally
for evaluation and is never redistributed or uploaded anywhere.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
INDEX_DIR = ROOT / "scripts" / "datasets"
DEFAULT_DATA_DIR = ROOT / "data"
USER_AGENT = "lockedgroove-fetch/1 (+https://github.com/jfrisbyy/CrateAI; evaluation tooling)"
CHUNK = 1 << 20

GIANTSTEPS_LICENSE = (
    "Annotations: GiantSteps project (JKU / UPF), Knees et al., ISMIR 2015, 'Two data sets for tempo "
    "estimation and key detection in electronic dance music annotated from user corrections'; tempo "
    "annotations_v2 from Schreiber & Mueller, ISMIR 2018. The annotation repositories carry no license "
    "file; cite the papers. Audio: 2-minute Beatport 'LOFI' preview clips, copyright their labels, "
    "fetched exactly as the dataset's own audio_dl.sh does; local evaluation only, never redistributed."
)
BALLROOM_LICENSE = (
    "Audio: the Ballroom dataset of the ISMIR 2004 tempo induction contest (Gouyon et al., IEEE TASLP "
    "2006), 698 thirty-second excerpts distributed by MTG/UPF for research use. Beat and bar "
    "annotations: Krebs, Boeck, Widmer, ISMIR 2013, github.com/CPJKU/BallroomAnnotations, no license "
    "file; cite the paper and the pinned commit. Local evaluation only, never redistributed."
)


# --------------------------------------------------------------------------
# dataset specs
# --------------------------------------------------------------------------

@dataclass
class Spec:
    name: str
    index: dict[str, Any]
    license_note: str
    annotation_dirs: list[str]
    annotation_suffixes: list[str]
    audio_suffix: str
    audio_sources: list[str] = field(default_factory=list)
    """URL patterns with {name}, tried in order (GiantSteps)"""
    audio_tarball: dict[str, str] | None = None
    """{url, md5} for a single archive holding all audio (Ballroom)"""

    @property
    def repo(self) -> str:
        return self.index["repo"]

    @property
    def commit(self) -> str:
        return self.index["commit"]

    @property
    def names(self) -> list[str]:
        return [it["name"] for it in self.index["items"]]

    @property
    def md5s(self) -> dict[str, str]:
        return {it["name"]: it["md5"] for it in self.index["items"] if it.get("md5")}

    def tarball_url(self) -> str:
        return f"https://codeload.github.com/{self.repo}/tar.gz/{self.commit}"

    def raw_url(self, rel: str) -> str:
        return f"https://raw.githubusercontent.com/{self.repo}/{self.commit}/{rel}"

    def annotation_rel(self, name: str, dir_: str, suffix: str) -> str:
        return f"{name}{suffix}" if dir_ in (".", "") else f"{dir_}/{name}{suffix}"

    def annotation_local(self, data_dir: pathlib.Path, name: str, dir_: str, suffix: str) -> pathlib.Path:
        base = data_dir / self.name
        if dir_ in (".", ""):
            return base / "annotations" / f"{name}{suffix}"
        return base / dir_ / f"{name}{suffix}"


def load_specs() -> dict[str, Spec]:
    def index(name: str) -> dict[str, Any]:
        return json.loads((INDEX_DIR / f"{name}.json").read_text())

    gs_sources = [
        "https://www.cp.jku.at/datasets/giantsteps/backup/{name}.mp3",
        "https://geo-samples.beatport.com/lofi/{name}.mp3",
    ]
    return {
        "giantsteps_tempo": Spec("giantsteps_tempo", index("giantsteps_tempo"), GIANTSTEPS_LICENSE,
                                 ["annotations_v2/tempo", "annotations/tempo"], [".bpm", ".bpm"], ".mp3",
                                 audio_sources=gs_sources),
        "giantsteps_key": Spec("giantsteps_key", index("giantsteps_key"), GIANTSTEPS_LICENSE,
                               ["annotations/key"], [".key"], ".mp3", audio_sources=gs_sources),
        "ballroom": Spec("ballroom", index("ballroom"), BALLROOM_LICENSE, ["."], [".beats"], ".wav",
                         audio_tarball=index("ballroom")["audio_tarball"]),
    }


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

class FetchError(Exception):
    pass


def _open(url: str, headers: dict[str, str] | None = None, timeout: float = 60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def md5_of(path: pathlib.Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: pathlib.Path, md5: str | None = None, retries: int = 3,
             timeout: float = 60, log=None) -> dict[str, Any]:
    """Download ``url`` to ``dest`` resumably (``dest.part`` + Range), verify md5, return a log record.

    Permanent HTTP errors (403, 404, 410) are not retried; everything else backs off and retries.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    record: dict[str, Any] = {"url": url, "path": str(dest), "status": "failed", "bytes": 0, "resumed": False}
    last_error = "unknown"
    for attempt in range(1, retries + 1):
        have = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with _open(url, headers, timeout) as resp:
                status = resp.status
                if have and status == 206:
                    mode = "ab"
                    record["resumed"] = True
                elif status == 200:
                    mode, have = "wb", 0
                else:
                    raise FetchError(f"unexpected HTTP {status}")
                with open(part, mode) as fh:
                    while True:
                        chunk = resp.read(CHUNK)
                        if not chunk:
                            break
                        fh.write(chunk)
            if md5:
                got = md5_of(part)
                if got != md5:
                    part.unlink(missing_ok=True)
                    last_error = f"md5 mismatch (got {got[:8]}..., want {md5[:8]}...)"
                    if log:
                        log(f"    {last_error}; retrying")
                    continue
                record["md5"] = got
            part.replace(dest)
            record.update(status="ok", bytes=dest.stat().st_size)
            return record
        except urllib.error.HTTPError as exc:
            if exc.code == 416 and part.exists():
                # the server says our partial file is already complete
                if not md5 or md5_of(part) == md5:
                    part.replace(dest)
                    record.update(status="ok", bytes=dest.stat().st_size)
                    return record
                part.unlink(missing_ok=True)
            last_error = f"HTTP {exc.code}"
            if exc.code in (400, 401, 403, 404, 410):
                break
        except (urllib.error.URLError, TimeoutError, OSError, FetchError) as exc:
            last_error = f"{type(exc).__name__}: {getattr(exc, 'reason', exc)}"
        if attempt < retries:
            time.sleep(min(2 ** attempt, 15))
    record["error"] = last_error
    return record


# --------------------------------------------------------------------------
# annotations
# --------------------------------------------------------------------------

def missing_annotations(spec: Spec, data_dir: pathlib.Path, names: list[str]) -> list[tuple[str, str, str]]:
    out = []
    for dir_, suffix in zip(spec.annotation_dirs, spec.annotation_suffixes, strict=True):
        for name in names:
            if not spec.annotation_local(data_dir, name, dir_, suffix).exists():
                out.append((name, dir_, suffix))
    return out


def fetch_annotations_tarball(spec: Spec, data_dir: pathlib.Path, names: list[str], log) -> dict[str, Any] | None:
    """One codeload tarball at the pinned commit, extracted selectively. Returns the log record or None."""
    cache = data_dir / spec.name / "_cache" / f"{spec.repo.replace('/', '__')}-{spec.commit[:12]}.tar.gz"
    if not cache.exists():
        log(f"  annotations: downloading {spec.tarball_url()}")
        rec = download(spec.tarball_url(), cache, log=log)
        if rec["status"] != "ok":
            log(f"  annotations: tarball unavailable ({rec.get('error')}); falling back to per-file fetch")
            return None
    else:
        rec = {"url": spec.tarball_url(), "path": str(cache), "status": "ok", "cached": True}
    wanted = set(names)
    extracted = 0
    try:
        with tarfile.open(cache, "r:gz") as tar:
            for member in tar:
                if not member.isfile():
                    continue
                rel = member.name.split("/", 1)[1] if "/" in member.name else member.name
                for dir_, suffix in zip(spec.annotation_dirs, spec.annotation_suffixes, strict=True):
                    prefix = "" if dir_ in (".", "") else dir_ + "/"
                    if not rel.startswith(prefix) or not rel.endswith(suffix):
                        continue
                    name = rel[len(prefix): -len(suffix)]
                    if "/" in name or name not in wanted:
                        continue
                    dest = spec.annotation_local(data_dir, name, dir_, suffix)
                    if dest.exists():
                        continue
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    src = tar.extractfile(member)
                    if src is None:
                        continue
                    with src, open(dest, "wb") as fh:
                        shutil.copyfileobj(src, fh)
                    extracted += 1
    except (tarfile.TarError, OSError) as exc:
        log(f"  annotations: bad tarball ({exc}); removing it and falling back to per-file fetch")
        cache.unlink(missing_ok=True)
        return None
    rec["extracted"] = extracted
    log(f"  annotations: {extracted} file(s) extracted from the tarball")
    return rec


def fetch_annotations_raw(spec: Spec, data_dir: pathlib.Path, todo: list[tuple[str, str, str]], jobs: int,
                          log) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    def one(entry: tuple[str, str, str]) -> dict[str, Any]:
        name, dir_, suffix = entry
        url = spec.raw_url(spec.annotation_rel(name, dir_, suffix))
        return download(url, spec.annotation_local(data_dir, name, dir_, suffix), retries=2, timeout=30)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        for i, rec in enumerate(pool.map(one, todo), 1):
            records.append(rec)
            if rec["status"] != "ok":
                log(f"    annotation failed: {rec['url']} ({rec.get('error')})")
            elif i % 50 == 0 or i == len(todo):
                log(f"  annotations: {i}/{len(todo)}")
    return records


# --------------------------------------------------------------------------
# audio
# --------------------------------------------------------------------------

def audio_local(spec: Spec, data_dir: pathlib.Path, name: str) -> pathlib.Path:
    return data_dir / spec.name / "audio" / f"{name}{spec.audio_suffix}"


def fetch_audio_files(spec: Spec, data_dir: pathlib.Path, names: list[str], jobs: int, verify: bool,
                      log) -> list[dict[str, Any]]:
    md5s = spec.md5s

    def one(name: str) -> dict[str, Any]:
        dest = audio_local(spec, data_dir, name)
        want = md5s.get(name) if verify else None
        if dest.exists():
            if not want or md5_of(dest) == want:
                return {"name": name, "path": str(dest), "status": "present", "url": None}
            dest.unlink()
        attempts: list[dict[str, Any]] = []
        for pattern in spec.audio_sources:
            url = pattern.format(name=name)
            rec = download(url, dest, md5=want, retries=2, timeout=60)
            rec["name"] = name
            if rec["status"] == "ok":
                rec["attempts"] = attempts
                return rec
            attempts.append({"url": url, "error": rec.get("error")})
        return {"name": name, "status": "failed", "url": attempts[-1]["url"] if attempts else None,
                "error": "; ".join(f"{a['url']}: {a['error']}" for a in attempts) or "no sources",
                "attempts": attempts}

    records: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        for i, rec in enumerate(pool.map(one, names), 1):
            records.append(rec)
            if rec["status"] == "failed":
                log(f"    audio failed: {rec['name']} ({rec.get('error')})")
            if i % 25 == 0 or i == len(names):
                ok = sum(1 for r in records if r["status"] in ("ok", "present"))
                log(f"  audio: {i}/{len(names)} ({ok} available)")
    return records


def fetch_audio_tarball(spec: Spec, data_dir: pathlib.Path, names: list[str], log) -> list[dict[str, Any]]:
    """Ballroom: one 1.5 GB tarball, md5-verified, then the requested wavs extracted."""
    assert spec.audio_tarball
    url, md5 = spec.audio_tarball["url"], spec.audio_tarball.get("md5")
    base = data_dir / spec.name
    wanted = {n: None for n in names}
    for p in base.rglob(f"*{spec.audio_suffix}"):
        if p.stem in wanted and "_cache" not in p.parts:
            wanted[p.stem] = p
    todo = [n for n, p in wanted.items() if p is None]
    records = [{"name": n, "path": str(p), "status": "present", "url": None} for n, p in wanted.items() if p]
    if not todo:
        return records
    cache = base / "_cache" / pathlib.PurePosixPath(url).name
    if not cache.exists():
        log(f"  audio: downloading {url} (about 1.5 GB, resumable, md5-checked)")
        rec = download(url, cache, md5=md5, retries=5, timeout=120, log=log)
        if rec["status"] != "ok":
            log(f"  audio: tarball unavailable ({rec.get('error')})")
            return records + [{"name": n, "status": "failed", "url": url, "error": rec.get("error")} for n in todo]
    extracted = 0
    try:
        with tarfile.open(cache, "r:gz") as tar:
            for member in tar:
                if not member.isfile():
                    continue
                stem = pathlib.PurePosixPath(member.name).stem
                if not member.name.endswith(spec.audio_suffix) or stem not in wanted or wanted[stem] is not None:
                    if member.name.endswith("allBallroomFiles") and not (base / "allBallroomFiles").exists():
                        src = tar.extractfile(member)
                        if src:
                            (base / "allBallroomFiles").write_bytes(src.read())
                    continue
                rel = pathlib.PurePosixPath(member.name)
                parts = rel.parts[rel.parts.index("BallroomData"):] if "BallroomData" in rel.parts else ("BallroomData", *rel.parts[-2:])
                dest = base.joinpath(*parts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                src = tar.extractfile(member)
                if src is None:
                    continue
                with src, open(dest, "wb") as fh:
                    shutil.copyfileobj(src, fh)
                wanted[stem] = dest
                records.append({"name": stem, "path": str(dest), "status": "ok", "url": url})
                extracted += 1
    except (tarfile.TarError, OSError) as exc:
        log(f"  audio: bad tarball ({exc}); removing it so the next run re-downloads")
        cache.unlink(missing_ok=True)
    log(f"  audio: {extracted} wav(s) extracted")
    records += [{"name": n, "status": "failed", "url": url, "error": "not in tarball"} for n, p in wanted.items() if p is None]
    return records


# --------------------------------------------------------------------------
# orchestration and logging
# --------------------------------------------------------------------------

def append_sources_log(data_dir: pathlib.Path, spec: Spec, fetched_at: str, annotation_records: list[dict[str, Any]],
                       audio_records: list[dict[str, Any]], names: list[str]) -> pathlib.Path:
    path = data_dir / "SOURCES.md"
    if not path.exists():
        path.write_text(
            "# Data sources\n\n"
            "Every run of scripts/fetch_public_datasets.py appends a block here: what was fetched, from which\n"
            "URLs, under what terms, and when. data/ is gitignored; this file is the provenance record.\n"
        )
    lines = [
        "",
        f"## {spec.name} — {fetched_at}",
        "",
        f"- annotation repository: https://github.com/{spec.repo} @ `{spec.commit}`",
        f"- item list: scripts/datasets/{spec.name}.json ({len(spec.names)} items; this run requested {len(names)})",
        f"- license / terms: {spec.license_note}",
    ]
    if spec.audio_sources:
        lines.append("- audio URL patterns, tried in order: " + ", ".join(f"`{p}`" for p in spec.audio_sources))
    if spec.audio_tarball:
        lines.append(f"- audio archive: {spec.audio_tarball['url']} (md5 {spec.audio_tarball.get('md5')})")
    ann_ok = [r for r in annotation_records if r.get("status") == "ok"]
    ann_bad = [r for r in annotation_records if r.get("status") != "ok"]
    aud_ok = [r for r in audio_records if r.get("status") == "ok"]
    aud_present = [r for r in audio_records if r.get("status") == "present"]
    aud_bad = [r for r in audio_records if r.get("status") == "failed"]
    lines.append(f"- result: annotations fetched {len(ann_ok)} (failed {len(ann_bad)}); audio fetched {len(aud_ok)}, "
                 f"already present {len(aud_present)}, failed {len(aud_bad)}")
    lines.append("- fetched URLs:")
    for r in ann_ok + aud_ok:
        extra = f", md5 {r['md5'][:8]}…" if r.get("md5") else ""
        extra += f", {r['extracted']} files extracted" if "extracted" in r else ""
        lines.append(f"  - {r['url']} -> {pathlib.Path(r['path']).relative_to(data_dir)} (ok{extra})")
    for r in ann_bad + aud_bad:
        for a in r.get("attempts") or [{"url": r.get("url"), "error": r.get("error")}]:
            lines.append(f"  - {a.get('url')} (FAILED: {a.get('error')})")
    with open(path, "a") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def write_manifest(spec: Spec, data_dir: pathlib.Path, fetched_at: str, names: list[str],
                   audio_records: list[dict[str, Any]]) -> pathlib.Path:
    by_name = {r["name"]: r for r in audio_records if "name" in r}
    items = []
    for name in names:
        ann = {}
        for dir_, suffix in zip(spec.annotation_dirs, spec.annotation_suffixes, strict=True):
            p = spec.annotation_local(data_dir, name, dir_, suffix)
            ann[dir_] = str(p.relative_to(data_dir / spec.name)) if p.exists() else None
        rec = by_name.get(name, {})
        audio = rec.get("path")
        items.append({
            "name": name,
            "annotations": ann,
            "audio": str(pathlib.Path(audio).relative_to(data_dir / spec.name)) if audio else None,
            "audio_url": rec.get("url"),
            "status": "ok" if audio and all(ann.values()) else ("missing_audio" if not audio else "missing_annotation"),
            "error": rec.get("error"),
        })
    manifest = {"dataset": spec.name, "fetched_at": fetched_at, "repo": spec.repo, "commit": spec.commit,
                "license": spec.license_note, "items": items}
    path = data_dir / spec.name / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=1))
    return path


def fetch_dataset(spec: Spec, data_dir: pathlib.Path, limit: int | None, jobs: int, verify: bool,
                  no_audio: bool, log) -> bool:
    names = spec.names[:limit] if limit is not None else spec.names
    fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    log(f"[{spec.name}] {len(names)} item(s) from https://github.com/{spec.repo} @ {spec.commit[:12]}")

    annotation_records: list[dict[str, Any]] = []
    todo = missing_annotations(spec, data_dir, names)
    if todo:
        rec = fetch_annotations_tarball(spec, data_dir, names, log)
        if rec is not None:
            annotation_records.append(rec)
            todo = missing_annotations(spec, data_dir, names)
        if todo:
            log(f"  annotations: fetching {len(todo)} file(s) from raw.githubusercontent.com")
            annotation_records += fetch_annotations_raw(spec, data_dir, todo, jobs, log)
    else:
        log("  annotations: all present")

    audio_records: list[dict[str, Any]] = []
    if no_audio:
        log("  audio: skipped (--no-audio)")
    elif spec.audio_tarball:
        audio_records = fetch_audio_tarball(spec, data_dir, names, log)
    else:
        audio_records = fetch_audio_files(spec, data_dir, names, jobs, verify, log)

    manifest = write_manifest(spec, data_dir, fetched_at, names, audio_records)
    sources = append_sources_log(data_dir, spec, fetched_at, annotation_records, audio_records, names)
    n_ok = sum(1 for it in json.loads(manifest.read_text())["items"] if it["status"] == "ok")
    ann_failed = sum(1 for r in annotation_records if r.get("status") != "ok")
    aud_failed = sum(1 for r in audio_records if r.get("status") == "failed")
    log(f"[{spec.name}] {n_ok}/{len(names)} complete (annotation failures {ann_failed}, audio failures {aud_failed}); "
        f"manifest {manifest.relative_to(ROOT) if manifest.is_relative_to(ROOT) else manifest}, log {sources}")
    return ann_failed == 0 and aud_failed == 0


def print_listing(specs: list[Spec], limit: int | None, data_dir: pathlib.Path) -> None:
    for spec in specs:
        names = spec.names[:limit] if limit is not None else spec.names
        present = sum(1 for n in names if audio_local(spec, data_dir, n).exists()) if not spec.audio_tarball else \
            sum(1 for p in (data_dir / spec.name).rglob(f"*{spec.audio_suffix}") if p.stem in set(names)) \
            if (data_dir / spec.name).exists() else 0
        print(f"== {spec.name}: {len(names)} of {len(spec.names)} items ({present} audio files already present)")
        print(f"   annotations: https://github.com/{spec.repo} @ {spec.commit}")
        print(f"     tarball  {spec.tarball_url()}")
        for dir_, suffix in zip(spec.annotation_dirs, spec.annotation_suffixes, strict=True):
            print(f"     per file {spec.raw_url(spec.annotation_rel('<name>', dir_, suffix))}")
        if spec.audio_sources:
            for i, pattern in enumerate(spec.audio_sources):
                print(f"   audio source {i + 1}: {pattern}" + ("  (md5-verified against scripts/datasets)" if i == 0 else ""))
        if spec.audio_tarball:
            print(f"   audio archive: {spec.audio_tarball['url']} (md5 {spec.audio_tarball.get('md5')}, ~1.5 GB)")
        print(f"   license: {spec.license_note}")
        shown = names if limit is not None else names[:3]
        for n in shown:
            if spec.audio_sources:
                print(f"     {n}: {spec.audio_sources[0].format(name=n)}")
            else:
                print(f"     {n}: BallroomData/<Genre>/{n}{spec.audio_suffix} from the archive; "
                      f"{spec.raw_url(spec.annotation_rel(n, spec.annotation_dirs[0], spec.annotation_suffixes[0]))}")
        if limit is None and len(names) > 3:
            print(f"     ... {len(names) - 3} more")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dataset", action="append", default=None,
                    help="giantsteps_tempo | giantsteps_key | ballroom | all (repeat or comma-separate); default all")
    ap.add_argument("--limit", type=int, default=None, help="first N items of each dataset (Ballroom still downloads the whole archive)")
    ap.add_argument("--list", action="store_true", help="print what would be fetched and from where; no network")
    ap.add_argument("--data-dir", type=pathlib.Path, default=DEFAULT_DATA_DIR)
    ap.add_argument("--jobs", type=int, default=4, help="parallel per-file downloads")
    ap.add_argument("--no-verify", action="store_true", help="skip md5 verification of GiantSteps audio")
    ap.add_argument("--no-audio", action="store_true", help="annotations only")
    args = ap.parse_args(argv)

    specs = load_specs()
    wanted: list[str] = []
    for chunk in args.dataset or ["all"]:
        for name in chunk.split(","):
            name = name.strip()
            if name == "all":
                wanted = list(specs)
            elif name in specs:
                if name not in wanted:
                    wanted.append(name)
            elif name:
                print(f"unknown dataset {name!r}; choose from {', '.join(specs)} or all", file=sys.stderr)
                return 2
    selected = [specs[n] for n in wanted]
    if args.list:
        print_listing(selected, args.limit, args.data_dir)
        return 0
    ok = True
    for spec in selected:
        ok = fetch_dataset(spec, args.data_dir, args.limit, args.jobs, not args.no_verify, args.no_audio, print) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
