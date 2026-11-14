"""Sound effects from the editor: making one, where it lands in the video, the mix and the export."""
import os
import shutil
import subprocess
import xml.etree.ElementTree as ET
import zipfile

import httpx
import pytest

from app import elevenlabs, jobs, pipeline
from app.interchange import build_readme, build_xmeml
from app.pipeline import place_sounds, sound_volume_factor
from app.routes import sounds
from tests.test_elevenlabs import stitch  # noqa: F401  (a fixture: the stitch job with its services replaced)
from tests.test_interchange import numbers, packaged, parsed, timeline  # noqa: F401  (packaged is a fixture)


# --- making a sound -------------------------------------------------------------------------------

def test_a_sound_is_made_from_its_description(monkeypatch, tmp_path):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    seen = {}

    def fake_request(method, url, **kwargs):
        seen.update(method=method, url=url, json=kwargs.get("json"), params=kwargs.get("params"))
        return httpx.Response(200, content=b"mp3-bytes")

    monkeypatch.setattr(httpx, "request", fake_request)
    out = elevenlabs.make_sound("soft whoosh", str(tmp_path / "s.mp3"), 30)
    assert open(out, "rb").read() == b"mp3-bytes"
    assert seen["url"].endswith("/v1/sound-generation")
    assert seen["json"] == {"text": "soft whoosh", "prompt_influence": 0.5, "duration_seconds": 10.0}   # length is capped

    elevenlabs.make_sound("pop", str(tmp_path / "p.mp3"))
    assert "duration_seconds" not in seen["json"]              # no length given: the service picks one


def test_a_refused_description_is_said_in_plain_words(monkeypatch, tmp_path):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    monkeypatch.setattr(httpx, "request", lambda *a, **k: httpx.Response(400, text="bad"))
    with pytest.raises(elevenlabs.VoiceServiceError, match="did not accept this description"):
        elevenlabs.make_sound("x y", str(tmp_path / "s.mp3"))


def test_the_label_is_short():
    assert sounds.sound_name("soft   whoosh") == "Soft whoosh"
    assert len(sounds.sound_name("a very long description of a sound that goes on and on")) == 32


