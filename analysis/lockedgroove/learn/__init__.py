"""What the product learns from one producer's own corrections.

Principle 7 says corrections are ground truth, that the table is per-user, and
that it never crosses users. Until now nothing read it back: the accuracy
harness was the only consumer, so a producer's edits improved our scoreboard
and never their next result.

This package is the read side, and it is deliberately small. Nothing here
trains a model, reads audio, or touches another account's rows. It reads a few
hundred rows for one ``user_id``, turns them into a handful of bounded numbers,
and those numbers nudge an ordering that was already computed and already
explained. Everything it produces can be printed in a sentence, which is the
test of whether it belongs in this product at all.

:mod:`lockedgroove.learn.loop_prefs` is the first (and so far only) tenant:
loop ranking. See ``docs/HANDOFF_ranking.md``.
"""

from .loop_prefs import (
    LOOP_CORRECTION_FIELDS,
    PERSONAL_SCORE_MAX,
    LoopPreference,
    apply_preference,
    learn_loop_preference,
    loop_preference_for,
    personalization_enabled,
    read_loop_corrections,
)

__all__ = [
    "LOOP_CORRECTION_FIELDS", "PERSONAL_SCORE_MAX", "LoopPreference", "apply_preference",
    "learn_loop_preference", "loop_preference_for", "personalization_enabled",
    "read_loop_corrections",
]
