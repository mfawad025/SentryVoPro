"""
Voiceover for video 6, "Meet SentryVo", made with the open-source Kokoro
TTS model (Apache-2.0, free for commercial use) and its "am_michael" voice.

Writes:
  <outdir>/voice6.wav     the voice track (44.1 kHz stereo)
  promo6-voice.js         (next to this script) timing for promo6.html:
                          where each spoken line starts and ends, how the
                          page's own timeline is stretched to fit the voice,
                          and the loudness per frame that moves his mouth.

Needs: pip install kokoro-onnx soundfile numpy, plus the model files
kokoro-v1.0.int8.onnx and voices-v1.0.bin from
https://github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0).
Usage: python make_voice6.py <model-dir> <outdir>
"""
import json
import os
import sys
import wave

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_DIR, OUT = sys.argv[1], sys.argv[2]
VOICE, SPEED, FPS, SR = 'am_michael', 1.0, 30, 44100

# Spoken text (spelled for the voice) and the caption window each line has
# in promo6.html's own timeline (design seconds).
LINES = [
    ("Hello! Let me show you how Sentry Vo protects your content.", 0.6, 3.9),
    ("When content leaks, copies spread to forums, Telegram, and tube sites, within hours.", 4.4, 8.7),
    ("Sentry Vo searches for your stage names, as often as every six hours.", 9.2, 14.3),
    ("Every match is checked. Then a D M C A takedown notice goes to the host.", 14.8, 19.9),
    ("You follow everything on your dashboard, with regular reports by email.", 20.4, 25.3),
    ("Start with a free scan, at Sentry Vo dot com. It takes a minute.", 25.8, 30.6),
]
DESIGN_END = 36.0      # promo6.html's length before stretching
MIN_GAP = 0.55         # pause between spoken lines (s)

kokoro = Kokoro(os.path.join(MODEL_DIR, 'kokoro-v1.0.int8.onnx'), os.path.join(MODEL_DIR, 'voices-v1.0.bin'))
clips = []
for text, _, _ in LINES:
    samples, sr = kokoro.create(text, voice=VOICE, speed=SPEED, lang='en-us')
    # trim silence at both ends, then resample to 44.1 kHz
    level = np.abs(samples)
    idx = np.where(level > 0.01)[0]
    samples = samples[max(0, idx[0] - int(0.02 * sr)): idx[-1] + int(0.06 * sr)]
    n = int(len(samples) * SR / sr)
    clips.append(np.interp(np.linspace(0, len(samples) - 1, n), np.arange(len(samples)), samples))

# Place the lines: each starts at its design time, or later if the previous
# line is still speaking. Anchors map real time -> design time.
anchors = [[0.0, 0.0]]
starts, t_free = [], 0.0
for (text, a, b), clip in zip(LINES, clips):
    dur = len(clip) / SR
    real_a = max(a + (anchors[-1][0] - anchors[-1][1]), t_free)
    starts.append(real_a)
    anchors += [[round(real_a, 3), a], [round(real_a + dur, 3), b]]
    t_free = real_a + dur + MIN_GAP
total = anchors[-1][0] + (DESIGN_END - anchors[-1][1])
anchors.append([round(total, 3), DESIGN_END])

track = np.zeros(int(total * SR) + SR)
for start, clip in zip(starts, clips):
    i = int(start * SR)
    track[i:i + len(clip)] += clip
track = track[: int(total * SR)]
track /= max(1e-9, np.max(np.abs(track))) / 0.9

os.makedirs(OUT, exist_ok=True)
with wave.open(os.path.join(OUT, 'voice6.wav'), 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    pcm = (np.stack([track, track]).T * 32767).astype('<i2')
    w.writeframes(pcm.tobytes())

# Mouth opening per video frame: loudness of the voice, smoothed a little.
hop = SR // FPS
frames = int(total * FPS)
env = np.array([np.sqrt(np.mean(track[f * hop:(f + 1) * hop] ** 2)) if f * hop < len(track) else 0 for f in range(frames)])
env = np.convolve(env, [0.25, 0.5, 0.25], mode='same')
env = np.clip(env / (np.percentile(env[env > 0.01], 90) if np.any(env > 0.01) else 1), 0, 1)

data = {
    'duration': round(total, 3),
    'anchors': anchors,
    'lines': [[round(s, 3), round(s + len(c) / SR, 3)] for s, c in zip(starts, clips)],
    'mouth': [round(float(x), 3) for x in env],
}
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, 'promo6-voice.js'), 'w') as f:
    f.write('// Written by make_voice6.py: voiceover timing for promo6.html.\n')
    f.write('window.VOICE = ' + json.dumps(data) + ';\n')
with open(os.path.join(OUT, 'voice6.json'), 'w') as f:
    json.dump({k: data[k] for k in ('duration', 'anchors', 'lines')}, f)
print(f"voice: {total:.2f} s, lines at {', '.join(f'{s:.2f}' for s in starts)}")
