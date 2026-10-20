# SentryVo demo videos (with original music)

| File | Size | For |
|---|---|---|
| `../sentryvo-demo-vertical-1080x1920.mp4` | 9:16 | Reels, TikTok, Shorts, stories, X/LinkedIn mobile |
| `../sentryvo-demo-landscape-1920x1080.mp4` | 16:9 | YouTube, LinkedIn, X, website |
| `../sentryvo-demo-music.m4a` | audio only | the soundtrack on its own |
| `../sentryvo-demo2-vertical-1080x1920.mp4` | 9:16, 26 s | Video 2, "The last 72 hours of a leak" |
| `../sentryvo-demo2-landscape-1920x1080.mp4` | 16:9, 26 s | Video 2, landscape |
| `../sentryvo-demo2-music.m4a` | audio only | Video 2 soundtrack |

Video 1 (31 s, "Leaked today. Gone tomorrow."): `promo.html`, `promo-landscape.html`, `make_music.py`.
Video 2 (26 s, the 72-hour case): `promo2.html` (open with `#land` for landscape), `make_music2.py`.
Record video 2 with `node record.js "$PWD/promo2.html" frames frames 30 1080x1920` and
`node record.js "$PWD/promo2.html#land" lframes frames 30 1920x1080`.

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
