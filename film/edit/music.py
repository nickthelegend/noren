"""
The music bed: one ~28 s seed from MusicGen (facebook/musicgen-small, run locally, no account), crossfade-looped to
the film's length with a fade in and out -> assets/music/bed.wav. Run once; the WAV is what the film uses.
  HF_HOME=<cache dir> python3 edit/music.py
"""
import sys
from pathlib import Path
import numpy as np, soundfile as sf, torch
from transformers import AutoProcessor, MusicgenForConditionalGeneration

OUT = Path(__file__).resolve().parent.parent / "assets" / "music" / "bed.wav"
PROMPT = ("warm minimal downtempo for a calm product film, soft plucked koto and felt piano over a gentle brushed beat, "
          "round warm sub bass, airy pads, confident and unhurried, major key, 96 bpm, clean mix, no vocals")
TOTAL = 182.0

torch.manual_seed(7)
dev = "mps" if torch.backends.mps.is_available() else "cpu"
proc = AutoProcessor.from_pretrained("facebook/musicgen-small")
model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small").to(dev)
inputs = proc(text=[PROMPT], padding=True, return_tensors="pt").to(dev)
audio = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=1400)  # ~28 s at 50 tokens/s
sr = model.config.audio_encoder.sampling_rate
seed = audio[0, 0].float().cpu().numpy()
seed = seed[int(0.5 * sr):]                       # skip the first half second (MusicGen's start transient)
xf = int(2.0 * sr)
out = seed.copy()
while len(out) < TOTAL * sr:
    a, b = out[:-xf], out[-xf:]
    ramp = np.linspace(0, 1, xf)
    out = np.concatenate([a, b * (1 - ramp) + seed[:xf] * ramp, seed[xf:]])
out = out[: int(TOTAL * sr)]
fi, fo = int(1.0 * sr), int(4.0 * sr)
out[:fi] *= np.linspace(0, 1, fi); out[-fo:] *= np.linspace(1, 0, fo)
out = out / (np.max(np.abs(out)) + 1e-9) * 0.89     # peak about -1 dBFS
OUT.parent.mkdir(parents=True, exist_ok=True)
sf.write(OUT, np.stack([out, out], axis=1), sr)
print("wrote", OUT, f"{len(out)/sr:.1f}s @ {sr} Hz")
