"""
Original soundtrack for SentryVo demo video 3, "How to get protected" (the
purchase walkthrough). Light, upbeat groove at 110 BPM in F major; sound
effects follow the recording's own events.json (written by
record-purchase.js), so every click, typed key, page change, step caption and
the payment get their own sound.

Synthesised from scratch with numpy, so it is SentryVo's own and free of any
third-party copyright. Usage: python3 make_music3.py events.json out.wav
"""
import json
import sys
import wave

import numpy as np

SR = 44100
EV = json.load(open(sys.argv[1]))
DUR = EV['duration']
EVENTS = EV['events']
BEAT = 60 / 110
BAR = BEAT * 4
N = int(SR * DUR)
L = np.zeros(N)
R = np.zeros(N)
rng = np.random.default_rng(23)


def t_axis(sec):
    return np.arange(int(SR * sec)) / SR


def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N or i < 0:
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


def kick():
    t = t_axis(0.4)
    return np.sin(2 * np.pi * np.cumsum(48 + 80 * np.exp(-t * 30)) / SR) * np.exp(-t * 8)


def hat():
    t = t_axis(0.05)
    n = rng.standard_normal(len(t))
    return (n - lowpass(n, 5)) * np.exp(-t * 80) * 0.3


def snap():
    t = t_axis(0.22)
    n = rng.standard_normal(len(t))
    return (n - lowpass(n, 3)) * np.exp(-t * 22) * 0.5 + np.sin(2 * np.pi * 230 * t) * np.exp(-t * 35) * 0.3


def bass(freq, length):
    t = t_axis(length)
    s = np.sin(2 * np.pi * freq * t) + 0.25 * np.sin(2 * np.pi * 2 * freq * t)
    return s * np.minimum(1, t * 180) * np.exp(-t * 3)


def keys(freqs, length):
    """Soft electric-piano chord."""
    t = t_axis(length)
    s = np.zeros(len(t))
    for f in freqs:
        s += (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 3)) * np.exp(-t * 1.4)
    env = np.minimum(1, t * 60) * np.minimum(1, (length - t) / 0.08)
    return s * env / len(freqs)


def pad(freqs, length):
    t = t_axis(length)
    s = np.zeros(len(t))
    for f in freqs:
        for det in (-0.1, 0.1):
            s += np.sin(2 * np.pi * f * 2 ** (det / 12) * t)
    env = np.minimum(1, t / 0.7) * np.minimum(1, (length - t) / 0.5)
    return lowpass(s, 12) * env / (len(freqs) * 2)


def pluck(freq, length=0.3):
    t = t_axis(length)
    return (np.sin(2 * np.pi * freq * t) + 0.2 * np.sin(2 * np.pi * 3 * freq * t)) * np.exp(-t * 14)


def bell(freq, length=1.3):
    t = t_axis(length)
    return (np.sin(2 * np.pi * freq * t) + 0.4 * np.sin(2 * np.pi * 2.76 * freq * t) * np.exp(-t * 6)) * np.exp(-t * 3.2)


def click():
    t = t_axis(0.03)
    n = rng.standard_normal(len(t))
    return (n - lowpass(n, 4)) * np.exp(-t * 200) * 0.5 + np.sin(2 * np.pi * 1800 * t) * np.exp(-t * 120) * 0.3


def keytick():
    t = t_axis(0.02)
    n = rng.standard_normal(len(t))
    return (n - lowpass(n, 3)) * np.exp(-t * 300)


def whoosh(length=0.6):
    t = t_axis(length)
    n = rng.standard_normal(len(t))
    shape = np.sin(np.pi * t / length) ** 2
    return ((n - lowpass(n, 4)) * 0.3 + lowpass(n, 25) * 0.5) * shape


def riser(length):
    t = t_axis(length)
    n = rng.standard_normal(len(t))
    sweep = np.sin(2 * np.pi * np.cumsum(300 + 1300 * (t / length) ** 2) / SR)
    return ((n - lowpass(n, 5)) * 0.3 + sweep * 0.22) * (t / length) ** 2.2


