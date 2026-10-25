"""
Original soundtrack for video 4, "Your content. Only where you put it."
(30 s brand film, 96 BPM). Quiet piano under the opening statement, a
tense pulse while the copies spread, radar pings as each copy is found,
then the beat drops and turns major as the copies come down.
Hits follow promo4.html's timeline. Usage: python3 make_music4.py out.wav
"""
import sys

from synth import Mix, note

m = Mix(30.0, seed=4)
BEAT = 60 / 96
BAR = BEAT * 4

# cue times, matching the tile timings in promo4.html
POPS = [4.5 + k * 0.28 for k in range(12)]
FOUND = [9.2 + k * 0.26 for k in range(12)]
REMOVED = [14.8 + k * 0.32 for k in range(9)]

# ---------- 0-3.8 s: statement ----------
m.add(m.sub(note(-38), 4.2), 0.0, 0.55)
m.add(m.pad([note(x) for x in (-14, -10, -7)], 4.2, 0.15, attack=1.2), 0.0, 0.35)
m.add(m.riser(1.2), 0.1, 0.2)                                # logo drawing
m.add(m.piano(note(-2)), 1.1, 0.45)                           # "You made it."
m.add(m.piano(note(-7), 1.2), 1.1, 0.25)
m.add(m.piano(note(3)), 1.9, 0.45)                            # "You own it."
m.add(m.piano(note(-2), 1.2), 1.9, 0.25)
m.add(m.riser(0.9), 2.9, 0.35)

# ---------- 3.8-12.8 s: tension (D minor) ----------
DARK = [(-31, [-7, -4, 0]), (-35, [-11, -7, -4]), (-28, [-4, 0, 3]), (-33, [-9, -5, -2])]
bar, k = 3.8, 0
while bar < 12.9:
    root, tones = DARK[k % 4]
    m.add(m.pad([note(x) for x in tones], BAR + 0.4, 0.2), bar, 0.42, pan=-0.15)
    s = bar
    while s < bar + BAR - 1e-6 and s < 12.9:
        m.add(m.bass(note(root), BEAT / 2 * 0.9), s, 0.42 if int((s - bar) / (BEAT / 2)) % 2 == 0 else 0.26)
        s += BEAT / 2
    bar += BAR
    k += 1
for i, t in enumerate(POPS):                                   # each copy appearing
    m.add(m.tick(), t, 0.5, pan=-0.4 + 0.07 * i)
    m.add(m.pluck(note(-2 + (i % 4) * 3)), t, 0.14, pan=0.3)
m.add(m.riser(1.0), 7.6, 0.4)
m.add(m.whoosh(0.8), 8.3, 0.4)
pent = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27]
for i, t in enumerate(FOUND):                                  # radar pings, rising
    m.add(m.ping(note(pent[i] + 12)), t, 0.16, pan=0.35 if i % 2 else -0.35)
beat = 8.7
while beat < 12.8:                                             # half-time kick under the search
    m.add(m.kick(0.7), beat, 0.55)
    beat += BEAT * 2
m.add(m.riser(0.9), 12.0, 0.45)

# ---------- 13-25 s: the drop, major ----------
BRIGHT = [(-35, [-11, -7, -4]), (-28, [-4, 0, 3]), (-33, [-9, -5, -2]), (-31, [-7, -4, 0])]
bar, k = 13.0, 0
while bar < 25.0:
    root, tones = BRIGHT[k % 4]
    m.add(m.pad([note(x) for x in tones], BAR + 0.4, 0.4), bar, 0.42, pan=-0.2)
    for off in (0, 1.5, 2.5):
        m.add(m.keys([note(x + 12) for x in tones], BEAT * 0.9), bar + off * BEAT, 0.14, pan=0.25)
    s = bar
    while s < bar + BAR - 1e-6 and s < 24.9:
        m.add(m.bass(note(root), BEAT * 0.45), s, 0.45)
        m.add(m.bass(note(root), BEAT * 0.3), s + BEAT * 0.75, 0.22)
        s += BEAT
    bar += BAR
    k += 1
beat, i = 13.0, 0
while beat < 24.6:
    m.add(m.kick(), beat, 0.85)
    m.add(m.hat(), beat + BEAT / 2, 0.42, pan=0.3)
    if i % 2:
        m.add(m.snare(), beat, 0.38, pan=-0.1)
    if i % 8 == 7:
        m.add(m.hat(True), beat + BEAT / 2, 0.3, pan=0.3)
    beat += BEAT
    i += 1
m.add(m.impact(), 13.0, 0.45)
m.add(m.whoosh(0.6), 13.1, 0.35)                               # notices going out
for i, t in enumerate(REMOVED):                                # each copy removed
    m.add(m.bell(note(15 + [0, 4, 7, 12][i % 4])), t, 0.16, pan=-0.3 + 0.08 * i)
for t in (19.2, 20.4, 21.6, 22.8):                             # feature cards
    m.add(m.whoosh(0.55), t - 0.1, 0.3)
    m.add(m.pluck(note(19)), t + 0.2, 0.12)

# ---------- 25-30 s: end card ----------
m.add(m.riser(0.8), 24.3, 0.45)
m.add(m.impact(), 25.1, 0.85)
for n in (-4, 0, 3, 8):
    m.add(m.pad([note(n)], 4.9, 0.4), 25.1, 0.25)
m.add(m.sub(note(-28), 4.9), 25.1, 0.4)
m.add(m.bell(note(15)), 25.6, 0.22, pan=0.2)
m.add(m.bell(note(20)), 26.4, 0.2, pan=-0.2)
m.add(m.bell(note(24)), 26.9, 0.16)

m.write(sys.argv[1] if len(sys.argv) > 1 else 'sentryvo-demo4-music.wav')
