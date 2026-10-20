"""
Original soundtrack for SentryVo demo video 2, "The last 72 hours of a leak"
(26 s, 100 BPM). Tense drone and heartbeat under the leak alert, then a
steady beat that turns warmer as the leak is removed. Hits are timed to the
video: each hour step, the before/after wipe and the closing logo.

Synthesised from scratch with numpy, so it is SentryVo's own and free of any
third-party copyright. Usage: python3 make_music2.py out.wav
"""
import sys
import wave

import numpy as np

SR = 44100
DUR = 26.0
BEAT = 60 / 100           # 0.6 s
BAR = BEAT * 4            # 2.4 s
N = int(SR * DUR)
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(11)


def t_axis(sec):
    return np.arange(int(SR * sec)) / SR


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * (1 - max(0, pan))
    R[i:i + len(sig)] += sig * (1 + min(0, pan))


def lowpass(x, width):
    if width <= 1:
        return x
    return np.convolve(x, np.ones(width) / width, mode='same')


def note(n):
    return 440.0 * 2 ** (n / 12)


def kick(depth=1.0):
    t = t_axis(0.5)
    f = 42 + 90 * depth * np.exp(-t * 26)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5)


def hat():
    t = t_axis(0.07)
    n = rng.standard_normal(len(t))
    return (n - lowpass(n, 6)) * np.exp(-t * 60) * 0.3


def snare():
    t = t_axis(0.35)
    n = rng.standard_normal(len(t))
    return (n - lowpass(n, 3)) * np.exp(-t * 14) * 0.55 + np.sin(2 * np.pi * 200 * t) * np.exp(-t * 25) * 0.45


def bass(freq, length):
    t = t_axis(length)
    s = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * 2 * freq * t)
    return s * np.minimum(1, t * 150) * np.exp(-t * 2.5)


def pad(freqs, length, bright=0.3):
    t = t_axis(length)
    s = np.zeros(len(t))
    for f in freqs:
        for det in (-0.1, 0.1):
            ff = f * 2 ** (det / 12)
            s += np.sin(2 * np.pi * ff * t) + bright * np.sin(2 * np.pi * 2 * ff * t)
    env = np.minimum(1, t / 0.8) * np.minimum(1, (length - t) / 0.5)
    return lowpass(s, 10) * env / (len(freqs) * 2)


def drone(freq, length):
    t = t_axis(length)
    s = np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * freq * 1.5 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.7 * t))
    return lowpass(s, 20) * np.minimum(1, t / 1.0) * np.minimum(1, (length - t) / 0.6)


def bell(freq, length=1.4):
    t = t_axis(length)
    return (np.sin(2 * np.pi * freq * t) + 0.4 * np.sin(2 * np.pi * 2.76 * freq * t) * np.exp(-t * 6)) * np.exp(-t * 3)


def tick():
    t = t_axis(0.04)
    n = rng.standard_normal(len(t))
    return (n - lowpass(n, 4)) * np.exp(-t * 150) * 0.6


def whoosh(length):
    t = t_axis(length)
    n = rng.standard_normal(len(t))
    shape = np.sin(np.pi * t / length) ** 2
    return (n - lowpass(n, 4)) * shape * 0.35 + lowpass(n, 30) * shape * 0.5


def riser(length):
    t = t_axis(length)
    n = rng.standard_normal(len(t))
    sweep = np.sin(2 * np.pi * np.cumsum(250 + 1400 * (t / length) ** 2) / SR)
    return ((n - lowpass(n, 5)) * 0.3 + sweep * 0.25) * (t / length) ** 2.2


def impact():
    t = t_axis(1.8)
    n = rng.standard_normal(len(t))
    boom = np.sin(2 * np.pi * np.cumsum(36 + 70 * np.exp(-t * 16)) / SR) * np.exp(-t * 2.6)
    return boom * 1.1 + lowpass(n, 14) * np.exp(-t * 3.5) * 0.5


