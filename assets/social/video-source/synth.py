"""
Small synthesiser shared by the soundtracks of videos 4 and 5.

Every sound is generated from scratch with numpy (no samples or loops from
anywhere else), so the music is SentryVo's own and free of any third-party
copyright.
"""
import wave

import numpy as np

SR = 44100


def t_axis(sec):
    return np.arange(int(SR * sec)) / SR


def lowpass(x, width):
    if width <= 1:
        return x
    return np.convolve(x, np.ones(width) / width, mode='same')


def note(n):
    """Semitones from A4 -> Hz."""
    return 440.0 * 2 ** (n / 12)


class Mix:
    def __init__(self, duration, seed=1):
        self.dur = duration
        self.n = int(SR * duration)
        self.L = np.zeros(self.n)
        self.R = np.zeros(self.n)
        self.rng = np.random.default_rng(seed)

    def add(self, sig, at, gain=1.0, pan=0.0):
        i = int(at * SR)
        if i >= self.n or i < 0:
            return
        sig = sig[: self.n - i] * gain
        self.L[i:i + len(sig)] += sig * (1 - max(0, pan))
        self.R[i:i + len(sig)] += sig * (1 + min(0, pan))

    def noise(self, sec):
        return self.rng.standard_normal(len(t_axis(sec)))

    # ---------- instruments ----------
    def kick(self, depth=1.0):
        t = t_axis(0.5)
        return np.sin(2 * np.pi * np.cumsum(46 + 90 * depth * np.exp(-t * 28)) / SR) * np.exp(-t * 7)

    def snare(self):
        t = t_axis(0.3)
        n = self.noise(0.3)
        return (n - lowpass(n, 3)) * np.exp(-t * 16) * 0.55 + np.sin(2 * np.pi * 210 * t) * np.exp(-t * 30) * 0.4

    def hat(self, open_=False):
        sec = 0.22 if open_ else 0.05
        t = t_axis(sec)
        n = self.noise(sec)
        return (n - lowpass(n, 5)) * np.exp(-t * (16 if open_ else 80)) * 0.3

    def bass(self, freq, length):
        t = t_axis(length)
        s = np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * 2 * freq * t)
        return s * np.minimum(1, t * 180) * np.exp(-t * 2.8)

    def sub(self, freq, length):
        t = t_axis(length)
        env = np.minimum(1, t / 0.4) * np.minimum(1, (length - t) / 0.4)
        return np.sin(2 * np.pi * freq * t) * env

    def pad(self, freqs, length, bright=0.3, attack=0.8):
        t = t_axis(length)
        s = np.zeros(len(t))
        for f in freqs:
            for det in (-0.1, 0.1):
                ff = f * 2 ** (det / 12)
                s += np.sin(2 * np.pi * ff * t) + bright * np.sin(2 * np.pi * 2 * ff * t)
        env = np.minimum(1, t / attack) * np.minimum(1, (length - t) / 0.5)
        return lowpass(s, 10) * env / (len(freqs) * 2)

    def keys(self, freqs, length):
        t = t_axis(length)
        s = np.zeros(len(t))
        for f in freqs:
            s += (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 3)) * np.exp(-t * 1.5)
        return s * np.minimum(1, t * 60) * np.minimum(1, (length - t) / 0.08) / len(freqs)

    def piano(self, freq, length=1.8):
        t = t_axis(length)
        s = sum(np.sin(2 * np.pi * freq * k * t) * np.exp(-t * (1.6 + k)) / k for k in (1, 2, 3, 4))
        return s * np.minimum(1, t * 400)

    def pluck(self, freq, length=0.32):
        t = t_axis(length)
        return (np.sin(2 * np.pi * freq * t) + 0.2 * np.sin(2 * np.pi * 3 * freq * t)) * np.exp(-t * 13)

    def bell(self, freq, length=1.4):
        t = t_axis(length)
        return (np.sin(2 * np.pi * freq * t) + 0.4 * np.sin(2 * np.pi * 2.76 * freq * t) * np.exp(-t * 6)) * np.exp(-t * 3.2)

    def ping(self, freq=1760):
        t = t_axis(0.9)
        return np.sin(2 * np.pi * freq * t * (1 + 0.002 * np.sin(2 * np.pi * 6 * t))) * np.exp(-t * 5)

    def tick(self):
        t = t_axis(0.03)
        n = self.noise(0.03)
        return (n - lowpass(n, 4)) * np.exp(-t * 200) * 0.5 + np.sin(2 * np.pi * 1900 * t) * np.exp(-t * 120) * 0.3

    def keytick(self):
        t = t_axis(0.02)
        n = self.noise(0.02)
        return (n - lowpass(n, 3)) * np.exp(-t * 300)

    def thud(self):
        t = t_axis(0.25)
        return np.sin(2 * np.pi * np.cumsum(90 + 60 * np.exp(-t * 30)) / SR) * np.exp(-t * 14)

    def whoosh(self, length=0.7):
        t = t_axis(length)
        n = self.noise(length)
        shape = np.sin(np.pi * t / length) ** 2
        return ((n - lowpass(n, 4)) * 0.3 + lowpass(n, 25) * 0.5) * shape

    def riser(self, length):
        t = t_axis(length)
        n = self.noise(length)
        sweep = np.sin(2 * np.pi * np.cumsum(250 + 1400 * (t / length) ** 2) / SR)
        return ((n - lowpass(n, 5)) * 0.3 + sweep * 0.22) * (t / length) ** 2.2

    def impact(self):
        t = t_axis(2.0)
        n = self.noise(2.0)
        boom = np.sin(2 * np.pi * np.cumsum(36 + 80 * np.exp(-t * 16)) / SR) * np.exp(-t * 2.4)
        return boom * 1.1 + lowpass(n, 14) * np.exp(-t * 3.5) * 0.5

    # ---------- output ----------
    def write(self, path, fade_in=0.3, fade_out=1.8):
        fade = np.ones(self.n)
        fi, fo = int(fade_in * SR), int(fade_out * SR)
        if fi:
            fade[:fi] = np.linspace(0, 1, fi)
        fade[-fo:] = np.linspace(1, 0, fo) ** 1.5
        mix = np.tanh(np.stack([self.L, self.R]) * fade * 0.9)
        mix /= np.max(np.abs(mix)) / 0.89
        with wave.open(path, 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((mix.T * 32767).astype('<i2').tobytes())
        print(f'wrote {path}: {self.dur:.1f} s stereo {SR} Hz')
