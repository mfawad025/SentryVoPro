# SentryVo demo videos (with original music)

| File | Size | For |
|---|---|---|
| `../sentryvo-demo-vertical-1080x1920.mp4` | 9:16 | Reels, TikTok, Shorts, stories, X/LinkedIn mobile |
| `../sentryvo-demo-landscape-1920x1080.mp4` | 16:9 | YouTube, LinkedIn, X, website |
| `../sentryvo-demo-music.m4a` | audio only | the soundtrack on its own |
| `../sentryvo-demo2-vertical-1080x1920.mp4` | 9:16, 26 s | Video 2, "The last 72 hours of a leak" |
| `../sentryvo-demo2-landscape-1920x1080.mp4` | 16:9, 26 s | Video 2, landscape |
| `../sentryvo-demo2-music.m4a` | audio only | Video 2 soundtrack |
| `../sentryvo-demo3-vertical-1080x1920.mp4` | 9:16, 57 s | Video 3, "How to get protected" (buying a plan) |
| `../sentryvo-demo3-landscape-1920x1080.mp4` | 16:9, 55 s | Video 3, landscape |
| `../sentryvo-demo3-music-vertical.m4a`, `-landscape.m4a` | audio only | Video 3 soundtracks (one per version, the timings differ) |
| `../sentryvo-demo4-vertical-1080x1920.mp4`, `-landscape-1920x1080.mp4` | 30 s | Video 4, brand film "Your content. Only where you put it." |
| `../sentryvo-demo5-vertical-1080x1920.mp4`, `-landscape-1920x1080.mp4` | 32 s | Video 5, product tour "Inside SentryVo" |
| `../sentryvo-demo4-music.m4a`, `../sentryvo-demo5-music.m4a` | audio only | Video 4 and 5 soundtracks |
| `../sentryvo-demo6-vertical-1080x1920.mp4`, `-landscape-1920x1080.mp4` | 36 s | Video 6, illustrated presenter in a three-piece suit explaining SentryVo (captions, no voice) |

Video 1 (31 s, "Leaked today. Gone tomorrow."): `promo.html`, `promo-landscape.html`, `make_music.py`.
Video 2 (26 s, the 72-hour case): `promo2.html` (open with `#land` for landscape), `make_music2.py`.
Record video 2 with `node record.js "$PWD/promo2.html" frames frames 30 1080x1920` and
`node record.js "$PWD/promo2.html#land" lframes frames 30 1920x1080`.

Videos 4 and 5: `promo4.html` and `promo5.html` (open with `#land` for
landscape, like video 2), music `make_music4.py` / `make_music5.py`, which
share the instruments in `synth.py`. Record with
`node record.js "$PWD/promo4.html" frames frames 30 1080x1920` and
`node record.js "$PWD/promo4.html#land" lframes frames 30 1920x1080`.
All names, links and numbers in them are made-up examples.

Video 6: `promo6.html` (same `#land` switch) and `make_music6.py`. The
presenter is an SVG drawn by the page's script and posed every frame from
the timeline (mouth follows the caption lines, blinks, arm gestures).

Video 3 (the purchase walkthrough) is a recording of the real site pages, not
an animation: `record-purchase.js` serves this repo at www.sentryvo.com inside
Playwright, answers every backend call with made-up example data (customer
"Luna Demo", luna.demo@example.com, `.example` leak links), and shows
`checkout-demo.html` in place of the hosted checkout. Nothing real is created.
It also writes `events.json` (clicks, typing, page changes, steps), which
`make_music3.py` uses to place the sound effects:

```bash
node record-purchase.js "$PWD/land" landscape     # or: "$PWD/vert" vertical
python3 make_music3.py land/events.json land-music.wav
ffmpeg -i land-music.wav -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 192k land-music.m4a
ffmpeg -framerate 30 -i land/f%05d.jpg -i land-music.m4a -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a copy -shortest -movflags +faststart ../sentryvo-demo3-landscape-1920x1080.mp4
```

Re-record it after changing the sign-up form, checkout flow or dashboard so the
video keeps matching the site.

`promo.html` (vertical) and `promo-landscape.html` share one timeline, so the
same soundtrack fits both. `record.js` steps through the page frame by frame.

The music is original: `make_music.py` synthesises it from scratch with numpy
(no samples or third-party loops), so SentryVo owns it and there is no
copyright claim on it. Hits are timed to the video (radar pings, typing, a hit
on every "REMOVED" stamp, the final logo).

Rebuild after editing:

```bash
python3 make_music.py music.wav
mkdir -p frames lframes
node record.js "$PWD/promo.html" "$PWD/frames" frames 30 1080x1920
node record.js "$PWD/promo-landscape.html" "$PWD/lframes" frames 30 1920x1080
ffmpeg -i music.wav -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 192k music.m4a
ffmpeg -framerate 30 -i frames/f%05d.jpg -i music.m4a -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a copy -shortest -movflags +faststart ../sentryvo-demo-vertical-1080x1920.mp4
ffmpeg -framerate 30 -i lframes/f%05d.jpg -i music.m4a -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a copy -shortest -movflags +faststart ../sentryvo-demo-landscape-1920x1080.mp4
```

Needs Node with Playwright (Chromium), Python 3 with numpy, and ffmpeg.
