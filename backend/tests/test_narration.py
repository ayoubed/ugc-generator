"""Narration: a scene's voice made from text, slid and trimmed in the editor, put on by the stitch."""
import shutil
import subprocess

import httpx
import pytest

from app import elevenlabs, jobs, voiceover
from app.routes import narration as routes
from app.voiceover import narration_tail, narration_voice, scene_narration, voices_filter
from tests.test_elevenlabs import stitch  # noqa: F401  (a fixture: the stitch job with its services replaced)

BASE = "users/u1/projects/p1/"
MADE = {"text": "Line 0.", "voiceId": "v1", "voiceName": "Ana", "storageRef": f"{BASE}scenes/0/narration_a.mp3", "seconds": 4.0}


# --- the text ---------------------------------------------------------------------------------------

def test_a_pause_mark_becomes_a_silence_and_is_not_part_of_what_is_read():
    text = "We broke all three. [pause 1.5] Still paid rent. [PAUSE] Twice.[pause 9]"
    assert elevenlabs.speech_markup(text) == (
        'We broke all three. <break time="1.5s" /> Still paid rent. <break time="0.6s" /> Twice. <break time="3.0s" />'
    )
    assert elevenlabs.without_pauses(text) == "We broke all three. Still paid rent. Twice."
    assert elevenlabs.speech_markup("Half [pause 0,5s] a second") == 'Half <break time="0.5s" /> a second'


def test_typed_tags_are_never_sent_as_markup():
    assert elevenlabs.speech_markup('Hi <break time="60s" /> there <b>now</b>') == 'Hi break time="60s" / there b now /b'


def test_the_text_is_read_in_the_chosen_voice(monkeypatch, tmp_path):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    seen = {}

    def fake_request(method, url, **kwargs):
        seen.update(url=url, json=kwargs.get("json"))
        return httpx.Response(200, content=b"mp3")

    monkeypatch.setattr(httpx, "request", fake_request)
    out = elevenlabs.speak("Hello [pause] there", "v1", str(tmp_path / "n.mp3"))
    assert open(out, "rb").read() == b"mp3"
    assert seen["url"].endswith("/v1/text-to-speech/v1")
    assert seen["json"] == {"text": 'Hello <break time="0.6s" /> there', "model_id": elevenlabs.SPEECH_MODEL}
    with pytest.raises(elevenlabs.VoiceServiceError, match="no text"):
        elevenlabs.speak(" [pause] ", "v1", str(tmp_path / "n.mp3"))


# --- where it sits ----------------------------------------------------------------------------------

def project(**placed):
    return {"settings": {"narration": {"0": placed}}} if placed else {"settings": {}}


def test_a_narration_starts_with_its_scene_until_it_is_moved():
    found = scene_narration(project(), "0", {"narration": MADE})
    assert (found["at"], found["trimStart"], found["trimEnd"], found["seconds"]) == (0.0, 0.0, 0.0, 4.0)
    moved = scene_narration(project(at=1.25, trimStart=0.5, trimEnd=1), "0", {"narration": MADE})
    assert (moved["at"], moved["trimStart"], moved["trimEnd"]) == (1.25, 0.5, 1.0)
    assert moved["key"] != found["key"]                       # what is heard changed


def test_a_scene_without_a_narration_or_with_it_switched_off_has_none():
    assert scene_narration(project(), "0", {}) is None
    assert scene_narration(project(), "0", {"narration": None}) is None
    assert scene_narration(project(), "0", {"narration": {**MADE, "seconds": 0}}) is None
    assert scene_narration(project(on=False), "0", {"narration": MADE}) is None
    assert scene_narration(project(on=True), "0", {"narration": MADE}) is not None
    assert scene_narration({"settings": {"narration": {"1": {"on": False}}}}, "0", {"narration": MADE}) is not None


def test_bad_numbers_and_trims_that_leave_nothing_are_put_right():
    found = scene_narration(project(at=-3, trimStart="x", trimEnd=float("nan")), "0", {"narration": MADE})
    assert (found["at"], found["trimStart"], found["trimEnd"]) == (0.0, 0.0, 0.0)
    cut = scene_narration(project(trimStart=3.5, trimEnd=3.5), "0", {"narration": MADE})
    assert cut["trimStart"] == 3.5 and cut["seconds"] - cut["trimStart"] - cut["trimEnd"] >= 0.1 - 1e-9
    assert scene_narration(project(trimStart=99), "0", {"narration": MADE})["trimStart"] == 3.9


