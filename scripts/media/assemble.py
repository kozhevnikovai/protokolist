#!/usr/bin/env python3
"""Склеивает «встречу» из фраз трёх дикторов Russian LibriSpeech (тестовая часть, аудиокниги LibriVox —
общественное достояние). Реальная речь разных людей, но не настоящая встреча: так и пишем в подписях."""
import io, sys, numpy as np, soundfile as sf
from datasets import load_dataset, Audio
out, offsets, n = sys.argv[1], [int(x) for x in sys.argv[2].split(",")], int(sys.argv[3])
ds = load_dataset("bond005/rulibrispeech", split="test", streaming=True).cast_column("audio", Audio(decode=False))
need = max(offsets) + n; rows = []
for i, r in enumerate(ds):
    if i >= need: break
    rows.append(r)
sr, parts = 16000, []
for k in range(n):
    for o in offsets:
        a, s = sf.read(io.BytesIO(rows[o + k]["audio"]["bytes"]), dtype="float32")
        if a.ndim > 1: a = a.mean(1)
        if s != sr: a = np.interp(np.arange(0, len(a) * sr // s) * s / sr, np.arange(len(a)), a).astype("float32")
        parts += [a, np.zeros(int(0.5 * sr), "float32")]
sf.write(out, np.concatenate(parts), sr)
print(out, round(sum(len(p) for p in parts) / sr), "с")