@pytest.fixture
def sound_api(api, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    made = []

    def fake_make(prompt, path, seconds=None):
        made.append((prompt, seconds))
        open(path, "wb").write(b"mp3")
        return path

    monkeypatch.setattr(elevenlabs, "make_sound", fake_make)
    monkeypatch.setattr(sounds, "probe_media", lambda path: {"duration": 1.234})
    monkeypatch.setattr(sounds, "upload_file", lambda path, ref, content_type=None: None)
    monkeypatch.setattr(sounds, "get_download_url", lambda ref: f"https://files.test/{ref}")
    api.db.collection("projects").document("p1").set({"userId": "u1", "settings": {}})
    api.db.collection("projects").document("p2").set({"userId": "someone-else"})
    api.made = made
    return api


def test_the_route_returns_the_sound_without_placing_it(sound_api):
    response = sound_api.post("/api/projects/p1/sounds", json={"prompt": "  cash   register ", "seconds": 2})
    assert response.status_code == 200
    body = response.json()
    assert sound_api.made == [("cash register", 2.0)]
    assert body["name"] == "Cash register" and body["seconds"] == 1.23
    assert body["storageRef"] == f"users/u1/projects/p1/sounds/{body['id']}.mp3"
    assert body["url"].endswith(".mp3")
    assert "sounds" not in sound_api.db.store["projects/p1"]["settings"]      # the editor saves where it goes


def test_the_route_is_for_the_owner_and_checks_what_it_is_given(sound_api):
    assert sound_api.post("/api/projects/p2/sounds", json={"prompt": "pop"}).status_code == 403
    assert sound_api.post("/api/projects/nope/sounds", json={"prompt": "pop"}).status_code == 404
    assert sound_api.post("/api/projects/p1/sounds", json={"prompt": ""}).status_code == 422
    assert sound_api.post("/api/projects/p1/sounds", json={"prompt": "pop", "seconds": 60}).status_code == 422
    assert sound_api.made == []


def test_the_route_says_so_when_the_service_is_missing_full_or_failing(sound_api, monkeypatch):
    sound_api.db.collection("projects").document("p1").update(
        {"settings": {"sounds": {str(n): {} for n in range(sounds.MAX_SOUNDS_PER_PROJECT)}}})
    response = sound_api.post("/api/projects/p1/sounds", json={"prompt": "pop"})
    assert response.status_code == 400 and "Remove one" in response.json()["detail"]

    sound_api.db.collection("projects").document("p1").update({"settings": {}})

    def failing(prompt, path, seconds=None):
        raise elevenlabs.VoiceServiceError("The voice service is busy or its usage allowance ran out. Wait a minute and try again.")

    monkeypatch.setattr(elevenlabs, "make_sound", failing)
    response = sound_api.post("/api/projects/p1/sounds", json={"prompt": "pop"})
    assert response.status_code == 502 and "usage allowance" in response.json()["detail"]

    monkeypatch.delenv("ELEVENLABS_API_KEY")
    assert sound_api.post("/api/projects/p1/sounds", json={"prompt": "pop"}).status_code == 503


# --- what the project holds -------------------------------------------------------------------------

def test_saved_sounds_are_cleaned_and_broken_ones_dropped():
    project = {"settings": {"sounds": {
        "a": {"storageRef": "users/u1/projects/p1/sounds/a.mp3", "sceneId": 1, "at": 2.34567, "volume": 250, "name": "Whoosh", "url": "x"},
        "b": {"storageRef": "users/u1/projects/p1/sounds/b.mp3", "sceneId": "end", "at": 0},
        "no-file": {"sceneId": "0", "at": 1},
        "no-place": {"storageRef": "f.mp3", "at": 1},
        "bad-time": {"storageRef": "f.mp3", "sceneId": "0", "at": "soon"},
        "negative": {"storageRef": "f.mp3", "sceneId": "0", "at": -1},
        "junk": "x",
    }}}
    assert jobs.project_sounds(project) == {
        "a": {"storageRef": "users/u1/projects/p1/sounds/a.mp3", "sceneId": "1", "at": 2.346, "volume": 100, "name": "Whoosh"},
        "b": {"storageRef": "users/u1/projects/p1/sounds/b.mp3", "sceneId": "end", "at": 0.0, "volume": 60, "name": "Sound"},
    }
    assert jobs.project_sounds({}) == jobs.project_sounds({"settings": {"sounds": []}}) == {}


def test_the_stitch_gets_the_sounds_of_scenes_in_the_video_and_records_how_they_were_placed(stitch):
    placed = {
        "w": {"storageRef": "users/u1/projects/p1/sounds/w.mp3", "sceneId": "1", "at": 2, "volume": 80, "name": "Whoosh", "url": "u"},
        "d": {"storageRef": "users/u1/projects/p1/sounds/d.mp3", "sceneId": "end", "at": 0.5},
        "x": {"storageRef": "users/u1/projects/p1/sounds/x.mp3", "sceneId": "7", "at": 1},     # that scene is gone
    }
    project, seen = stitch({"sounds": placed})
    assert project["status"] == "completed"
    given = seen["stitched"]["sounds"]
    assert [(s["clip"], s["at"], s["volume"]) for s in given] == [("end", 0.5, 60), (1, 2.0, 80)]
    assert all(s["path"].endswith(".mp3") for s in given)
    version = project["finalVideos"].values[-1]
    assert version["sounds"]["w"] == {"storageRef": "users/u1/projects/p1/sounds/w.mp3", "sceneId": "1", "at": 2.0, "volume": 80}
    assert set(version["sounds"]) == {"w", "d", "x"}             # as placed, so a later change is noticed


def test_a_sound_file_of_someone_else_stops_the_stitch(stitch):
    project, seen = stitch({"sounds": {"w": {"storageRef": "users/u2/projects/p9/sounds/w.mp3", "sceneId": "0", "at": 1}}})
    assert project["status"] != "completed" and seen["stitched"] is None


def test_a_version_without_sounds_records_that(stitch):
    project, seen = stitch()
    assert seen["stitched"]["sounds"] == [] and project["finalVideos"].values[-1]["sounds"] == {}


# --- where a sound lands ----------------------------------------------------------------------------

CLIPS = [{"trim_start": 0.5, "duration": 3.0}, {"trim_start": 0.0, "duration": 2.0}]


def test_a_sound_stays_on_its_frame_whatever_is_trimmed():
    placed = place_sounds(CLIPS, [{"clip": 0, "at": 1.5}, {"clip": 1, "at": 0.25}])
    assert [s["time"] for s in placed] == [1.0, 3.25]           # 1.5s into clip 1 is 1.0s after its cut start
    # The first scene gets a later start: the same frame is now earlier in the video.
    assert place_sounds([{"trim_start": 1.0, "duration": 2.5}, CLIPS[1]], [{"clip": 0, "at": 1.5}])[0]["time"] == 0.5


def test_a_sound_on_a_part_that_was_cut_away_is_left_out():
    kept = place_sounds(CLIPS, [{"clip": 0, "at": 0.2}, {"clip": 0, "at": 3.4}, {"clip": 0, "at": 3.5}])
    assert [s["at"] for s in kept] == [3.4]                     # before the cut start and at the cut end: gone


def test_a_sound_a_hair_before_the_kept_start_plays_at_the_start():
    cut = [{"trim_start": 0.433, "duration": 3.0}]
    assert place_sounds(cut, [{"clip": 0, "at": 0.43}])[0]["time"] == 0.0       # saved to the hundredth
    assert place_sounds(cut, [{"clip": 0, "at": 0.41}]) == []


def test_sounds_on_the_end_card_need_an_end_card():
    with_card = CLIPS + [{"trim_start": 0.0, "duration": 2.5}]
    assert place_sounds(with_card, [{"clip": "end", "at": 0.5}], has_end_card=True)[0]["time"] == 5.5
    assert place_sounds(CLIPS, [{"clip": "end", "at": 0.5}]) == []
    assert place_sounds(with_card, [{"clip": 2, "at": 0.5}], has_end_card=True) == []     # a scene index never means the card


def test_sounds_without_a_usable_place_are_ignored():
    for odd in ({"clip": 5, "at": 1}, {"clip": None, "at": 1}, {"clip": True, "at": 1}, {"clip": 0, "at": "x"}, {"clip": 0}):
        assert place_sounds(CLIPS, [odd]) == []
    assert place_sounds(CLIPS, None) == []


# --- the mix ----------------------------------------------------------------------------------------

def test_volume_is_a_share_of_full_and_defaults_to_sixty():
    assert sound_volume_factor(100) == 1.0 and sound_volume_factor(50) == 0.5 and sound_volume_factor(0) == 0.0
    assert sound_volume_factor(400) == 1.0 and sound_volume_factor(-5) == 0.0
    for odd in (None, "loud", True, float("nan")):
        assert sound_volume_factor(odd) == 0.6


def test_each_sound_is_delayed_to_its_moment_and_mixed_over_the_voice():
    clips = [{"duration": 3.0, "has_audio": True, "gain_db": 0.0}, {"duration": 2.0, "has_audio": True, "gain_db": 0.0}]
    graph, total = pipeline.build_stitch_audio_filter(clips, sounds=[
        {"input_index": 2, "time": 1.25, "gain_db": 4.0, "volume": 50},
        {"input_index": 3, "time": 4.0, "gain_db": 0.0, "volume": 0},        # silent: not mixed at all
        {"input_index": 4, "time": 9.0, "gain_db": 0.0, "volume": 80},       # after the end
    ])
    assert total == 5.0
    assert "[2:a]" in graph and "volume=4.00dB,volume=0.5,adelay=1250:all=1[fx0]" in graph
    assert "[3:a]" not in graph and "[4:a]" not in graph
    assert "[voice][fx0]amix=inputs=2:duration=first:normalize=0[withfx]" in graph
    assert graph.endswith("[withfx]atrim=0:5.000[aout]")


def test_sounds_go_on_top_of_the_music_and_under_nothing():
    clips = [{"duration": 3.0, "has_audio": True, "gain_db": 0.0}]
    graph, _ = pipeline.build_stitch_audio_filter(clips, music_input_index=1, room_tone=True, sounds=[
        {"input_index": 2, "time": 0.0, "gain_db": 0.0, "volume": 60}])
    assert "[mix][fx0]amix=inputs=2" in graph                     # after the music is ducked: the sound is not
    assert "[withfx][room]amix" in graph
    assert "fx" not in pipeline.build_stitch_audio_filter(clips)[0]


needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")


def make(cmd):
    subprocess.run(["ffmpeg", "-y", "-v", "error", *cmd], check=True)


@needs_ffmpeg
def test_a_stitched_video_has_the_sound_where_it_was_placed(tmp_path):
    scene = str(tmp_path / "scene.mp4")
    beep = str(tmp_path / "beep.mp3")
    # A silent 3-second scene, so the only thing heard is the effect.
    make(["-f", "lavfi", "-i", "color=c=gray:s=180x320:r=24:d=3", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
          "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-t", "3", scene])
    make(["-f", "lavfi", "-i", "sine=frequency=880:duration=0.4", "-af", "volume=0.2", beep])
    assert pipeline.measure_peak_db(beep) == pytest.approx(-32, abs=3)       # quiet on purpose: the mix levels it
    out = str(tmp_path / "final.mp4")
    report = {}
    pipeline.stitch_videos([scene], out, caption_style=None, tight_cuts=False, report=report, sounds=[
        {"path": beep, "clip": 0, "at": 2.0, "volume": 100},
        {"path": beep, "clip": 0, "at": 7.0, "volume": 100},        # past the clip: left out
        {"path": str(tmp_path / "missing.mp3"), "clip": 0, "at": 1.0, "volume": 100},
    ])
    assert report["sounds"] == 1

    def loudest(start, length):
        result = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-ss", str(start), "-t", str(length), "-i", out,
                                 "-vn", "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True)
        return float(result.stderr.split("max_volume:")[1].split("dB")[0])

    assert loudest(2.05, 0.3) > loudest(0.5, 1.0) + 20          # the beep at 2s, near-silence before it
    assert loudest(2.05, 0.3) > loudest(2.6, 0.3) + 20          # and after it


# --- the export for other editors -------------------------------------------------------------------

def test_sounds_are_on_their_own_tracks_and_overlapping_ones_get_another_pair():
    root = parsed(timeline(music={"file": "media/music.mp3", "duration": 30.0}, sounds=[
        {"name": "Whoosh", "file": "media/sound_01.mp3", "duration": 1.0, "time": 1.0},
        {"name": "Pop", "file": "media/sound_02.mp3", "duration": 0.5, "time": 1.5},      # overlaps the whoosh
        {"name": "Ding", "file": "media/sound_03.mp3", "duration": 2.0, "time": 5.0},     # runs past the end: cut
        {"name": "Late", "file": "media/sound_04.mp3", "duration": 1.0, "time": 60.0},    # after the video: left out
    ]))
    tracks = root.findall("sequence/media/audio/track")
    assert len(tracks) == 2 + 2 + 4                                  # scenes, music, two pairs of sounds
    names = [[item.findtext("name") for item in track.findall("clipitem")] for track in tracks[4:]]
    assert names == [["Whoosh", "Ding"], ["Whoosh", "Ding"], ["Pop"], ["Pop"]]
    whoosh, ding = tracks[4].findall("clipitem")
    assert numbers(whoosh) == {"start": 24, "end": 48, "in": 0, "out": 24, "duration": 24}
    assert numbers(ding) == {"start": 120, "end": 132, "in": 0, "out": 12, "duration": 48}
    assert whoosh.findtext("file/pathurl") == "media/sound_01.mp3"
    assert "the sound effects" in build_readme("Mug ad", True, True, False, True)
    assert "sound effects, " not in build_readme("Mug ad", True, True, False)


def test_the_package_holds_the_sounds_that_are_heard(packaged):
    project, uploaded = packaged
    project.update({"settings.sounds": {
        "a": {"storageRef": "users/u1/projects/p1/sounds/a.mp3", "sceneId": "1", "at": 1.0, "name": "Pop"},
        "cut": {"storageRef": "users/u1/projects/p1/sounds/c.mp3", "sceneId": "0", "at": 0.1, "name": "Cut away"},
        "gone": {"storageRef": "users/u1/projects/p1/sounds/g.mp3", "sceneId": "9", "at": 1.0, "name": "No scene"},
    }})
    from app.routes import package
    package._run_package_job_sync("u1", "p1")
    assert project.get().to_dict()["packageStatus"] == "ready"
    with zipfile.ZipFile(uploaded["path"]) as archive:
        assert [n for n in archive.namelist() if "sound" in n] == ["mug-ad/media/sound_01.mp3"]
        assert archive.read("mug-ad/media/sound_01.mp3") == b"media:users/u1/projects/p1/sounds/a.mp3"
        xml = archive.read("mug-ad/timeline.xml").decode()
    root = ET.fromstring(xml.split("<!DOCTYPE xmeml>\n", 1)[1])
    pop = root.findall("sequence/media/audio/track")[4].find("clipitem")
    assert pop.findtext("name") == "Pop"
    assert pop.findtext("start") == str(int(round((4.2 + 1.0) * 24)))        # scene 1 is 4.2s long after its cut
