"""The parts of the pipeline that need no ffmpeg run and no model call (app/pipeline.py)."""
import pytest

from app import pipeline


# ── Tightened cuts ──

def test_trim_cuts_dead_air_but_keeps_a_breath():
    start, end = pipeline.plan_trim(8.0, [(0.9, 7.0)], tight=True)
    assert start == pytest.approx(0.9 - pipeline.LEAD_KEEP_SECONDS)
    assert end == pytest.approx(7.0 + pipeline.TAIL_KEEP_SECONDS)


def test_trim_never_cuts_more_than_the_limits():
    start, end = pipeline.plan_trim(8.0, [(3.0, 4.0)], tight=True)
    assert start == pipeline.MAX_TRIM_START_SECONDS
    assert end == 8.0 - pipeline.MAX_TRIM_END_SECONDS


@pytest.mark.parametrize("duration,speech,tight", [
    (8.0, [(0.9, 6.0)], False),   # tightening is off
    (8.0, [], True),              # nothing heard
    (0.8, [(0.3, 0.5)], True),    # too short to cut
    (8.0, [(0.1, 7.9)], True),    # speech fills the clip
])
def test_trim_keeps_the_whole_clip_when_there_is_nothing_to_cut(duration, speech, tight):
    assert pipeline.plan_trim(duration, speech, tight) == (0.0, duration)


# ── Speech check ──

def test_speech_match_ignores_case_and_punctuation():
    assert pipeline.speech_match("Okay, I HAVE to show you this!", "okay i have to show you this") == 1.0


def test_speech_match_drops_when_words_are_missing():
    assert pipeline.speech_match("one two three four five six", "one two three") < pipeline.SPEECH_MATCH_THRESHOLD


# ── Prompts ──

def test_generation_prompt_numbers_pictures_without_an_end_frame():
    text = pipeline.build_omni_generation_prompt("Say hi.", ["The bottle", ""], pipeline.SCENE_AUDIO_VOICE_ONLY)
    assert pipeline.SINGLE_SHOT_INSTRUCTION in text
    assert "Picture 1 is the first frame" in text
    assert "last frame" not in text
    assert "- Picture 2: The bottle" in text
    assert "- Picture 3: Additional visual reference" in text
    assert "No background music" in text
    assert "<FIRST_FRAME>" not in text and "IMAGE_REF" not in text  # deprecated control tags


def test_generation_prompt_shifts_references_after_the_end_frame():
    text = pipeline.build_omni_generation_prompt("Say hi.", ["The bottle"], pipeline.SCENE_AUDIO_MODEL, has_end_frame=True)
    assert "Picture 2 is the last frame" in text
    assert "- Picture 3: The bottle" in text
    assert "No background music" not in text


def test_extend_prompt_asks_for_the_same_shot():
    text = pipeline.build_omni_extend_prompt("She presses the pump.")
    assert text.startswith(pipeline.EXTEND_INSTRUCTION)
    assert "She presses the pump." in text
    assert "No scene cuts" in text


def test_asset_bible_lines_skip_empty_fields_and_keep_order():
    lines = pipeline.asset_bible_lines({"voice": "Warm", "character": " Ana ", "setting": "", "other": "x"})
    assert lines == ["Speaker: Ana", "Voice: Warm"]
    assert pipeline.asset_bible_lines(None) == []


def test_json_response_with_a_code_fence():
    assert pipeline._parse_json_response('```json\n{"a": 1}\n```') == {"a": 1}
    assert pipeline._parse_json_response(' {"a": 1} ') == {"a": 1}


# ── Stitching ──

def clip(duration=5.0, has_audio=True, **extra):
    return {"duration": duration, "has_audio": has_audio, "gain_db": 0.0, **extra}


def test_audio_filter_keeps_every_cut_in_sync():
    graph, total = pipeline.build_stitch_audio_filter([clip(5.0, trim_start=0.5), clip(3.0, has_audio=False)])
    assert total == 8.0
    assert "atrim=0.500:5.500" in graph          # the first clip's audio follows its trimmed picture
    assert "anullsrc" in graph                   # a silent scene gets silence of the same length
    assert "concat=n=2:v=0:a=1[voice]" in graph
    assert graph.endswith("[voice]atrim=0:8.000[aout]")
    assert "sidechaincompress" not in graph and "anoisesrc" not in graph


