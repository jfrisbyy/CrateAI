"""Analysis stages. Each module exposes ``run(y, sr, ctx) -> Section``.

``y`` is a mono float32 array at ``sr`` (the pipeline's analysis rate,
22050 Hz by default). Stages that need the native-rate or stereo signal read
``ctx.native`` (see ``lockedgroove.pipeline.Context``). Stem-aware stages read
``ctx.stems``. Every stage sets ``method`` and ``confidence`` and documents the
confidence derivation in its docstring (BUILD_PACKET section 4).
"""
