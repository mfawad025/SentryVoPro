"""
Original soundtrack for the SentryVo demo video (31 s, 120 BPM, A minor).

Everything here is synthesised from scratch with numpy (no samples, no
loops from anywhere else), so the track is SentryVo's own and free of any
third-party copyright. Hits are timed to the video: soft ticks on the
redacted headline, radar pings on each leak found, typing clicks on the
search, a heavy hit on every "REMOVED" stamp, chimes on the feature list
and a final impact on the logo.

Usage: python3 make_music.py out.wav
"""
import sys
import wave

import numpy as np

SR = 44100
DUR = 31.0
BPM = 120
BEAT = 60 / BPM            # 0.5 s
BAR = BEAT * 4             # 2 s
N = int(SR * DUR)
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(7)


def t_axis(sec):
    return np.arange(int(SR * sec)) / SR


def add(sig, at, gain=1.0, pan=0.0):
    """Mix a mono signal in at time `at` (s); pan -1 left .. +1 right."""
    i = int(at * SR)
    if i >= N:
        return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * (1 - max(0, pan))
    R[i:i + len(sig)] += sig * (1 + min(0, pan))


def lowpass(x, width):
    """Cheap low-pass: moving average over `width` samples."""
    if width <= 1:
        return x
    k = np.ones(width) / width
    return np.convolve(x, k, mode='same')


def note(n):
    """Semitones from A4 -> Hz."""
    return 440.0 * 2 ** (n / 12)


# ---------- instruments ----------
def kick():
    t = t_axis(0.45)
    f = 45 + 95 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t * 7)


def hat(open_=False):
    t = t_axis(0.25 if open_ else 0.06)
    n = rng.standard_normal(len(t))
    n = n - lowpass(n, 6)                     # keep the bright part
    return n * np.exp(-t * (14 if open_ else 70)) * 0.35


def clap():
    t = t_axis(0.3)
    n = rng.standard_normal(len(t))
    n = n - lowpass(n, 3)
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)
    return (n * np.exp(-t * 18) * 0.6 + body * 0.5)


def bass(freq, length):
    t = t_axis(length)
    s = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * 2 * freq * t) + 0.12 * np.sin(2 * np.pi * 3 * freq * t)
    env = np.minimum(1, t * 200) * np.exp(-t * 3.5)
    return s * env


def pad(freqs, length):
    t = t_axis(length)
    s = np.zeros(len(t))
    for f in freqs:
        for det in (-0.12, 0.12):
            ff = f * 2 ** (det / 12)
            s += np.sin(2 * np.pi * ff * t) + 0.3 * np.sin(2 * np.pi * 2 * ff * t)
    env = np.minimum(1, t / 0.6) * np.minimum(1, (length - t) / 0.4)
    return lowpass(s, 8) * env / (len(freqs) * 2)


def pluck(freq, length=0.35):
    t = t_axis(length)
    return (np.sin(2 * np.pi * freq * t) + 0.25 * np.sin(2 * np.pi * 3 * freq * t)) * np.exp(-t * 11)


def ping(freq=1760):
    t = t_axis(0.9)
    return np.sin(2 * np.pi * freq * t * (1 + 0.002 * np.sin(2 * np.pi * 6 * t))) * np.exp(-t * 5)


def click():
    t = t_axis(0.025)
    n = rng.standard_normal(len(t))
    return (n - lowpass(n, 4)) * np.exp(-t * 220) * 0.5


def riser(length):
    t = t_axis(length)
    n = rng.standard_normal(len(t))
    n = n - lowpass(n, 5)
    sweep = np.sin(2 * np.pi * np.cumsum(300 + 1500 * (t / length) ** 2) / SR)
    env = (t / length) ** 2.2
    return (n * 0.35 + sweep * 0.25) * env


def impact():
    t = t_axis(1.6)
    n = rng.standard_normal(len(t))
    boom = np.sin(2 * np.pi * np.cumsum(38 + 80 * np.exp(-t * 18)) / SR) * np.exp(-t * 3)
    return boom * 1.1 + lowpass(n, 12) * np.exp(-t * 4) * 0.6


def stamp():
    return kick() * 1.1 + np.pad(clap(), (0, len(kick()) - len(clap())))[: len(kick())] * 0.8


def chime(freq):
    t = t_axis(1.2)
    return (np.sin(2 * np.pi * freq * t) + 0.5 * np.sin(2 * np.pi * 2.01 * freq * t)) * np.exp(-t * 4)


