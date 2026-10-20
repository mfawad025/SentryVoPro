# SentryVo demo video (vertical, 31 s)

`promo.html` is the whole video as one animated page (1080x1920). Every
animation is timed from the start, and `record.js` steps through it frame by
frame, so the output is perfectly smooth.

To change text or timing, edit `promo.html`, then:

```bash
mkdir frames
node record.js "$PWD/promo.html" "$PWD/frames" frames 30
ffmpeg -framerate 30 -i frames/f%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 -movflags +faststart ../sentryvo-demo-vertical-1080x1920.mp4
```

Needs Node with Playwright (Chromium) and ffmpeg. The video has no sound:
add music from the platform's own library when posting.