def test_audio_filter_with_music_ducks_it_and_starts_it_on_the_beat():
    graph, total = pipeline.build_stitch_audio_filter(
        [clip(5.0), clip(5.0)], music_input_index=2, music_volume="low", music_start=0.23, music_tempo=1.012,
    )
    assert "[2:a]" in graph
    assert "atempo=1.0120,atrim=0.230:10.230" in graph
    assert f"volume={pipeline.MUSIC_VOLUMES['low']}" in graph
    assert "sidechaincompress" in graph
    assert graph.endswith("[mix]atrim=0:10.000[aout]")


def test_audio_filter_leaves_the_tempo_alone_by_default():
    graph, _ = pipeline.build_stitch_audio_filter([clip()], music_input_index=1)
    assert "atempo" not in graph
    assert "atrim=0.000:5.000" in graph


def test_audio_filter_room_tone_goes_under_everything():
    graph, _ = pipeline.build_stitch_audio_filter([clip()], music_input_index=1, room_tone=True)
    assert "anoisesrc" in graph
    assert graph.endswith("[bed]atrim=0:5.000[aout]")


def test_clips_of_different_sizes_are_refused_with_the_scene_names():
    clips = [{"width": 720, "height": 1280, "video_codec": "h264"}, {"width": 1080, "height": 1920, "video_codec": "h264"}]
    with pytest.raises(ValueError) as error:
        pipeline.check_clips_match(clips, ["Scene 1", "Scene 2"])
    assert "Scene 1 (720x1280)" in str(error.value) and "Scene 2 (1080x1920)" in str(error.value)
    pipeline.check_clips_match(clips[:1] * 2)  # same size: fine
    pipeline.check_clips_match([clips[0], {}])  # unknown size: not judged


def test_frame_rate_parsing():
    assert pipeline._frame_rate("24000/1001") == pytest.approx(23.976, abs=0.001)
    assert pipeline._frame_rate("30") == 30.0
    assert pipeline._frame_rate("0/0") is None
    assert pipeline._frame_rate("1000/1") is None
    assert pipeline._frame_rate(None) is None


def test_gain_is_limited_and_zero_for_unknown_loudness():
    assert pipeline._gain_to(-16.0, {"input_i": "-20.0"}) == 4.0
    assert pipeline._gain_to(-16.0, {"input_i": "-70.0"}) == pipeline.MAX_GAIN_DB
    assert pipeline._gain_to(-16.0, None) == 0.0


def test_image_type_comes_from_the_file_header(tmp_path):
    png = tmp_path / "picture.jpg"  # wrong extension on purpose
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 8)
    assert pipeline.detect_image_mime(str(png)) == "image/png"
    assert pipeline.detect_image_mime(str(tmp_path / "missing.webp")) == "image/webp"
    assert pipeline.detect_image_mime(str(tmp_path / "missing")) == "image/jpeg"


@pytest.mark.parametrize("saved", ['abc123', '"abc123"', "'abc123'", '  abc123\n', ' "abc123" '])
def test_the_model_key_works_when_saved_with_quote_marks_or_spaces(saved, monkeypatch):
    """A key pasted into the server's settings with quote marks used to be refused by the model."""
    from app import pipeline

    seen = {}
    monkeypatch.setenv("API_PROVIDER", "AI_STUDIO")
    monkeypatch.setenv("GEMINI_API_KEY", saved)
    monkeypatch.setattr(pipeline.genai, "Client", lambda **kwargs: seen.update(kwargs) or "client")
    assert pipeline.get_client() == "client"
    assert seen["api_key"] == "abc123"


def test_a_missing_model_key_is_reported(monkeypatch):
    from app import pipeline

    monkeypatch.setenv("API_PROVIDER", "AI_STUDIO")
    monkeypatch.setenv("GEMINI_API_KEY", '""')
    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        pipeline.get_client()