# ---------- harmony: Am - F - C - G, one chord per bar ----------
CHORDS = [
    (-12, [0, 3, 7]),    # A minor (root A3)
    (-16, [-4, 0, 3]),   # F major
    (-9, [-9, -5, -2]),  # C major
    (-14, [-2, 2, 5]),   # G major
]


def chord_at(sec):
    return CHORDS[int(sec // BAR) % 4]


# Pads all the way through, swelling in
bar = 0.0
while bar < DUR:
    root, tones = chord_at(bar)
    gain = 0.55 if bar < 4 else 0.42
    add(pad([note(x) for x in tones], BAR + 0.3), bar, gain, pan=-0.2)
    add(pad([note(x + 12) for x in tones], BAR + 0.3), bar + 0.01, gain * 0.35, pan=0.3)
    bar += BAR

# Bass: eighth notes from 4 s, half notes in the intro, stops for the outro tail
t = 0.0
while t < 29.5:
    root, _ = chord_at(t)
    f = note(root - 12)
    if t < 4:
        add(bass(f, 1.0), t, 0.45)
        t += 1.0
    else:
        add(bass(f, BEAT / 2), t, 0.5 if (t / (BEAT / 2)) % 2 == 0 else 0.32)
        t += BEAT / 2

# Drums from 4 s; drop out for one beat before each scene change
drop_beats = {8.5, 20.5, 25.5}
beat = 4.0
while beat < 30.0:
    if round(beat, 2) not in drop_beats:
        add(kick(), beat, 0.95)
        add(hat(), beat + BEAT / 2, 0.55, pan=0.25)
        if int(beat / BEAT) % 2 == 1:
            add(clap(), beat, 0.42, pan=-0.1)
        if int(beat / BEAT) % 8 == 7:
            add(hat(open_=True), beat + BEAT / 2, 0.35, pan=0.25)
    beat += BEAT

# Arpeggio (radar feel) in the scanning and feature scenes
for start, end, gain in ((4.0, 8.5, 0.22), (21.0, 25.5, 0.18)):
    s = start
    i = 0
    while s < end:
        root, tones = chord_at(s)
        f = note(tones[i % 3] + 12)
        add(pluck(f), s, gain, pan=0.45 if i % 2 else -0.45)
        s += BEAT / 2
        i += 1

# ---------- hits synced to the video ----------
for at in (0.4, 0.6, 1.0, 1.2):                 # redaction bars wiping off
    add(click(), at, 0.9)
    add(pluck(note(12)), at, 0.12)
add(impact(), 0.25, 0.35)                       # soft opening boom

for at in (3.3, 8.2, 20.2, 25.4):               # risers into each scene change
    add(riser(0.75), at, 0.5)

for at, f in ((5.5, 1760), (6.1, 1975), (6.7, 2093), (7.3, 2349), (7.9, 2637)):  # radar finds
    add(ping(f), at, 0.25, pan=0.3)

for k in range(22):                             # search query typing
    add(click(), 9.6 + k * (1.2 / 22), 0.45, pan=-0.3)
for at in (10.9, 11.2, 11.5, 11.8, 12.1):       # results sliding in
    add(pluck(note(19)), at, 0.12, pan=0.2)

for at in (15.7, 17.2, 18.7, 20.2):             # "REMOVED" stamps
    add(stamp(), at, 0.9)
    add(chime(note(15)), at, 0.18)

for at, n in ((21.4, 12), (22.1, 15), (22.8, 19), (23.5, 24)):  # feature list chimes
    add(chime(note(n)), at, 0.22, pan=0.2)

add(impact(), 26.05, 0.9)                       # logo pop
add(chime(note(12)), 26.1, 0.3)
add(chime(note(19)), 27.1, 0.22)                # "Run your free scan"

# ---------- master: fade out, soft-clip, normalise ----------
fade = np.ones(N)
fo = int(1.8 * SR)
fade[-fo:] = np.linspace(1, 0, fo) ** 1.5
mix = np.stack([L, R]) * fade
mix = np.tanh(mix * 0.9)
mix /= np.max(np.abs(mix)) / 0.89             # about -1 dBFS peak

out = sys.argv[1] if len(sys.argv) > 1 else 'sentryvo-demo-music.wav'
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print(f'wrote {out}: {DUR:.0f} s stereo {SR} Hz')
