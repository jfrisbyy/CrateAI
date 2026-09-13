# Data sources

Every run of scripts/fetch_public_datasets.py appends a block here: what was fetched, from which
URLs, under what terms, and when. data/ is gitignored; this file is the provenance record.

## giantsteps_key — 2026-09-13T07:35:45Z

- annotation repository: https://github.com/GiantSteps/giantsteps-key-dataset @ `6bcd492c825ac9b8597bc650a5f6fd18b6c43d2b`
- item list: scripts/datasets/giantsteps_key.json (604 items; this run requested 3)
- license / terms: Annotations: GiantSteps project (JKU / UPF), Knees et al., ISMIR 2015, 'Two data sets for tempo estimation and key detection in electronic dance music annotated from user corrections'; tempo annotations_v2 from Schreiber & Mueller, ISMIR 2018. The annotation repositories carry no license file; cite the papers. Audio: 2-minute Beatport 'LOFI' preview clips, copyright their labels, fetched exactly as the dataset's own audio_dl.sh does; local evaluation only, never redistributed.
- audio URL patterns, tried in order: `https://www.cp.jku.at/datasets/giantsteps/backup/{name}.mp3`, `https://geo-samples.beatport.com/lofi/{name}.mp3`
- result: annotations fetched 3 (failed 0); audio fetched 0, already present 0, failed 3
- fetched URLs:
  - https://raw.githubusercontent.com/GiantSteps/giantsteps-key-dataset/6bcd492c825ac9b8597bc650a5f6fd18b6c43d2b/annotations/key/1004923.LOFI.key -> giantsteps_key/annotations/key/1004923.LOFI.key (ok)
  - https://raw.githubusercontent.com/GiantSteps/giantsteps-key-dataset/6bcd492c825ac9b8597bc650a5f6fd18b6c43d2b/annotations/key/1007941.LOFI.key -> giantsteps_key/annotations/key/1007941.LOFI.key (ok)
  - https://raw.githubusercontent.com/GiantSteps/giantsteps-key-dataset/6bcd492c825ac9b8597bc650a5f6fd18b6c43d2b/annotations/key/10089.LOFI.key -> giantsteps_key/annotations/key/10089.LOFI.key (ok)
  - https://geo-samples.beatport.com/lofi/1004923.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)
  - https://geo-samples.beatport.com/lofi/1007941.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)
  - https://geo-samples.beatport.com/lofi/10089.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)

## giantsteps_key — 2026-09-13T07:38:27Z

- annotation repository: https://github.com/GiantSteps/giantsteps-key-dataset @ `6bcd492c825ac9b8597bc650a5f6fd18b6c43d2b`
- item list: scripts/datasets/giantsteps_key.json (604 items; this run requested 3)
- license / terms: Annotations: GiantSteps project (JKU / UPF), Knees et al., ISMIR 2015, 'Two data sets for tempo estimation and key detection in electronic dance music annotated from user corrections'; tempo annotations_v2 from Schreiber & Mueller, ISMIR 2018. The annotation repositories carry no license file; cite the papers. Audio: 2-minute Beatport 'LOFI' preview clips, copyright their labels, fetched exactly as the dataset's own audio_dl.sh does; local evaluation only, never redistributed.
- audio URL patterns, tried in order: `https://www.cp.jku.at/datasets/giantsteps/backup/{name}.mp3`, `https://geo-samples.beatport.com/lofi/{name}.mp3`
- result: annotations fetched 0 (failed 0); audio fetched 0, already present 0, failed 3
- fetched URLs:
  - https://www.cp.jku.at/datasets/giantsteps/backup/1004923.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)
  - https://geo-samples.beatport.com/lofi/1004923.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)
  - https://www.cp.jku.at/datasets/giantsteps/backup/1007941.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)
  - https://geo-samples.beatport.com/lofi/1007941.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)
  - https://www.cp.jku.at/datasets/giantsteps/backup/10089.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)
  - https://geo-samples.beatport.com/lofi/10089.LOFI.mp3 (FAILED: URLError: Tunnel connection failed: 403 Forbidden)
