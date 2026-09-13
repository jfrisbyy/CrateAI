# Accuracy harness — 2026-09-13T16:42:40Z

datasets: ['synthetic']; workers: 3; ci: False

| dataset | items | bpm_exact | bpm_octave | key_exact | key_relative | downbeat | structure_f |
|---|---:|---:|---:|---:|---:|---:|---:|
| synthetic | 48 | 0.562 (48) | 1.000 (48) | 0.833 (48) | 1.000 (48) | 0.792 (48) | 0.931 (48) |

Score = hits/n for the boolean metrics, mean F for `structure_f`; (n) = items the metric applied to.


## Misses by reason

- `synthetic.bpm_exact`: off by -75.0 BPM ×2; off by -87.5 BPM ×2; off by +64.7 BPM ×1
- `synthetic.key_exact`: predicted F# major ×2; predicted G major ×1; predicted A# major ×1
- `synthetic.downbeat`: median offset 675 ms ×1; median offset 476 ms ×1; median offset 432 ms ×1
- `synthetic.structure_f`: P=1.00 R=0.67 ×15; P=0.67 R=0.67 ×1

## Gates

| gate | score | threshold | n | result |
|---|---:|---:|---:|---|
| synthetic.bpm_exact | 0.562 | 0.50 | 48 | PASS |
| synthetic.bpm_octave | 1.000 | 0.95 | 48 | PASS |
| synthetic.key_exact | 0.833 | 0.65 | 48 | PASS |
| synthetic.key_relative | 1.000 | 0.85 | 48 | PASS |
| synthetic.downbeat | 0.792 | 0.75 | 48 | PASS |
| synthetic.structure_f | 0.931 | 0.60 | 48 | PASS |

**Gate verdict: PASS**
