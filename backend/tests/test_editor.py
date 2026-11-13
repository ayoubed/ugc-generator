"""The editor's changes at stitch time, the music volume slider, silent scenes, realism rules and ElevenLabs music."""
import httpx
import pytest

from app import elevenlabs, jobs, model_registry, pipeline
from app.pipeline import apply_scene_edit, music_volume_factor, scene_speech_rule, scene_volume_db
from app.routes.music import clean_music_volume, estimated_video_seconds


# --- trims, mute and volume ---------------------------------------------------------------------

def test_an_edit_replaces_the_automatic_trim():
    assert apply_scene_edit(5.0, 0.4, 4.6, {"start": 1.0, "end": 3.5}) == (1.0, 3.5)
    assert apply_scene_edit(5.0, 0.4, 4.6, {"start": 1.0}) == (1.0, 4.6)        # only one side set
    assert apply_scene_edit(5.0, 0.4, 4.6, {"end": 9.0}) == (0.4, 5.0)          # kept inside the clip
    assert apply_scene_edit(5.0, 0.4, 4.6, None) == (0.4, 4.6)


def test_an_edit_that_leaves_almost_nothing_is_ignored():
    assert apply_scene_edit(5.0, 0.4, 4.6, {"start": 3.0, "end": 3.1}) == (0.4, 4.6)
    assert apply_scene_edit(5.0, 0.4, 4.6, {"start": "x", "end": None}) == (0.4, 4.6)


def test_scene_volume_is_a_gain_and_has_a_ceiling():
    assert scene_volume_db({"volume": 1}) == 0.0
    assert scene_volume_db({"volume": 0.5}) == pytest.approx(-6.02, abs=0.01)
    assert scene_volume_db({"volume": 2}) == scene_volume_db({"volume": 10}) == pytest.approx(6.02, abs=0.01)
    assert scene_volume_db(None) == scene_volume_db({}) == scene_volume_db({"volume": 0}) == 0.0


def test_edits_are_read_per_scene_and_only_for_the_take_they_were_made_on():
    scenes = [("1", "0", {"activeAttempt": 2}), ("2", "1", {"activeAttempt": 1}), ("3", "2", {"activeAttempt": 1})]
    project = {"settings": {"edits": {
        "0": {"attempt": 2, "start": 0.5, "end": 4, "muted": True, "volume": 1.5, "junk": "x"},
        "1": {"attempt": 3, "start": 1},          # made on another take
        "2": {"attempt": 1},                      # nothing set
    }}}
    assert jobs.scene_edits(project, scenes) == [{"attempt": 2, "start": 0.5, "end": 4, "volume": 1.5, "muted": True}, None, None]
    assert jobs.scene_edits({}, scenes) == [None, None, None]


def test_a_muted_scene_is_silence_in_the_mix():
    clips = [{"duration": 3.0, "has_audio": True, "gain_db": 0.0}, {"duration": 2.0, "has_audio": False, "gain_db": 0.0}]
    graph, total = pipeline.build_stitch_audio_filter(clips)
    assert total == 5.0
    assert "[0:a]" in graph and "[1:a]" not in graph and "anullsrc" in graph


# --- music volume -------------------------------------------------------------------------------

def test_the_slider_and_the_old_named_levels_mean_the_same_loudness():
    assert music_volume_factor("medium") == music_volume_factor(40) == 0.2
    assert music_volume_factor("low") == music_volume_factor(24)
    assert music_volume_factor(0) == 0.0 and music_volume_factor(100) == 0.5
    assert music_volume_factor(250) == 0.5 and music_volume_factor(-3) == 0.0
    for odd in (None, "loud", True, float("nan")):
        assert music_volume_factor(odd) == 0.2


def test_the_volume_saved_with_a_track_is_a_level_or_a_whole_number():
    assert clean_music_volume(62.4) == 62
    assert clean_music_volume("high") == "high"
    assert clean_music_volume(None, 30) == 30
    assert clean_music_volume(500, "low") == "low"
    assert clean_music_volume("x", None) == "medium"


def test_the_stitch_keeps_a_numeric_music_volume():
    assert jobs.project_music({"settings": {"music": {"source": "upload", "storageRef": "m.mp3", "volume": 65}}})["volume"] == 65
    assert jobs.project_music({"settings": {"music": {"source": "upload", "storageRef": "m.mp3", "volume": "boom"}}})["volume"] == "medium"
    graph, _ = pipeline.build_stitch_audio_filter([{"duration": 3.0, "has_audio": True, "gain_db": 0.0}], music_input_index=1, music_volume=65)
    assert "volume=0.325" in graph


# --- a scene with nothing to say, and realism -----------------------------------------------------

def test_a_scene_without_a_script_is_told_to_stay_silent():
    assert scene_speech_rule("Hello there.") == ""
    for empty in ("", "   ", None):
        assert "Nobody speaks in this scene" in scene_speech_rule(empty)
        assert "Do not repeat lines from other scenes" in scene_speech_rule(empty)


def test_every_video_prompt_asks_for_true_sizes_and_arms_that_belong_to_the_person():
    for prompt in (pipeline.build_omni_generation_prompt("She holds the watch."), pipeline.build_omni_extend_prompt("She turns it over.")):
        assert "real-life size" in prompt and "never larger" in prompt
        assert "belongs to the person in the scene" in prompt


# --- music made to length with ElevenLabs -------------------------------------------------------

def test_elevenlabs_music_is_offered_only_with_a_key(monkeypatch):
    ids = lambda: [m["id"] for m in model_registry.models_payload()["music_models"]]
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert "elevenlabs-music" not in ids()
    assert model_registry.get_music_model("elevenlabs-music")["id"] == model_registry.DEFAULT_MUSIC_MODEL_ID
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    assert "elevenlabs-music" in ids()
    assert model_registry.get_music_model("elevenlabs-music")["provider"] == "elevenlabs"


def test_elevenlabs_music_is_made_to_the_videos_length_without_vocals(tmp_path, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    calls = []

    def fake(method, url, **kwargs):
        calls.append({"url": url, **kwargs})
        return httpx.Response(200, content=b"mp3")

    monkeypatch.setattr(httpx, "request", fake)
    out, mime = pipeline.generate_music("Calm piano", str(tmp_path / "music"), "elevenlabs-music", seconds=27.4)
    assert (open(out, "rb").read(), mime) == (b"mp3", "audio/mpeg")
    assert calls[0]["url"].endswith("/v1/music")
    assert calls[0]["json"] == {"prompt": "Calm piano", "music_length_ms": 27400, "force_instrumental": True}

    elevenlabs.compose_music("x", str(tmp_path / "long"), 5000)
    assert calls[1]["json"]["music_length_ms"] == 600000


def test_the_videos_length_is_estimated_from_its_scenes_and_end_card():
    assert estimated_video_seconds({"settings": {"duration": 5}}, 9) == 45
    assert estimated_video_seconds({"settings": {"duration": 5, "endCard": {"enabled": True, "imageRef": "x.png", "seconds": 4}}}, 2) == 14
    assert estimated_video_seconds({}, 0) == 8
