"""The end card: a plain picture after the last scene, which can be changed with a prompt."""
import shutil

import cv2
import numpy as np
import pytest

from app import pipeline, prompts
from app.routes import end_card

BASE = "users/u1/projects/p1/"


# --- the clip -------------------------------------------------------------------------------------

def test_the_card_is_the_picture_alone_nothing_over_or_behind_it():
    for text in (pipeline.end_card_filter(1080, 1920, 1080, 1920), pipeline.end_card_filter(1080, 1920, 1000, 1000)):
        assert "boxblur" not in text and "subtitles" not in text and "overlay" not in text


def test_a_picture_shaped_like_the_video_fills_the_frame_and_any_other_is_shown_whole():
    assert "crop=1080:1920" in pipeline.end_card_filter(1080, 1920, 768, 1376)      # what the image model returns for 9:16
    assert "crop=1080:1920" in pipeline.end_card_filter(1080, 1920, 1080, 1920)
    whole = pipeline.end_card_filter(1080, 1920, 2000, 2000)                        # a square packshot
    assert "pad=1080:1920" in whole and "crop" not in whole
    assert "pad=1080:1920" in pipeline.end_card_filter(1080, 1920)                  # size unknown


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
def test_the_clip_is_made_at_the_videos_size_and_length(tmp_path):
    picture = str(tmp_path / "card.png")
    cv2.imwrite(picture, np.full((500, 500, 3), 200, dtype=np.uint8))
    out = pipeline.make_end_card(picture, str(tmp_path / "card.mp4"), 360, 640, 30.0, seconds=9)
    info = pipeline.probe_media(out)
    assert (info["width"], info["height"]) == (360, 640) and not info["has_audio"]
    assert abs(info["duration"] - pipeline.END_CARD_MAX_SECONDS) < 0.2              # the length is capped


def test_the_stitch_takes_no_text_for_the_card():
    import inspect
    assert "headline" not in inspect.signature(pipeline.make_end_card).parameters


# --- changing the picture with a prompt -------------------------------------------------------------

def test_the_edit_prompt_carries_the_change_and_numbers_the_product_pictures_from_two():
    text = pipeline.build_end_card_edit_prompt("  put it on   dark marble ", [{"description": "The watch"}])
    assert "The change: put it on dark marble" in text and "- Picture 2: The watch" in text
    assert "(none)" in pipeline.build_end_card_edit_prompt("x y", [])
    assert prompts.blanks("end_card.edit") == ["instruction", "pictures"]


def test_the_picture_goes_first_then_the_product_pictures(monkeypatch, tmp_path):
    sent = {}
    monkeypatch.setattr(pipeline, "_image_part", lambda path: f"<{path}>")
    monkeypatch.setattr(pipeline, "_draw_still", lambda contents, out, ratio, what, model=None: sent.update(contents=contents, ratio=ratio, model=model) or out)
    card, product = tmp_path / "card.png", tmp_path / "watch.png"
    card.write_bytes(b"x"), product.write_bytes(b"y")
    pipeline.edit_end_card_picture(str(card), "out.png", "darker", "16:9", [{"path": str(product), "description": "The watch"}], "gemini-3.1-flash-image")
    assert sent["contents"][:2] == [f"<{card}>", f"<{product}>"]
    assert sent["ratio"] == "16:9" and sent["model"] == "gemini-3.1-flash-image"


@pytest.fixture
def card_api(api, monkeypatch):
    api.db.store["projects/p1"] = {
        "userId": "u1",
        "settings": {"aspectRatio": "9:16", "imageModel": "gemini-3.1-flash-image",
                     "endCard": {"enabled": True, "imageRef": f"{BASE}end_card_1.png", "imageUrl": "https://x/1", "seconds": 3}},
        "globalImages": [{"storageRef": f"{BASE}watch.png", "description": "The watch"}],
    }
    api.edits, api.uploads = [], []

    def fake_edit(image_path, output_path, instruction, aspect_ratio="9:16", reference_images=None, image_model=None):
        api.edits.append({"instruction": instruction, "ratio": aspect_ratio, "pictures": reference_images, "model": image_model})
        with open(output_path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
        return output_path

    monkeypatch.setattr(end_card, "edit_end_card_picture", fake_edit)
    monkeypatch.setattr(end_card, "download_file", lambda ref, local: open(local, "wb").write(b"p") and local)
    monkeypatch.setattr(end_card, "upload_file", lambda local, path, content_type=None: api.uploads.append(path))
    monkeypatch.setattr(end_card, "get_download_url", lambda path: f"https://files/{path}")
    return api


def test_a_prompt_changes_the_card_and_keeps_the_picture_it_replaced(card_api):
    response = card_api.post("/api/projects/p1/end-card/edit", json={"instruction": "  on dark   marble "})
    assert response.status_code == 200, response.text
    made = response.json()
    assert made["imageRef"].startswith(f"{BASE}end_card_") and made["imageRef"] == card_api.uploads[0]
    assert card_api.edits[0]["instruction"] == "on dark marble" and card_api.edits[0]["ratio"] == "9:16"
    assert card_api.edits[0]["model"] == "gemini-3.1-flash-image"
    assert [p["description"] for p in card_api.edits[0]["pictures"]] == ["The watch"]
    card = card_api.db.store["projects/p1"]["settings"]["endCard"]
    assert card["imageRef"] == made["imageRef"] and card["imageUrl"] == made["imageUrl"]
    assert card["previous"] == {"imageRef": f"{BASE}end_card_1.png", "imageUrl": "https://x/1"}
    assert card["enabled"] is True and card["seconds"] == 3                          # the rest is untouched


def test_changing_needs_a_picture_an_instruction_and_the_owner(card_api):
    assert card_api.post("/api/projects/p1/end-card/edit", json={"instruction": ""}).status_code == 422
    assert card_api.post("/api/projects/nope/end-card/edit", json={"instruction": "darker"}).status_code == 404
    card_api.db.store["projects/p1"]["settings"]["endCard"] = {}
    assert card_api.post("/api/projects/p1/end-card/edit", json={"instruction": "darker"}).status_code == 400
    card_api.db.store["projects/p1"]["userId"] = "someone-else"
    assert card_api.post("/api/projects/p1/end-card/edit", json={"instruction": "darker"}).status_code == 403


def test_a_failed_change_leaves_the_card_as_it_was(card_api, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("The image model returned no picture for the end card.")
    monkeypatch.setattr(end_card, "edit_end_card_picture", broken)
    response = card_api.post("/api/projects/p1/end-card/edit", json={"instruction": "darker"})
    assert response.status_code == 502 and "no picture" in response.json()["detail"]
    assert card_api.db.store["projects/p1"]["settings"]["endCard"]["imageRef"] == f"{BASE}end_card_1.png"