def test_the_filter_cuts_the_voice_and_starts_it_at_its_place():
    voice = narration_voice({"seconds": 4.0, "at": 1.25, "trimStart": 0.5, "trimEnd": 1.0}, "n.mp3")
    assert voice == {"path": "n.mp3", "at": 1.25, "start": 0.5, "end": 3.0}
    text = voices_filter([voice], keep_own_sound=False)
    assert "atrim=start=0.500:end=3.000" in text and "adelay=1250:all=1" in text and text.endswith("apad[voice]")
    assert "amix" not in text and "[0:a]" not in text


def test_several_voices_and_the_scene_own_sound_are_mixed():
    tail = {"path": "n.mp3", "at": 0.0, "start": 2.0, "end": 3.0}
    assert "[0:a][v1]amix=inputs=2" in voices_filter([tail], keep_own_sound=True)
    assert "[v1][v2]amix=inputs=2" in voices_filter([tail, tail], keep_own_sound=False)


def test_what_is_left_to_say_when_the_scene_ends_carries_on():
    told = {"seconds": 10.0, "at": 1.0, "trimStart": 0.5, "trimEnd": 0.5}          # 9s kept, heard from 1s to 10s
    assert narration_tail(told, 8.0) == {"start": 7.5, "end": 9.5}                # 7s were said in the scene
    assert narration_tail(told, 10.0) is None and narration_tail(told, 12.0) is None
    assert narration_tail(told, 9.98) is None                                     # a blink is not worth it
    assert narration_tail(told, 0.5) == {"start": 0.5, "end": 9.5}                # the scene ends before it starts: all of it


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
def test_the_scene_keeps_its_picture_and_length_and_gets_the_voice_as_its_sound(tmp_path):
    video, voice, out = str(tmp_path / "scene.mp4"), str(tmp_path / "voice.mp3"), str(tmp_path / "out.mp4")
    run = lambda *args: subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)
    run("-f", "lavfi", "-i", "color=c=gray:s=64x64:d=3", "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video)
    run("-f", "lavfi", "-i", "sine=frequency=900:duration=6", voice)             # longer than the scene: its end is cut
    voiceover.voiced_scene(video, [narration_voice({"seconds": 6.0, "at": 1.0, "trimStart": 0.5, "trimEnd": 0.0}, voice)], out)
    info = voiceover.probe_media(out)
    assert info["has_audio"] and abs(info["duration"] - 3.0) < 0.15

    # Silent before the voice starts, sounding after.
    def loudness(start, length):
        result = subprocess.run(
            ["ffmpeg", "-v", "info", "-ss", str(start), "-t", str(length), "-i", out, "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True,
        )
        return float(result.stderr.split("mean_volume:")[1].split("dB")[0])

    assert loudness(0.1, 0.6) < -60 and loudness(1.5, 1.0) > -30

    # With the scene's own sound kept, it is heard from the start and the voice is added to it.
    voiceover.voiced_scene(video, [{"path": voice, "at": 0.0, "start": 3.0, "end": 4.0}], out, keep_own_sound=True)
    assert loudness(1.5, 1.0) > -30 and abs(voiceover.probe_media(out)["duration"] - 3.0) < 0.15


# --- making and removing one --------------------------------------------------------------------------

@pytest.fixture
def studio(api, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    api.db.store["projects/p1"] = {"userId": "u1", "settings": {"voice": {"id": "v1", "name": "Ana"}}}
    api.db.store["projects/p1/scenes/0"] = {"script": "This watch looks expensive."}
    api.spoken = []

    def fake_speak(text, voice_id, path):
        api.spoken.append((text, voice_id))
        open(path, "wb").write(b"mp3")
        return path

    monkeypatch.setattr(elevenlabs, "speak", fake_speak)
    monkeypatch.setattr(routes, "probe_media", lambda path: {"duration": 3.456})
    monkeypatch.setattr(routes, "upload_file", lambda path, ref, content_type=None: ref)
    monkeypatch.setattr(routes, "get_download_url", lambda ref: f"https://files.test/{ref}")
    return api


def test_the_script_is_read_when_no_text_is_given(studio):
    response = studio.post("/api/projects/p1/scenes/0/narration", json={})
    assert response.status_code == 200, response.text
    made = response.json()
    assert studio.spoken == [("This watch looks expensive.", "v1")]
    assert made["seconds"] == 3.46 and made["voiceName"] == "Ana"
    assert made["storageRef"].startswith(f"{BASE}scenes/0/narration_") and made["url"].endswith(".mp3")
    assert studio.db.store["projects/p1/scenes/0"]["narration"] == made
    assert studio.db.store["projects/p1/scenes/0"]["script"] == "This watch looks expensive."   # the script is not touched


def test_the_narration_has_its_own_text_with_pauses(studio):
    made = studio.post("/api/projects/p1/scenes/0/narration", json={"text": "This watch  [pause 1] looks expensive."}).json()
    assert made["text"] == "This watch [pause 1] looks expensive." and studio.spoken[0][0] == made["text"]


def test_making_needs_a_voice_some_text_and_the_owner(studio):
    post = lambda body=None: studio.post("/api/projects/p1/scenes/0/narration", json=body or {})
    assert post({"text": " [pause] "}).status_code == 400
    assert post({"text": "x" * 1300}).status_code == 422
    studio.db.store["projects/p1"]["settings"] = {}
    assert post().status_code == 400 and "Choose a voice" in post().json()["detail"]
    assert studio.post("/api/projects/p1/scenes/9/narration", json={}).status_code == 404
    studio.db.store["projects/p1"]["userId"] = "someone-else"
    assert post().status_code == 403
    assert studio.spoken == []


def test_without_the_voice_service_nothing_is_made(studio, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    assert studio.post("/api/projects/p1/scenes/0/narration", json={}).status_code == 503


def test_a_failure_is_said_in_plain_words_and_keeps_the_old_narration(studio, monkeypatch):
    studio.db.store["projects/p1/scenes/0"]["narration"] = MADE

    def broken(*args):
        raise elevenlabs.VoiceServiceError("The voice service is busy or its usage allowance ran out. Wait a minute and try again.")
    monkeypatch.setattr(elevenlabs, "speak", broken)
    response = studio.post("/api/projects/p1/scenes/0/narration", json={})
    assert response.status_code == 502 and "busy" in response.json()["detail"]
    assert studio.db.store["projects/p1/scenes/0"]["narration"] == MADE


def test_removing_it_gives_the_scene_its_own_sound_back(studio):
    studio.db.store["projects/p1/scenes/0"]["narration"] = MADE
    assert studio.delete("/api/projects/p1/scenes/0/narration").status_code == 200
    assert studio.db.store["projects/p1/scenes/0"]["narration"] is None


# --- the stitch ---------------------------------------------------------------------------------------

def test_the_stitch_puts_the_narration_on_its_scene_and_times_captions_on_it(stitch, fake_db, monkeypatch):
    put = []
    monkeypatch.setattr(jobs, "voiced_scene", lambda video, voices, out, keep_own_sound=False: put.append((voices, keep_own_sound)) or out)
    monkeypatch.setattr(jobs, "probe_media", lambda path: {"duration": 8.0, "has_audio": True})
    keys = []
    monkeypatch.setattr(jobs, "caption_word_times", lambda ref, data, attempt, text, path, work, sid: keys.append((sid, attempt, path)) or [("w", 0.0, 0.5)])
    fake_db.collection("projects").document("p1").collection("scenes").document("0").update({"narration": MADE})
    project, seen = stitch({"voice": {"id": "v1", "name": "Ana"}, "narration": {"0": {"at": 1.0, "trimEnd": 0.5}}})

    assert project["status"] == "completed"
    assert put == [([{"path": put[0][0][0]["path"], "at": 1.0, "start": 0.0, "end": 3.5}], False)]   # it fits: nothing carries on
    assert seen["stitched"]["paths"][0].endswith("narrated_0.mp4")
    assert seen["revoiced"] == [("1", "v1")]                           # the narrated scene is not re-voiced
    assert keys[0][1].startswith("narration:") and keys[0][2].endswith("narrated_0.mp4")
    assert keys[1][1] == 1                                             # the other scene: its take
    assert list(project["finalVideos"].values[-1]["narration"]) == ["0"]


def test_a_narration_switched_off_leaves_the_scene_as_it_is(stitch, fake_db, monkeypatch):
    monkeypatch.setattr(jobs, "voiced_scene", lambda *a, **k: pytest.fail("the narration is off"))
    fake_db.collection("projects").document("p1").collection("scenes").document("0").update({"narration": MADE})
    project, seen = stitch({"narration": {"0": {"on": False}}})
    assert not seen["stitched"]["paths"][0].endswith("narrated_0.mp4")
    assert project["finalVideos"].values[-1]["narration"] == {}


def test_a_narration_longer_than_its_scene_carries_on_over_the_next_one(stitch, fake_db, monkeypatch):
    put = []
    monkeypatch.setattr(jobs, "voiced_scene", lambda video, voices, out, keep_own_sound=False: put.append((video, voices, keep_own_sound)) or out)
    monkeypatch.setattr(jobs, "probe_media", lambda path: {"duration": 3.0, "has_audio": True})
    fake_db.collection("projects").document("p1").collection("scenes").document("0").update({"narration": MADE})   # 4s long
    project, seen = stitch({"voice": {"id": "v1", "name": "Ana"}, "edits": {"1": {"attempt": 1, "start": 0.5}}})

    (first_video, first_voices, first_keep), (second_video, second_voices, second_keep) = put
    assert [(v["at"], v["start"], v["end"]) for v in first_voices] == [(0.0, 0.0, 4.0)] and first_keep is False
    # Scene 2 is re-voiced first, then gets the last second, from where its kept part starts, over its own sound.
    assert second_video == "revoiced_1.mp4" and second_keep is True
    assert [(v["at"], v["start"], v["end"]) for v in second_voices] == [(0.5, 3.0, 4.0)]
    assert seen["stitched"]["paths"][1].endswith("tail_1.mp4")


def test_two_narrated_scenes_in_a_row_share_the_second_ones_sound(stitch, fake_db, monkeypatch):
    put = []
    monkeypatch.setattr(jobs, "voiced_scene", lambda video, voices, out, keep_own_sound=False: put.append((voices, keep_own_sound)) or out)
    monkeypatch.setattr(jobs, "probe_media", lambda path: {"duration": 3.0, "has_audio": True})
    scenes = fake_db.collection("projects").document("p1").collection("scenes")
    scenes.document("0").update({"narration": MADE})
    scenes.document("1").update({"narration": {**MADE, "storageRef": f"{BASE}scenes/1/narration_b.mp3", "seconds": 2.0}})
    stitch({})
    assert len(put) == 2 and [len(voices) for voices, _ in put] == [1, 2]             # its own voice, and the end of scene 1's
    assert put[1][1] is False


def test_the_last_scene_has_nowhere_to_carry_on(stitch, fake_db, monkeypatch):
    put = []
    monkeypatch.setattr(jobs, "voiced_scene", lambda video, voices, out, keep_own_sound=False: put.append(voices) or out)
    monkeypatch.setattr(jobs, "probe_media", lambda path: {"duration": 3.0, "has_audio": True})
    fake_db.collection("projects").document("p1").collection("scenes").document("1").update({"narration": MADE})
    stitch({})
    assert len(put) == 1 and len(put[0]) == 1


def test_a_narrated_scene_and_the_one_after_it_are_not_tightened_around_their_words(stitch, fake_db, monkeypatch):
    monkeypatch.setattr(jobs, "voiced_scene", lambda video, voices, out, keep_own_sound=False: out)
    monkeypatch.setattr(jobs, "probe_media", lambda path: {"duration": 8.0, "has_audio": True})
    fake_db.collection("projects").document("p1").collection("scenes").document("0").update({"narration": MADE})
    project, seen = stitch({"narration": {"0": {"at": 2.0}}, "edits": {"1": {"attempt": 1, "start": 0.5, "volume": 0.8}}})
    assert seen["stitched"]["edits"] == [
        {"start": 0.0, "end": 8.0},                                   # the pause before the voice stays
        {"start": 0.5, "end": 8.0, "attempt": 1, "volume": 0.8},      # a trim made in the editor still applies
    ]
    assert project["finalVideos"].values[-1]["edits"] == {"1": {"attempt": 1, "start": 0.5, "volume": 0.8}}   # recorded as set


def test_scenes_without_a_narration_nearby_are_cut_as_before(stitch):
    project, seen = stitch({})
    assert seen["stitched"]["edits"] == [None, None]


def test_the_last_scene_voice_carries_on_over_the_end_card(stitch, fake_db, monkeypatch):
    monkeypatch.setattr(jobs, "voiced_scene", lambda video, voices, out, keep_own_sound=False: out)
    monkeypatch.setattr(jobs, "probe_media", lambda path: {"duration": 3.0, "has_audio": True})
    fake_db.collection("projects").document("p1").collection("scenes").document("1").update({"narration": MADE})   # 4s on a 3s scene
    card = {"enabled": True, "imageRef": "users/u1/projects/p1/end_card_1.png", "seconds": 3}
    project, seen = stitch({"endCard": card})
    voice = seen["stitched"]["end_card"]["voice"]
    assert (voice["start"], voice["end"]) == (3.0, 4.0) and voice["path"].endswith("narration_1.mp3")

    project, seen = stitch({"endCard": {**card, "enabled": False}})
    assert seen["stitched"]["end_card"] is None                        # no card: nowhere to carry on