def impact():
    t = t_axis(1.6)
    n = rng.standard_normal(len(t))
    boom = np.sin(2 * np.pi * np.cumsum(40 + 75 * np.exp(-t * 16)) / SR) * np.exp(-t * 2.8)
    return boom + lowpass(n, 14) * np.exp(-t * 4) * 0.45


def ev(kind):
    return [e for e in EVENTS if e['type'] == kind]


later = ev('later')[0]['t']           # "A few days later" card
outro = ev('outro')[0]['t']

# ---------- harmony: F - Dm - Bb - C (Bb - C - F - F on the outro) ----------
PROG = [(-16, [-4, 0, 3]), (-19, [-7, -4, 0]), (-23, [-11, -7, -2]), (-21, [-9, -5, -2])]
bar, k = 0.0, 0
while bar < DUR:
    root, tones = PROG[k % 4]
    quiet = later - 0.2 <= bar < later + 2.4      # thin out under the time-skip card
    add(pad([note(x) for x in tones], BAR + 0.4), bar, 0.32 if not quiet else 0.45, pan=-0.2)
    if bar >= 2.0 and not quiet:
        for off in (0, 1.5, 2.5):                  # syncopated keys
            add(keys([note(x + 12) for x in tones], BEAT * 0.9), bar + off * BEAT, 0.16, pan=0.25)
    if bar >= 2.0:
        s = bar
        while s < bar + BAR - 1e-6:
            if not quiet:
                add(bass(note(root - 12), BEAT * 0.45), s, 0.42)
                add(bass(note(root - 12), BEAT * 0.3), s + BEAT * 0.75, 0.22)
            s += BEAT
    bar += BAR
    k += 1

# ---------- drums from 2 s ----------
beat, i = 2 * BEAT * 2, 0
while beat < outro:
    quiet = later - 0.2 <= beat < later + 2.4
    if not quiet:
        add(kick(), beat, 0.8 if i % 2 == 0 else 0.5)
        add(hat(), beat + BEAT / 2, 0.45, pan=0.3)
        if i % 2 == 1:
            add(snap(), beat, 0.35, pan=-0.1)
    beat += BEAT
    i += 1

# ---------- sound effects from the recording ----------
for e in ev('click'):
    add(click(), e['t'], 0.55, pan=0.15)
for e in ev('key'):
    add(keytick(), e['t'], 0.09 + 0.04 * rng.random(), pan=-0.2 + 0.4 * rng.random())
for e in ev('page'):
    add(whoosh(0.6), e['t'] - 0.3, 0.45)
step_notes = [0, 3, 5, 7, 10, 12, 15]                # one rising chime per step
for e in ev('step'):
    add(bell(note(step_notes[(e['step'] - 1) % 7] + 3)), e['t'], 0.2, pan=0.2)
for e in ev('paid'):                                  # payment complete
    for j, n in enumerate((3, 7, 10, 15)):
        add(pluck(note(n + 12), 0.5), e['t'] + j * 0.07, 0.22, pan=-0.3 + j * 0.2)
    add(bell(note(15)), e['t'] + 0.3, 0.22)
add(riser(0.9), later - 0.9, 0.4)
add(bell(note(-2), 2.2), later, 0.25)
add(riser(0.7), later + 2.0, 0.35)
add(impact(), outro, 0.55)
for n in (-4, 0, 3, 8):                               # final chord
    add(pad([note(n)], DUR - outro), outro, 0.28)
add(bell(note(15)), outro + 0.6, 0.22, pan=0.2)
add(bell(note(20)), outro + 1.0, 0.18, pan=-0.2)

# ---------- master ----------
fade = np.ones(N)
fi, fo = int(0.4 * SR), int(1.8 * SR)
fade[:fi] = np.linspace(0, 1, fi)
fade[-fo:] = np.linspace(1, 0, fo) ** 1.5
mix = np.tanh(np.stack([L, R]) * fade * 0.9)
mix /= np.max(np.abs(mix)) / 0.89

out = sys.argv[2] if len(sys.argv) > 2 else 'sentryvo-demo3-music.wav'
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print(f'wrote {out}: {DUR:.1f} s stereo {SR} Hz')
