"""
Original soundtrack for video 5, "Inside SentryVo" (32 s product tour,
112 BPM). Light, clean groove; each of the five steps gets a rising chime,
and the on-screen actions (typing, sources lighting up, verdicts, the
notice being sent, the dashboard) get their own sounds.
Hits follow promo5.html's timeline. Usage: python3 make_music5.py out.wav
"""
import sys

from synth import Mix, note

m = Mix(32.0, seed=5)
BEAT = 60 / 112
BAR = BEAT * 4

STEPS = [3.8, 8.6, 13.4, 18.2, 23.2]
TYPE = [(4.8, 8), (5.7, 9), (6.5, 9)]          # (start, characters) typed in 0.6 s
CHIPS = [4.7, 5.6, 6.4]
OWN = [6.9, 7.1]
SHIELD = [7.3, 7.5]
SRC = [9.3, 9.5, 9.7, 9.9, 10.1, 10.3]
LIT = [9.9, 10.3, 10.7, 11.1, 11.5, 11.9]
ROWS = [14.1, 14.4, 14.7, 15.0, 15.3]
LEAK = [14.7, 15.2, 16.7]
SKIP = [15.7, 16.2]
SEND, SENT_STATE, REMOVED = 20.6, 20.9, 22.0
BARS = [24.1 + i * 0.1 for i in range(7)]
NOTIF, END = 26.0, 27.8

# ---------- harmony: C - Am - F - G, light keys ----------
PROG = [(-21, [-9, -5, -2]), (-24, [-12, -9, -5]), (-28, [-4, 0, 3]), (-26, [-2, 2, 5])]
bar, k = 0.0, 0
while bar < END:
    root, tones = PROG[k % 4]
    m.add(m.pad([note(x) for x in tones], BAR + 0.4, 0.3), bar, 0.36, pan=-0.2)
    if bar >= 3.6:
        for off in (0, 0.75, 1.5, 2.5, 3.25):
            m.add(m.pluck(note(tones[int(off * 4) % 3] + 12)), bar + off * BEAT, 0.08, pan=0.35)
        s = bar
        while s < bar + BAR - 1e-6 and s < END:
            m.add(m.bass(note(root - 12), BEAT * 0.45), s, 0.4)
            s += BEAT
    bar += BAR
    k += 1

# soft opening arpeggio under the hook question
for i in range(8):
    m.add(m.keys([note([3, 7, 10, 15][i % 4] + 12)], 0.6), 0.4 + i * BEAT / 2, 0.12, pan=-0.3 + 0.08 * i)
m.add(m.riser(0.9), 2.8, 0.35)

# drums from the first step, a lighter pattern on step 4 (the notice)
beat, i = 3.8, 0
while beat < END - 0.2:
    m.add(m.kick(), beat, 0.75 if i % 2 == 0 else 0.45)
    m.add(m.hat(), beat + BEAT / 2, 0.38, pan=0.3)
    if i % 2:
        m.add(m.snare(), beat, 0.3, pan=-0.1)
    beat += BEAT
    i += 1

# ---------- step changes ----------
for i, t in enumerate(STEPS):
    m.add(m.whoosh(0.6), t - 0.35, 0.32)
    m.add(m.bell(note([3, 7, 10, 12, 15][i] + 12)), t, 0.18, pan=0.2)

# ---------- on-screen actions ----------
for t in CHIPS:
    m.add(m.pluck(note(15)), t, 0.12)
for start, chars in TYPE:
    for c in range(chars):
        m.add(m.keytick(), start + c * 0.6 / chars, 0.08, pan=-0.2)
for t in OWN:
    m.add(m.tick(), t, 0.35)
for t in SHIELD:
    m.add(m.bell(note(22)), t, 0.1, pan=0.3)
for i, t in enumerate(SRC):
    m.add(m.pluck(note([0, 3, 7, 10, 12, 15][i] + 12)), t, 0.13, pan=-0.4 + 0.16 * i)
for i, t in enumerate(LIT):
    m.add(m.ping(note([12, 15, 19, 22, 24, 27][i] + 12)), t, 0.12, pan=0.4 - 0.16 * i)
for t in ROWS:
    m.add(m.tick(), t, 0.3, pan=0.2)
for t in LEAK:                                    # a real leak: bright chime
    m.add(m.bell(note(19)), t, 0.16, pan=0.25)
for t in SKIP:                                    # skipped / protected: soft low thud
    m.add(m.thud(), t, 0.4)
m.add(m.riser(0.6), SEND - 0.6, 0.3)
m.add(m.whoosh(0.9), SEND, 0.5)                   # notice sent
m.add(m.pluck(note(19), 0.5), SENT_STATE, 0.16)
for j, n in enumerate((7, 12, 16, 19)):           # removed
    m.add(m.pluck(note(n + 12), 0.5), REMOVED + j * 0.07, 0.18, pan=-0.3 + 0.2 * j)
for j, t in enumerate(BARS):                      # chart bars rising
    m.add(m.pluck(note([0, 3, 7, 10, 12, 15, 19][j] + 12)), t, 0.12)
m.add(m.bell(note(24)), NOTIF, 0.2)               # report arrives
m.add(m.bell(note(19)), NOTIF + 0.12, 0.16)

# ---------- end card ----------
m.add(m.riser(0.8), END - 0.8, 0.45)
m.add(m.impact(), END, 0.8)
for n in (-9, -5, -2, 3):
    m.add(m.pad([note(n)], 32.0 - END, 0.4), END, 0.24)
m.add(m.bell(note(15)), END + 0.6, 0.2, pan=0.2)
m.add(m.bell(note(22)), END + 1.2, 0.17, pan=-0.2)

m.write(sys.argv[1] if len(sys.argv) > 1 else 'sentryvo-demo5-music.wav')
