"""Beat detection and the choice of where the music starts (app/beats.py)."""
import numpy as np
import pytest

from app import beats


def click_track(bpm: float, first_beat: float, seconds: float = 30.0) -> np.ndarray:
    """A short noise burst on every beat."""
    rng = np.random.default_rng(7)
    samples = np.zeros(int(seconds * beats.SAMPLE_RATE), dtype=np.float32)
    period = 60.0 / bpm
    t = first_beat
    while t < seconds - 0.1:
        start = int(t * beats.SAMPLE_RATE)
        burst = rng.standard_normal(400).astype(np.float32) * np.linspace(1.0, 0.0, 400, dtype=np.float32)
        samples[start:start + 400] += burst
        t += period
    return samples


def distance_to_grid(time: float, period: float, first_beat: float) -> float:
    position = (time - first_beat) % period
    return min(position, period - position)


@pytest.mark.parametrize("bpm,first_beat", [(100.0, 0.10), (120.0, 0.25), (87.0, 0.40)])
def test_finds_tempo_and_beat_position(bpm, first_beat):
    period, found_first, confidence = beats.find_beat(beats.onset_curve(click_track(bpm, first_beat)))
    assert 60.0 / period == pytest.approx(bpm, abs=0.3)
    assert distance_to_grid(first_beat, period, found_first) < 0.02
    assert confidence > beats.MIN_CONFIDENCE


def test_too_short_or_silent_audio_has_no_beat():
    assert len(beats.onset_curve(np.zeros(100, dtype=np.float32))) == 0
    assert beats.find_beat(np.zeros(0)) is None
    assert beats.find_beat(beats.onset_curve(np.zeros(beats.SAMPLE_RATE * 20, dtype=np.float32))) is None


def test_best_start_puts_a_beat_on_a_single_cut():
    start, after, before = beats.best_start([5.2], period=0.5, first_beat=0.0)
    assert 0.0 <= start < 0.5
    assert after < 0.006
    assert before == pytest.approx(0.2)


def test_best_start_with_nothing_to_align():
    assert beats.best_start([], 0.5, 0.0) == (0.0, 0.0, 0.0)


def test_unreadable_music_is_left_alone():
    assert beats.analyse("/no/such/file.mp3") is None
    start, tempo, note = beats.music_fit_for_cuts("/no/such/file.mp3", [5.0])
    assert (start, tempo) == (0.0, 1.0)
    assert "unreadable" in note


def test_no_cuts_means_no_change(monkeypatch):
    monkeypatch.setattr(beats, "analyse", lambda path: pytest.fail("music must not be analysed without cuts"))
    assert beats.music_fit_for_cuts("music.mp3", []) == (0.0, 1.0, None)


def test_music_without_a_steady_beat_is_left_alone(monkeypatch):
    monkeypatch.setattr(beats, "analyse", lambda path: (0.5, 0.0, 0.05))
    start, tempo, note = beats.music_fit_for_cuts("music.mp3", [5.2])
    assert (start, tempo) == (0.0, 1.0)
    assert "no steady beat" in note


def test_beats_already_on_the_cuts_are_left_alone(monkeypatch):
    monkeypatch.setattr(beats, "analyse", lambda path: (0.5, 0.0, 0.6))
    start, tempo, note = beats.music_fit_for_cuts("music.mp3", [5.01, 10.0])
    assert (start, tempo) == (0.0, 1.0)
    assert "already" in note


def test_one_cut_is_fixed_by_a_shift_alone(monkeypatch):
    monkeypatch.setattr(beats, "analyse", lambda path: (0.5, 0.0, 0.6))
    start, tempo, note = beats.music_fit_for_cuts("music.mp3", [5.2])
    assert tempo == 1.0
    assert distance_to_grid(5.2 + start, 0.5, 0.0) < 0.006
    assert "120 BPM" in note


def test_several_cuts_may_use_a_small_tempo_change(monkeypatch):
    monkeypatch.setattr(beats, "analyse", lambda path: (0.5, 0.0, 0.6))
    cuts = [5.2, 10.57, 15.9]
    start, tempo, note = beats.music_fit_for_cuts("music.mp3", cuts)
    assert abs(tempo - 1.0) <= beats.MAX_STRETCH + 1e-9
    # The result is never worse than leaving the music as it is.
    period = 0.5 / tempo
    after = sum(distance_to_grid(c + start, period, 0.0) for c in cuts) / len(cuts)
    before = sum(distance_to_grid(c, 0.5, 0.0) for c in cuts) / len(cuts)
    assert after < before
