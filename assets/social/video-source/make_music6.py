"""
Original soundtrack for video 6, "Meet SentryVo" (36 s, illustrated
presenter). Calm, warm office groove at 100 BPM that stays under the
captions, with soft sounds on the wall screen's changes and actions.
Hits follow promo6.html's timeline. With the voiceover's timing file
(voice6.json from make_voice6.py) the hits move with the stretched timeline.
Usage: python3 make_music6.py out.wav [voice6.json]
"""
import json
import sys

from synth import Mix, note

ANCHORS = json.load(open(sys.argv[2]))['anchors'] if len(sys.argv) > 2 else [[0, 0], [36.0, 36.0]]


def R(design):
    """Design time in promo6.html -> real time in the video."""
    for (r0, d0), (r1, d1) in zip(ANCHORS, ANCHORS[1:]):
        if design <= d1:
            return r0 + (design - d0) * (r1 - r0) / max(1e-6, d1 - d0)
    return ANCHORS[-1][0] + design - ANCHORS[-1][1]


TOTAL = R(36.0)
m = Mix(TOTAL, seed=6)
BEAT = 60 / 100
BAR = BEAT * 4

SCENES = [R(x) for x in (4.3, 9.1, 14.7, 20.3, 25.7)]
TILES = [R(4.8 + i * 0.32) for i in range(8)]
FOUND = [R(6.9 + i * 0.2) for i in range(8)]
SOURCES_DONE = [R(x) for x in (10.3, 10.8, 11.3, 11.8, 12.3, 12.8)]
SEND, SENT, REMOVED = R(16.6), R(16.8), R(18.8)
BARS = [R(21.2 + i * 0.1) for i in range(7)]
REPORT, CTA, END = R(23.4), R(26.6), R(31.0)

# ---------- harmony: Fmaj7 - Dm7 - Bbmaj7 - C, soft keys ----------
PROG = [(-28, [-4, 0, 3, 7]), (-31, [-7, -4, 0, 3]), (-35, [-11, -7, -4, 0]), (-33, [-9, -5, -2, 2])]
bar, k = 0.0, 0
while bar < END:
    root, tones = PROG[k % 4]
    m.add(m.pad([note(x) for x in tones], BAR + 0.4, 0.25), bar, 0.3, pan=-0.2)
    for off in (0, 1.5, 2.5, 3.0):
        m.add(m.keys([note(x + 12) for x in tones[:3]], BEAT * 0.9), bar + off * BEAT, 0.11, pan=0.25)
    if bar >= BAR:
        s = bar
        while s < bar + BAR - 1e-6 and s < END:
            m.add(m.bass(note(root - 12), BEAT * 0.6), s, 0.34)
            s += BEAT * 2
    bar += BAR
    k += 1

# soft piano melody in the gaps between scenes
MELODY = [(0.6, 7), (1.2, 12), (1.8, 10), (2.7, 7), (9.6, 12), (10.2, 14), (20.8, 15), (21.4, 12), (26.2, 19), (26.8, 17), (27.4, 15)]
for t, n in MELODY:
    m.add(m.piano(note(n + 12), 1.4), R(t), 0.12, pan=0.15)

# light beat from bar 2 (kick on 1 and 3, soft hats)
beat, i = BAR, 0
while beat < END - 0.3:
    if i % 2 == 0:
        m.add(m.kick(0.8), beat, 0.5)
    m.add(m.hat(), beat + BEAT / 2, 0.22, pan=0.3)
    if i % 4 == 2:
        m.add(m.snare(), beat, 0.16, pan=-0.1)
    beat += BEAT
    i += 1

# ---------- screen sounds ----------
for t in SCENES:
    m.add(m.whoosh(0.5), t - 0.25, 0.22)
    m.add(m.bell(note(19)), t + 0.05, 0.1, pan=0.4)
for t in TILES:
    m.add(m.tick(), t, 0.22, pan=0.4)
for i, t in enumerate(FOUND):
    m.add(m.ping(note([12, 15, 17, 19, 22, 24, 27, 29][i] + 12)), t, 0.07, pan=0.4)
for i, t in enumerate(SOURCES_DONE):
    m.add(m.pluck(note([0, 3, 5, 7, 10, 12][i] + 15)), t, 0.09, pan=0.4)
m.add(m.whoosh(0.8), SEND, 0.3)
m.add(m.pluck(note(19), 0.5), SENT, 0.1, pan=0.4)
for j, n in enumerate((7, 12, 16, 19)):
    m.add(m.pluck(note(n + 15), 0.5), REMOVED + j * 0.07, 0.1, pan=0.4)
for j, t in enumerate(BARS):
    m.add(m.pluck(note([0, 3, 7, 10, 12, 15, 19][j] + 12)), t, 0.07, pan=0.4)
m.add(m.bell(note(24)), REPORT, 0.12, pan=0.4)
m.add(m.bell(note(22)), CTA, 0.12, pan=0.4)

# ---------- end card ----------
m.add(m.riser(0.8), END - 0.8, 0.3)
m.add(m.impact(), END + 0.2, 0.6)
for n in (-4, 0, 3, 7):
    m.add(m.pad([note(n)], TOTAL - END, 0.4), END + 0.2, 0.22)
m.add(m.bell(note(15)), END + 0.8, 0.16, pan=0.2)
m.add(m.bell(note(22)), END + 1.5, 0.13, pan=-0.2)

m.write(sys.argv[1] if len(sys.argv) > 1 else 'sentryvo-demo6-music.wav')
