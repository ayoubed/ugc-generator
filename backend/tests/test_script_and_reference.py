"""Script writing and the reference-video breakdown, with the model replaced by a fake."""
import json
from types import SimpleNamespace

from app import pipeline


class FakeClient:
    """Stands in for the Gemini client: records what it was asked and answers with fixed JSON."""

    def __init__(self, answer):
        self.answer = answer
        self.requests = []
        self.models = SimpleNamespace(generate_content=self._generate)
        self.files = SimpleNamespace(upload=lambda file, config: SimpleNamespace(state=None, name="files/1"))

    def _generate(self, model, contents, config):
        self.requests.append({"model": model, "contents": contents})
        return SimpleNamespace(text=json.dumps(self.answer))

    def prompt(self):
        contents = self.requests[-1]["contents"]
        return contents if isinstance(contents, str) else contents[-1]


SCRIPT_ANSWER = {"video_context": " A kitchen. ", "scenes": [{"description": "d", "script": "s", "context": "c", "prompt": "p"}]}


def test_script_prompt_carries_the_user_choices(monkeypatch):
    client = FakeClient(SCRIPT_ANSWER)
    monkeypatch.setattr(pipeline, "get_client", lambda: client)
    result = pipeline.generate_script_and_scenes(
        idea="A mug that keeps coffee hot", num_scenes=4, camera_specifics=["Phone front camera"],
        hook_style="Custom Hook", custom_hook_desc="Start mid-sentence", target_words_per_scene=17,
        context_image_descriptions=["The mug", " "], asset_bible={"hero_props": "One steel mug"},
    )
    prompt = client.prompt()
    assert result == {"video_context": "A kitchen.", "scenes": SCRIPT_ANSWER["scenes"]}
    assert "exactly 4 scenes" in prompt
    assert "approximately 17 words" in prompt
    assert "Start mid-sentence" in prompt
    assert "- Camera: Phone front camera" in prompt
    assert "- Lighting" not in prompt          # nothing is invented for an empty guideline
    assert "- The mug" in prompt
    assert "Products and props: One steel mug" in prompt
    assert "STRUCTURE TO FOLLOW" not in prompt


def test_script_follows_a_reference_structure_part_for_part(monkeypatch):
    client = FakeClient(SCRIPT_ANSWER)
    monkeypatch.setattr(pipeline, "get_client", lambda: client)
    structure = {
        "scenes": [
            {"purpose": "Calls out the pain point", "happens": "She sighs at her desk", "framing": "Selfie close-up"},
            {"purpose": "", "happens": ""},                      # empty parts are dropped
            {"purpose": "Asks to buy", "happens": "", "framing": ""},
        ],
        "pacing": "Fast cuts",
        "call_to_action": "Tells viewers to look it up",
    }
    pipeline.generate_script_and_scenes(idea="A mug", num_scenes=7, structure=structure)
    prompt = client.prompt()
    assert "exactly 2 scenes" in prompt          # the structure sets the number of scenes
    assert "Scene 1. Job: Calls out the pain point | In the reference: She sighs at her desk | Filmed as: Selfie close-up" in prompt
    assert "Scene 2. Job: Asks to buy" in prompt
    assert "Rhythm: Fast cuts" in prompt
    assert "Never reuse or paraphrase" in prompt


def test_structure_is_capped_at_ten_scenes(monkeypatch):
    client = FakeClient(SCRIPT_ANSWER)
    monkeypatch.setattr(pipeline, "get_client", lambda: client)
    pipeline.generate_script_and_scenes(idea="A mug", structure={"scenes": [{"purpose": f"Part {n}"} for n in range(14)]})
    assert "exactly 10 scenes" in client.prompt()


BREAKDOWN_ANSWER = {
    "summary": "A testimonial.",
    "hook_type": "The Question",
    "hook": "Open with a question.",
    "scenes": [
        {"start": 0.0, "end": 4.0, "purpose": "Hook", "said": "Are you tired of cold coffee?", "happens": "She frowns.", "framing": "Close-up"},
        {"start": 4.0, "end": 9.0, "purpose": "Demo", "said": "", "happens": "She pours coffee.", "framing": ""},
    ] + [{"start": 9.0 + n, "end": 10.0 + n, "purpose": "Extra", "said": "", "happens": "More.", "framing": ""} for n in range(12)],
    "pacing": "Quick.",
    "caption_style": "No captions",
    "music_mood": "",
    "call_to_action": "Asks to buy.",
    "style": {"camera": ["a", " ", "b", "c", "d"], "lighting": [], "action": [], "script_tone": [], "visual": [], "audio": []},
}


def test_reference_breakdown_is_cleaned_and_measured(monkeypatch, tmp_path):
    client = FakeClient(BREAKDOWN_ANSWER)
    monkeypatch.setattr(pipeline, "get_client", lambda: client)
    monkeypatch.setattr(pipeline, "probe_media", lambda path: {"duration": 21.04})
    video = tmp_path / "ad.mp4"
    video.write_bytes(b"0")

    data = pipeline.analyse_reference_video(str(video))

    assert len(data["scenes"]) == pipeline.REFERENCE_MAX_PARTS
    assert data["style"]["camera"] == ["a", "b", "c"]            # blanks dropped, three at most
    assert data["seconds"] == 21.0
    assert data["wordsPerSecond"] == 1.5                         # 6 words over the 4 spoken seconds
    assert client.requests[-1]["model"] == pipeline.REFERENCE_MODEL_ID


def test_reference_breakdown_without_speech_or_duration(monkeypatch, tmp_path):
    answer = {**BREAKDOWN_ANSWER, "scenes": [{"start": 0, "end": 6, "purpose": "Demo", "said": "", "happens": "Pour.", "framing": ""}]}
    monkeypatch.setattr(pipeline, "get_client", lambda: FakeClient(answer))

    def unreadable(path):
        raise RuntimeError("not a video")

    monkeypatch.setattr(pipeline, "probe_media", unreadable)
    video = tmp_path / "ad.mp4"
    video.write_bytes(b"0")
    data = pipeline.analyse_reference_video(str(video))
    assert data["seconds"] == 6.0                                # falls back to the last part's end
    assert data["wordsPerSecond"] == 0.0
