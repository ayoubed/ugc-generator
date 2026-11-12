"""
Finds the beat of a music track and the best place to start it, so beats land on the cuts between
scenes. Speech fixes where the cuts fall, so the music is moved instead: it starts a fraction of a
beat into the track.

No audio library: ffmpeg decodes the track and numpy does the rest (numpy comes with OpenCV).
Everything except `load_mono` is pure and easy to test.
"""
import subprocess
from typing import List, Optional, Tuple

import numpy as np

SAMPLE_RATE = 11025
HOP = 128                      # ~11.6 ms per step of the onset curve
FRAME = 512
MIN_BPM, MAX_BPM = 70.0, 180.0
ANALYSE_SECONDS = 45.0
# Below this the track has no steady beat worth following (ambient pads, free tempo).
MIN_CONFIDENCE = 0.12
# A beat this close to a cut already reads as "on the cut"; no point shifting for less.
CLOSE_ENOUGH_SECONDS = 0.04


def load_mono(path: str, seconds: float = ANALYSE_SECONDS) -> np.ndarray:
    """The start of an audio file as mono float samples at SAMPLE_RATE."""
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-t", f"{seconds:.2f}", "-i", path, "-vn", "-ac", "1",
         "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
        capture_output=True, check=True,
    )
    return np.frombuffer(result.stdout, dtype=np.float32)


def onset_curve(samples: np.ndarray) -> np.ndarray:
    """How much new sound energy arrives at each step (spectral flux): peaks where notes and drums hit."""
    if len(samples) < FRAME * 4:
        return np.zeros(0)
    count = 1 + (len(samples) - FRAME) // HOP
    index = np.arange(FRAME)[None, :] + HOP * np.arange(count)[:, None]
    spectrum = np.abs(np.fft.rfft(samples[index] * np.hanning(FRAME), axis=1))
    flux = np.maximum(0.0, np.diff(np.log1p(100.0 * spectrum), axis=0)).sum(axis=1)
    # Remove the slow swell so only hits remain.
    window = max(3, int(0.4 * SAMPLE_RATE / HOP))
    local_mean = np.convolve(flux, np.ones(window) / window, mode="same")
    return np.maximum(0.0, flux - local_mean)


def find_beat(curve: np.ndarray) -> Optional[Tuple[float, float, float]]:
    """
    (seconds per beat, time of the first beat, confidence 0..1) from an onset curve, or None when
    the track is too short. Tempo comes from the curve's self-similarity; the first beat is the
    shift at which a beat grid collects the most onset energy.
    """
    step = HOP / SAMPLE_RATE
    lo, hi = int(round(60.0 / MAX_BPM / step)), int(round(60.0 / MIN_BPM / step))
    if len(curve) < hi * 4 or not np.any(curve):
        return None
    centred = curve - curve.mean()
    energy = float(np.dot(centred, centred)) or 1.0
    lags = np.arange(lo, hi + 1)
    scores = np.array([np.dot(centred[:-lag], centred[lag:]) / energy for lag in lags])
    # Gentle preference for everyday tempos, so half or double time doesn't win by a hair.
    bpm = 60.0 / (lags * step)
    scores_weighted = scores * np.exp(-0.5 * (np.log2(bpm / 115.0) / 0.9) ** 2)
    best = int(np.argmax(scores_weighted))
    lag = int(lags[best])
    confidence = float(max(0.0, scores[best]))

    # Refine: a whole number of steps is too coarse (the error adds up over dozens of beats), so try
    # periods in between and, for each, every starting point; keep the grid that collects the most
    # onset energy. The curve is blurred a little so a near miss still counts.
    blurred = np.convolve(curve, np.hanning(5) / np.hanning(5).sum(), mode="same")
    best_score, best_period, best_phase = -1.0, float(lag), 0.0
    for period in np.linspace(lag - 1.0, lag + 1.0, 81):
        beats = int((len(blurred) - 1 - period) // period)
        if beats < 4:
            continue
        phases = np.arange(0.0, period, 0.5)
        positions = np.rint(phases[:, None] + period * np.arange(beats)[None, :]).astype(int)
        totals = blurred[positions].mean(axis=1)
        top = int(np.argmax(totals))
        if totals[top] > best_score:
            best_score, best_period, best_phase = float(totals[top]), float(period), float(phases[top])
    # The onset curve is a difference between frames, centred half a frame after each hop start.
    latency = (FRAME / 2 + HOP) / SAMPLE_RATE
    first_beat = (best_phase * step + latency) % (best_period * step)
    return best_period * step, first_beat, confidence


def analyse(path: str) -> Optional[Tuple[float, float, float]]:
    """find_beat for a music file; None if it can't be read or has no usable length."""
    try:
        return find_beat(onset_curve(load_mono(path)))
    except Exception:
        return None


def best_start(cuts: List[float], period: float, first_beat: float) -> Tuple[float, float, float]:
    """
    How far into the track to start (0 <= start < period) so its beats fall closest to the cuts.
    Returns (start, average distance from a cut to its nearest beat with that start, the same
    average with no shift).
    """
    def miss(start: float) -> float:
        total = 0.0
        for cut in cuts:
            position = (cut + start - first_beat) % period
            total += min(position, period - position)
        return total / len(cuts)

    if not cuts or period <= 0:
        return 0.0, 0.0, 0.0
    candidates = np.arange(0.0, period, 0.005)
    scores = [miss(float(c)) for c in candidates]
    start = float(candidates[int(np.argmin(scores))])
    return start, float(min(scores)), miss(0.0)


# The music may be played up to this much faster or slower: too little to hear, enough to make a
# second and third cut land on a beat as well.
MAX_STRETCH = 0.03
# A stretch has to buy at least this much over a plain shift to be used.
STRETCH_MUST_GAIN_SECONDS = 0.02


def music_fit_for_cuts(music_path: str, cuts: List[float]) -> Tuple[float, float, Optional[str]]:
    """
    How to play the music for a video with these cut times: (seconds to skip at the start, tempo
    factor, a short note for the log). The skip is measured after the tempo change. (0.0, 1.0)
    when there is nothing to gain: no cuts, no steady beat, or the beats already sit on the cuts.
    """
    if not cuts:
        return 0.0, 1.0, None
    beat = analyse(music_path)
    if not beat:
        return 0.0, 1.0, "music too short or unreadable for beat matching"
    period, first_beat, confidence = beat
    if confidence < MIN_CONFIDENCE:
        return 0.0, 1.0, f"no steady beat found (confidence {confidence:.2f})"

    start, after, before = best_start(cuts, period, first_beat)
    tempo = 1.0
    if len(cuts) > 1:
        for candidate in np.arange(1.0 - MAX_STRETCH, 1.0 + MAX_STRETCH + 1e-9, 0.0025):
            c = float(candidate)
            c_start, c_after, _ = best_start(cuts, period / c, first_beat / c)
            if c_after < after - STRETCH_MUST_GAIN_SECONDS:
                start, after, tempo = c_start, c_after, c
    if before - after < CLOSE_ENOUGH_SECONDS:
        return 0.0, 1.0, f"beats already near the cuts ({60 / period:.0f} BPM)"
    speed = "" if tempo == 1.0 else f", played {abs(tempo - 1) * 100:.1f}% {'faster' if tempo > 1 else 'slower'}"
    return start, tempo, (
        f"{60 / period:.0f} BPM; music starts {start:.2f}s in{speed}; cuts are now {after * 1000:.0f} ms "
        f"from a beat on average (was {before * 1000:.0f} ms)"
    )