# ---------- 0-3.6 s: tension under the leak alert ----------
add(drone(note(-31), 3.9), 0.0, 0.55)                 # low D drone
add(drone(note(-19), 3.9), 0.0, 0.18, pan=0.3)
for at in (0.3, 0.75, 1.5, 1.95, 2.7, 3.15):          # heartbeat
    add(kick(0.6), at, 0.7 if at in (0.3, 1.5, 2.7) else 0.45)
add(bell(note(-7)), 0.3, 0.25, pan=-0.2)              # alert ping as the card drops
add(bell(note(-6)), 1.0, 0.2, pan=0.2)
add(riser(0.9), 2.75, 0.45)

# ---------- 3.6-22.4 s: the beat; harmony warms up over time ----------
# Dm - Bb - F - C, then (from the removal) Bb - F - C - Dm brighter
PROG_DARK = [(-19, [-7, -4, 0]), (-23, [-11, -7, -4]), (-16, [-4, 0, 3]), (-21, [-9, -5, -2])]
PROG_WARM = [(-23, [-11, -7, -4]), (-16, [-4, 0, 3]), (-21, [-9, -5, -2]), (-19, [-7, -4, 0])]
start = 3.6
bar = start
k = 0
while bar < 22.4:
    warm = bar >= 12.0
    root, tones = (PROG_WARM if warm else PROG_DARK)[k % 4]
    add(pad([note(x) for x in tones], BAR + 0.4, 0.45 if warm else 0.25), bar, 0.5, pan=-0.15)
    if warm:
        add(pad([note(x + 12) for x in tones], BAR + 0.4), bar, 0.22, pan=0.3)
    s = bar
    while s < bar + BAR and s < 22.0:
        add(bass(note(root - 12), BEAT / 2), s, 0.5 if int((s - bar) / (BEAT / 2)) % 2 == 0 else 0.3)
        s += BEAT / 2
    bar += BAR
    k += 1

beat = start
while beat < 22.0:
    i = round((beat - start) / BEAT)
    if not 16.8 <= beat < 17.6:                       # short drop before the before/after scene
        add(kick(), beat, 0.95)
        add(hat(), beat + BEAT / 2, 0.5, pan=0.25)
        if i % 2 == 1:
            add(snare(), beat, 0.4, pan=-0.1)
    beat += BEAT

# hour steps: tick + rising bell (0, 6, 9, 48, 72 h)
for at, n in ((4.6, 5), (7.1, 7), (9.6, 10), (12.1, 12), (14.6, 17)):
    add(tick(), at, 0.8)
    add(bell(note(n)), at, 0.28, pan=0.2)
add(bell(note(24)), 14.6, 0.15, pan=-0.2)            # sparkle on "gone from Google"

add(riser(0.8), 16.8, 0.5)                           # into before/after
add(whoosh(1.6), 19.4, 0.7)                          # the wipe
add(bell(note(12)), 21.0, 0.2)

# ---------- 22.4-26 s: logo and call to action ----------
add(riser(0.6), 21.8, 0.4)
add(impact(), 22.45, 0.9)
for i, n in enumerate((-4, 0, 3, 8)):                # Bb major-ish swell to finish
    add(pad([note(n)], 3.6, 0.4), 22.45, 0.22)
add(bell(note(15)), 23.3, 0.25, pan=0.2)
add(bell(note(19)), 23.7, 0.2, pan=-0.2)

# ---------- master ----------
fade = np.ones(N)
fo = int(1.6 * SR)
fade[-fo:] = np.linspace(1, 0, fo) ** 1.5
mix = np.tanh(np.stack([L, R]) * fade * 0.9)
mix /= np.max(np.abs(mix)) / 0.89

out = sys.argv[1] if len(sys.argv) > 1 else 'sentryvo-demo2-music.wav'
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print(f'wrote {out}: {DUR:.0f} s stereo {SR} Hz')