def test_a_line_added_after_the_script_is_found_even_when_most_words_match():
    script = "Meet the Carré Royale, a dress watch with zero apologies. They said dress watches must be Swiss, must be thin, must cost a month’s rent."
    spoken = script + " We broke all three."
    assert pipeline.speech_match(script, spoken) >= pipeline.SPEECH_MATCH_THRESHOLD
    assert pipeline.extra_spoken_words(script, spoken) == "we broke all three"


def test_rewording_and_small_slips_are_not_an_added_line():
    assert pipeline.extra_spoken_words("Only $299 today.", "Only two hundred ninety nine dollars today.") == ""
    assert pipeline.extra_spoken_words("Tell them good eye.", "Tell them, uh, good eye.") == "uh"
    assert pipeline.extra_spoken_words("Hello there.", "Hello there.") == ""
    assert pipeline.extra_spoken_words("", "Anything at all here.") == ""


def test_the_take_check_flags_a_take_that_adds_a_line(tmp_path, monkeypatch):
    video = tmp_path / "take.mp4"; video.write_bytes(b"video")
    said = {"text": ""}

    class Models:
        def generate_content(self, model, contents, config):
            class Response:
                text = '{"spoken_text": "%s", "issues": []}' % said["text"]
            return Response()

    class Client:
        models = Models()

    monkeypatch.setattr(pipeline, "get_client", lambda: Client())
    monkeypatch.setattr(pipeline, "upload_to_files_api", lambda client, path, mime, timeout_seconds=0: "video-file")
    script = "They said dress watches must be Swiss, must be thin, must cost a month's rent."

    said["text"] = script + " We broke all three."
    result = pipeline.check_take(str(video), script=script)
    assert result["ok"] is False
    assert result["issues"][0] == {"kind": "script", "detail": 'Says words that are not in the script: "we broke all three".'}

    said["text"] = script
    assert pipeline.check_take(str(video), script=script)["ok"] is True


def test_generation_prompt_without_a_first_frame_numbers_the_references_from_one():
    text = pipeline.build_omni_generation_prompt("A hand picks up the watch.", ["The watch"], has_first_frame=False)
    assert "is the first frame of the video." not in text
    assert pipeline.NO_FIRST_FRAME_INSTRUCTION in text and "real-life size" in pipeline.NO_FIRST_FRAME_INSTRUCTION
    assert "The pictures are references" in text and "- Picture 1: The watch" in text

    with_end = pipeline.build_omni_generation_prompt("A hand picks up the watch.", ["The watch"], has_end_frame=True, has_first_frame=False)
    assert "Picture 1 is the last frame" in with_end and "- Picture 2: The watch" in with_end


def test_a_take_without_a_first_frame_sends_only_the_reference_pictures(tmp_path, monkeypatch):
    start = tmp_path / "start.jpg"; start.write_bytes(b"start")
    ref = tmp_path / "ref.jpg"; ref.write_bytes(b"ref")
    sent = {}

    class Meta:
        def __init__(self, path):
            self.uri, self.mime_type = f"files/{path.rsplit('/', 1)[-1]}", "image/jpeg"

    class Video:
        uri = "files/out.mp4"

    class Interaction:
        id, output_video = "int-1", Video()

    class Files:
        def download(self, file):
            return b"video"

    class Client:
        files = Files()

    monkeypatch.setattr(pipeline, "get_client", lambda: Client())
    monkeypatch.setattr(pipeline, "upload_to_files_api", lambda client, path, *a, **k: Meta(path))
    monkeypatch.setattr(pipeline, "_run_video_interaction", lambda client, request, *a: sent.update(request) or Interaction())
    refs = [{"path": str(ref), "description": "The watch"}]

    pipeline.generate_scene_video("A hand picks it up.", None, str(tmp_path / "out.mp4"), reference_images=refs)
    assert [p["uri"] for p in sent["input"] if p["type"] == "image"] == ["files/ref.jpg"]
    assert "- Picture 1: The watch" in sent["input"][-1]["text"]

    pipeline.generate_scene_video("A hand picks it up.", str(start), str(tmp_path / "out.mp4"), reference_images=refs)
    assert [p["uri"] for p in sent["input"] if p["type"] == "image"] == ["files/start.jpg", "files/ref.jpg"]
    assert "Picture 1 is the first frame" in sent["input"][-1]["text"]
