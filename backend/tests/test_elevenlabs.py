"""One voice for the whole video and exact caption timing (app/elevenlabs.py, app/voiceover.py)."""
import httpx
import pytest

from app import elevenlabs, jobs, voiceover
from app.captions import close_small_gaps, fit_words_to_clip
from app.elevenlabs import VoiceServiceError, simplify_voice, words_from_alignment
from app.voiceover import caption_word_times, project_voice, revoiced_scene, saved_alignment, voice_cache_path


@pytest.fixture(autouse=True)
def _no_real_requests(monkeypatch):
    """No test reaches ElevenLabs: a request that is not replaced by the test fails loudly."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-key")
    monkeypatch.setattr(httpx, "request", lambda *a, **k: pytest.fail("unexpected request to the voice service"))
    monkeypatch.setitem(elevenlabs._voice_cache, "voices", None)
    monkeypatch.setitem(elevenlabs._voice_cache, "at", 0.0)


def answer(status_code=200, json=None, content=b""):
    return httpx.Response(status_code, json=json) if json is not None else httpx.Response(status_code, content=content)


def record(monkeypatch, response):
    calls = []

    def fake(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        return response

    monkeypatch.setattr(httpx, "request", fake)
    return calls


# --- the client -------------------------------------------------------------------------------

@pytest.mark.parametrize("saved,expected", [("abc", True), (' "abc" ', True), ("", False), ('""', False)])
def test_it_is_only_used_when_a_key_is_set(saved, expected, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", saved)
    assert elevenlabs.is_configured() is expected
    if expected:
        assert elevenlabs.api_key() == "abc"


def test_without_a_key_nothing_is_sent(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    with pytest.raises(VoiceServiceError, match="not set up on the server"):
        elevenlabs.list_voices()


def test_a_voice_keeps_its_name_a_short_description_and_a_sample():
    voice = simplify_voice({
        "voice_id": "v1", "name": " Rachel ", "preview_url": "https://x.test/rachel.mp3",
        "labels": {"gender": "female", "age": "young", "accent": "american", "use_case": "narration"},
    })
    assert voice == {"id": "v1", "name": "Rachel", "description": "female, young, american", "previewUrl": "https://x.test/rachel.mp3"}
    assert simplify_voice({"name": "No id"}) is None


def test_voices_are_listed_by_name_and_asked_for_once(monkeypatch):
    calls = record(monkeypatch, answer(json={"voices": [
        {"voice_id": "b", "name": "Zed"}, {"voice_id": "a", "name": "amy"}, {"name": "broken"}, "junk",
    ]}))
    assert [v["name"] for v in elevenlabs.list_voices()] == ["amy", "Zed"]
    assert elevenlabs.list_voices()[0]["id"] == "a"
    assert len(calls) == 1
    assert calls[0]["url"].endswith("/v2/voices")
    assert calls[0]["headers"] == {"xi-api-key": "test-key"}


def test_changing_a_voice_sends_the_audio_and_saves_what_comes_back(tmp_path, monkeypatch):
    source = tmp_path / "scene.mp3"
    source.write_bytes(b"old voice")
    calls = record(monkeypatch, answer(content=b"new voice"))
    out = elevenlabs.change_voice(str(source), "voice-1", str(tmp_path / "out.mp3"))
    assert open(out, "rb").read() == b"new voice"
    assert calls[0]["url"].endswith("/v1/voice-changer/voice-1")
    assert calls[0]["data"] == {"model_id": "eleven_multilingual_sts_v2", "remove_background_noise": "true"}
    assert "audio" in calls[0]["files"]


@pytest.mark.parametrize("code,expected", [
    (401, "rejected its key"), (402, "needs a paid ElevenLabs plan"), (429, "usage allowance"), (404, "no longer exists"), (503, "had a problem"), (422, "not accepted"),
])
def test_failures_are_reported_in_plain_words(code, expected, tmp_path, monkeypatch):
    source = tmp_path / "scene.mp3"
    source.write_bytes(b"x")
    record(monkeypatch, answer(code, json={"detail": {"status": "technical_text", "message": "stack trace"}}))
    with pytest.raises(VoiceServiceError) as error:
        elevenlabs.change_voice(str(source), "voice-1", str(tmp_path / "out.mp3"))
    assert expected in str(error.value)
    assert "technical_text" not in str(error.value)


def test_a_network_failure_is_reported_too(monkeypatch):
    def down(*a, **k):
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(httpx, "request", down)
    with pytest.raises(VoiceServiceError, match="could not reach the voice service"):
        elevenlabs.list_voices()


def test_word_times_keep_the_captions_own_words():
    data = {"words": [{"text": "hello", "start": 0.1, "end": 0.4}, {"text": "world", "start": 0.5, "end": 0.9}]}
    assert words_from_alignment(data, "Hello, world!") == [("Hello,", 0.1, 0.4), ("world!", 0.5, 0.9)]


def test_word_times_fall_back_to_the_services_words_when_the_counts_differ():
    data = {"words": [
        {"text": "34", "start": 0.0, "end": 0.3}, {"text": " ", "start": 0.3, "end": 0.3},
        {"text": "millimeter", "start": 0.3, "end": 0.9}, {"text": "bad", "start": "x", "end": 1}, "junk",
    ]}
    assert words_from_alignment(data, "34-millimeter") == [("34", 0.0, 0.3), ("millimeter", 0.3, 0.9)]


def test_aligning_sends_the_text_with_the_audio(tmp_path, monkeypatch):
    source = tmp_path / "scene.mp3"
    source.write_bytes(b"x")
    calls = record(monkeypatch, answer(json={"words": [{"text": "Hi", "start": 0.2, "end": 0.5}]}))
    assert elevenlabs.align_words(str(source), "Hi") == [("Hi", 0.2, 0.5)]
    assert calls[0]["url"].endswith("/v1/forced-alignment")
    assert calls[0]["data"] == {"text": "Hi"}


# --- caption words on a trimmed clip ------------------------------------------------------------

def test_exact_word_times_follow_the_trim():
    words = [("cut", 0.0, 0.2), ("Hello", 0.4, 0.8), ("there", 0.9, 1.6), ("gone", 2.2, 2.5)]
    assert fit_words_to_clip(words, trim_start=0.3, duration=1.2) == [("Hello", 0.1, 0.6), ("there", 0.6, 1.2)]


def test_a_word_stays_lit_until_the_next_one_unless_a_real_pause_follows():
    # Times as the service really returns them: short silences between words, "I" one millisecond long.
    measured = [("Okay,", 0.86, 1.08), ("I", 1.28, 1.281), ("have", 1.34, 1.54), ("to", 1.58, 1.68), ("Stop.", 2.4, 2.7)]
    assert close_small_gaps(measured) == [
        ("Okay,", 0.86, 1.28), ("I", 1.28, 1.34), ("have", 1.34, 1.58), ("to", 1.58, 1.68), ("Stop.", 2.4, 2.7),
    ]


def test_the_service_returns_the_spaces_between_words_and_they_are_dropped():
    data = {"words": [{"text": "Okay,", "start": 0.86, "end": 1.08, "loss": 0.5}, {"text": " ", "start": 1.08, "end": 1.24, "loss": 0.9},
                      {"text": "I", "start": 1.28, "end": 1.281, "loss": 0.6}]}
    assert words_from_alignment(data, "Okay, I") == [("Okay,", 0.86, 1.08), ("I", 1.28, 1.281)]


def test_a_word_on_the_edge_stays_visible_for_a_moment():
    assert fit_words_to_clip([("Hi", 0.29, 0.31)], trim_start=0.3, duration=1.0) == [("Hi", 0.0, 0.08)]


# --- per scene: the chosen voice ----------------------------------------------------------------

def test_the_projects_voice_is_none_unless_one_is_chosen():
    assert project_voice({"settings": {"voice": {"id": " v1 ", "name": "Rachel"}}}) == {"id": "v1", "name": "Rachel"}
    for nothing in ({}, {"settings": {}}, {"settings": {"voice": None}}, {"settings": {"voice": {"id": ""}}}, {"settings": {"voice": "v1"}}):
        assert project_voice(nothing) is None


def test_revoiced_audio_is_kept_per_take_and_voice():
    assert voice_cache_path("u1", "p1", "2", 3, "abc/../x") == "users/u1/projects/p1/scenes/2/voice_abcx_v3.mp3"
    assert voice_cache_path("u1", "p1", "2", None, "v1").endswith("voice_v1_v0.mp3")


@pytest.fixture
def media(monkeypatch):
    """ffmpeg and Storage replaced: records what was read, re-voiced, kept and put back."""
    log = {"changed": [], "uploaded": [], "muxed": [], "stored": set()}
    monkeypatch.setattr(voiceover, "probe_media", lambda path: {"has_audio": True, "duration": 5.0})
    monkeypatch.setattr(voiceover, "extract_audio", lambda video, audio: audio)

    def download(ref, path):
        if ref not in log["stored"]:
            raise FileNotFoundError(ref)

    monkeypatch.setattr(voiceover, "download_file", download)
    monkeypatch.setattr(voiceover, "upload_file", lambda path, ref, content_type=None: log["uploaded"].append(ref))
    monkeypatch.setattr(elevenlabs, "change_voice", lambda audio, voice, out: log["changed"].append(voice) or out)
    monkeypatch.setattr(voiceover, "replace_audio", lambda video, audio, out, duration: log["muxed"].append((video, duration)) or out)
    return log


def test_a_scene_is_revoiced_and_the_result_kept(media, tmp_path):
    out = revoiced_scene("u1", "p1", "2", 1, "scene.mp4", "v1", str(tmp_path))
    assert out.endswith("revoiced_2.mp4")
    assert media["changed"] == ["v1"]
    assert media["uploaded"] == ["users/u1/projects/p1/scenes/2/voice_v1_v1.mp3"]
    assert media["muxed"] == [("scene.mp4", 5.0)]


def test_stitching_again_does_not_pay_for_the_same_voice_twice(media, tmp_path):
    media["stored"].add("users/u1/projects/p1/scenes/2/voice_v1_v1.mp3")
    revoiced_scene("u1", "p1", "2", 1, "scene.mp4", "v1", str(tmp_path))
    assert media["changed"] == [] and media["uploaded"] == []
    assert len(media["muxed"]) == 1


def test_a_silent_scene_is_left_alone(media, tmp_path, monkeypatch):
    monkeypatch.setattr(voiceover, "probe_media", lambda path: {"has_audio": False, "duration": 5.0})
    assert revoiced_scene("u1", "p1", "2", 1, "scene.mp4", "v1", str(tmp_path)) == "scene.mp4"
    assert media["changed"] == []


def test_a_failed_voice_change_stops_the_stitch_with_its_reason(media, tmp_path, monkeypatch):
    def refuse(audio, voice, out):
        raise VoiceServiceError("That voice no longer exists. Pick another voice on the Video step.")

    monkeypatch.setattr(elevenlabs, "change_voice", refuse)
    with pytest.raises(VoiceServiceError, match="Pick another voice"):
        revoiced_scene("u1", "p1", "2", 1, "scene.mp4", "v1", str(tmp_path))


# --- per scene: caption timing ------------------------------------------------------------------

def test_saved_word_times_are_reused_only_for_the_same_take_and_text():
    scene = {"captionAlignment": {"attempt": 2, "text": "Hi there", "words": [{"word": "Hi", "start": 0.1, "end": 0.3}]}}
    assert saved_alignment(scene, 2, "Hi there") == [("Hi", 0.1, 0.3)]
    assert saved_alignment(scene, 3, "Hi there") is None
    assert saved_alignment(scene, 2, "Hi you") is None
    assert saved_alignment({"captionAlignment": {"attempt": 2, "text": "Hi there", "words": [{"word": "Hi"}]}}, 2, "Hi there") is None


def test_caption_words_are_timed_once_and_saved_on_the_scene(media, fake_db, tmp_path, monkeypatch):
    asked = []
    monkeypatch.setattr(elevenlabs, "align_words", lambda audio, text: asked.append(text) or [("Hi", 0.1, 0.3)])
    scene_ref = fake_db.collection("projects").document("p1").collection("scenes").document("0")
    scene_ref.set({"script": "Hi"})

    assert caption_word_times(scene_ref, {}, 1, " Hi ", "scene.mp4", str(tmp_path), "0") == [("Hi", 0.1, 0.3)]
    saved = scene_ref.get().to_dict()
    assert saved["captionAlignment"] == {"attempt": 1, "text": "Hi", "words": [{"word": "Hi", "start": 0.1, "end": 0.3}]}
    assert caption_word_times(scene_ref, saved, 1, "Hi", "scene.mp4", str(tmp_path), "0") == [("Hi", 0.1, 0.3)]
    assert asked == ["Hi"]


def test_when_timing_fails_the_captions_are_estimated_instead(media, fake_db, tmp_path, monkeypatch):
    def fail(audio, text):
        raise VoiceServiceError("busy")

    monkeypatch.setattr(elevenlabs, "align_words", fail)
    scene_ref = fake_db.collection("projects").document("p1").collection("scenes").document("0")
    assert caption_word_times(scene_ref, {}, 1, "Hi", "scene.mp4", str(tmp_path), "0") is None
    assert caption_word_times(scene_ref, {}, 1, "   ", "scene.mp4", str(tmp_path), "0") is None


# --- the stitch ---------------------------------------------------------------------------------

@pytest.fixture
def stitch(fake_db, monkeypatch):
    """Runs the stitch job with ffmpeg, Storage and ElevenLabs replaced; returns what happened."""
    project = fake_db.collection("projects").document("p1")
    project.set({"userId": "u1", "settings": {}})
    for index in range(2):
        project.collection("scenes").document(str(index)).set({
            "index": index, "script": f"Line {index}.", "activeAttempt": 1,
            "storageRef": f"users/u1/projects/p1/scenes/{index}/video_v1.mp4",
        })
    seen = {"revoiced": [], "timed": [], "stitched": None}
    monkeypatch.setattr(jobs, "download_file", lambda ref, path: path)
    monkeypatch.setattr(jobs, "upload_file", lambda path, ref, content_type=None: ref)
    monkeypatch.setattr(jobs, "get_download_url", lambda ref: f"https://files.test/{ref}")
    def fake_stitch(paths, out, **kwargs):
        seen.update(stitched={"paths": list(paths), **kwargs})
        kwargs["report"]["cuts"] = [{"start": 0.4, "end": 4.6, "length": 5.0} for _ in paths]

    monkeypatch.setattr(jobs, "stitch_videos", fake_stitch)
    monkeypatch.setattr(jobs, "revoiced_scene", lambda uid, pid, sid, attempt, path, voice, work: seen["revoiced"].append((sid, voice)) or f"revoiced_{sid}.mp4")
    monkeypatch.setattr(jobs, "caption_word_times", lambda ref, data, attempt, text, path, work, sid: seen["timed"].append(text) or [("w", 0.0, 0.5)])

    def run(settings=None):
        if settings is not None:
            project.update({"settings": settings})
        jobs._run_stitch_job_sync("u1", "p1")
        return project.get().to_dict(), seen

    return run


def test_without_the_voice_service_the_stitch_is_as_before(stitch, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    project, seen = stitch()
    assert project["status"] == "completed"
    assert seen["revoiced"] == [] and seen["timed"] == []
    assert seen["stitched"]["caption_words"] == [None, None]


def test_with_it_the_captions_are_timed_exactly_but_voices_are_kept(stitch):
    project, seen = stitch()
    assert seen["timed"] == ["Line 0.", "Line 1."]
    assert seen["revoiced"] == []
    assert seen["stitched"]["caption_words"] == [[("w", 0.0, 0.5)], [("w", 0.0, 0.5)]]
    assert project["status"] == "completed"


def test_a_chosen_voice_is_put_on_every_scene(stitch):
    project, seen = stitch({"voice": {"id": "v1", "name": "Rachel"}})
    assert seen["revoiced"] == [("0", "v1"), ("1", "v1")]
    assert seen["stitched"]["paths"] == ["revoiced_0.mp4", "revoiced_1.mp4"]
    assert project["status"] == "completed"


def test_no_captions_means_nothing_is_timed(stitch):
    _, seen = stitch({"captions": {"style": "none"}})
    assert seen["timed"] == []


def test_a_chosen_voice_without_the_service_is_explained(stitch, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    project, seen = stitch({"voice": {"id": "v1", "name": "Rachel"}})
    assert seen["stitched"] is None
    assert "voice service is not set up" in project["stitchError"]


def test_a_failed_voice_change_is_shown_as_the_stitch_error(stitch, monkeypatch):
    def refuse(*args):
        raise VoiceServiceError("That voice no longer exists. Pick another voice on the Video step.")

    monkeypatch.setattr(jobs, "revoiced_scene", refuse)
    project, seen = stitch({"voice": {"id": "v1", "name": "Rachel"}})
    assert seen["stitched"] is None
    assert project["stitchError"] == "That voice no longer exists. Pick another voice on the Video step."


# --- the list the Video step shows ---------------------------------------------------------------

def test_the_voice_list_says_when_the_service_is_not_set_up(api, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    assert api.get("/api/voices").json() == {"available": False, "voices": []}


def test_the_voice_list_returns_the_accounts_voices(api, monkeypatch):
    record(monkeypatch, answer(json={"voices": [{"voice_id": "v1", "name": "Rachel", "preview_url": "https://x.test/r.mp3"}]}))
    body = api.get("/api/voices").json()
    assert body["available"] is True
    assert body["voices"] == [{"id": "v1", "name": "Rachel", "description": "", "previewUrl": "https://x.test/r.mp3"}]


def test_the_voice_list_reports_a_rejected_key(api, monkeypatch):
    record(monkeypatch, answer(401, json={"detail": "nope"}))
    response = api.get("/api/voices")
    assert response.status_code == 502
    assert "rejected its key" in response.json()["detail"]


def test_the_version_records_what_was_kept_of_each_scene(stitch):
    project, _ = stitch()
    version = project["finalVideos"].values[-1]     # an ArrayUnion of the new version records
    assert version["cuts"] == {
        "0": {"start": 0.4, "end": 4.6, "length": 5.0, "attempt": 1},
        "1": {"start": 0.4, "end": 4.6, "length": 5.0, "attempt": 1},
    }


# --- hearing the chosen voice before the stitch ---------------------------------------------------

from app.routes import voices as voices_route   # noqa: E402


@pytest.fixture
def previewed(fake_db, monkeypatch):
    project = fake_db.collection("projects").document("p1")
    project.set({"userId": "u1", "settings": {"voice": {"id": "v1", "name": "Rachel"}}, "voicePreview": {"voiceId": "v1", "status": "building", "scenes": {}}})
    for index, extra in enumerate(({}, {"skipped": True}, {})):
        project.collection("scenes").document(str(index)).set({
            "index": index, "activeAttempt": 2, "storageRef": f"users/u1/projects/p1/scenes/{index}/v.mp4", **extra})
    made = []
    monkeypatch.setattr(voices_route, "download_file", lambda ref, path: path)
    monkeypatch.setattr(voices_route, "probe_media", lambda path: {"has_audio": True})
    monkeypatch.setattr(voices_route, "get_download_url", lambda ref: f"https://files.test/{ref}")
    monkeypatch.setattr(voices_route, "revoiced_audio",
                        lambda uid, pid, sid, attempt, path, voice, work: made.append((sid, attempt, voice)) or ("a.mp3", f"users/u1/projects/p1/scenes/{sid}/voice_{voice}_v{attempt}.mp3"))
    return project, made


def test_the_preview_revoices_every_scene_in_the_video_and_says_where_to_play_it(previewed):
    project, made = previewed
    voices_route._run_voice_preview_sync("u1", "p1", "v1")
    assert made == [("0", 2, "v1"), ("2", 2, "v1")]                     # the skipped scene is left out
    preview = project.get().to_dict()["voicePreview"]
    assert preview["status"] == "ready"
    assert preview["scenes"]["0"] == {"attempt": 2, "url": "https://files.test/users/u1/projects/p1/scenes/0/voice_v1_v2.mp3"}
    assert set(preview["scenes"]) == {"0", "2"}


def test_a_preview_for_a_voice_that_is_no_longer_chosen_does_not_claim_to_be_ready(previewed):
    project, _ = previewed
    project.update({"settings": {"voice": {"id": "v2", "name": "Adam"}}})
    voices_route._run_voice_preview_sync("u1", "p1", "v1")
    assert project.get().to_dict()["voicePreview"]["status"] == "building"


def test_a_failed_preview_says_why(previewed, monkeypatch):
    project, _ = previewed

    def refuse(*args):
        raise VoiceServiceError("That voice no longer exists. Pick another voice on the Video step.")

    monkeypatch.setattr(voices_route, "revoiced_audio", refuse)
    voices_route._run_voice_preview_sync("u1", "p1", "v1")
    preview = project.get().to_dict()["voicePreview"]
    assert (preview["status"], preview["error"]) == ("failed", "That voice no longer exists. Pick another voice on the Video step.")


def test_the_preview_starts_only_with_a_voice_chosen_and_for_the_owner(api):
    api.db.collection("projects").document("p1").set({"userId": "u1", "settings": {"voice": {"id": "v1", "name": "Rachel"}}})
    api.db.collection("projects").document("p2").set({"userId": "u1", "settings": {}})
    api.db.collection("projects").document("p3").set({"userId": "someone-else", "settings": {"voice": {"id": "v1"}}})
    assert api.post("/api/projects/p1/voice/preview").status_code == 202
    assert api.db.store["projects/p1"]["voicePreview"]["status"] == "building"
    assert api.db.store["projects/p1"]["voicePreview"]["voiceId"] == "v1"
    assert api.started == ["run_voice_preview"]
    assert api.post("/api/projects/p2/voice/preview").status_code == 400
    assert api.post("/api/projects/p3/voice/preview").status_code == 403


def test_revoiced_audio_is_made_once_and_then_reused(media, tmp_path):
    from app.voiceover import revoiced_audio
    _, ref = revoiced_audio("u1", "p1", "2", 1, "scene.mp4", "v1", str(tmp_path))
    assert ref == "users/u1/projects/p1/scenes/2/voice_v1_v1.mp3" and media["changed"] == ["v1"]
    media["stored"].add(ref)
    revoiced_audio("u1", "p1", "2", 1, "scene.mp4", "v1", str(tmp_path))
    assert media["changed"] == ["v1"]
