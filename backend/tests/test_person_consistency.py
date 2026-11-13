"""
Keeping the same person and product through a video.

Two things went wrong in a real project: the consistent details were written from the idea alone
(they described a blonde woman while the photo showed a woman in a headscarf), and scenes that
start from the scene before never received the creator photo, so the model drew the described
person as soon as a face came back into frame.
"""
import pytest

from app import jobs, pipeline
from app.jobs import CREATOR_REFERENCE_TEXT, creator_reference_spec
from app.pipeline import asset_bible_prompt, extract_asset_bible
from app.routes import scenes as scenes_route
from app.routes.scenes import project_picture_specs

PHOTO = "users/u1/projects/p1/starting_image.jpg"
WATCH = "users/u1/projects/p1/context/watch.jpg"


# --- the details are written from the pictures ------------------------------------------------

def test_the_prompt_says_the_pictures_win_over_the_idea():
    prompt = asset_bible_prompt("Ad for a watch", [
        {"role": "speaker", "description": ""},
        {"role": "reference", "description": "silver watch with green dial"},
    ])
    assert "Picture 1: the person who speaks in the video." in prompt
    assert "Picture 2: silver watch with green dial" in prompt
    assert "the picture wins" in prompt
    assert "head covering" in prompt


def test_without_pictures_the_prompt_does_not_mention_any():
    prompt = asset_bible_prompt("Ad for a watch")
    assert "Picture" not in prompt and "attached" not in prompt
    assert 'Video idea: "Ad for a watch"' in prompt


def test_the_pictures_are_sent_to_the_model_before_the_instruction(tmp_path, monkeypatch):
    photo = tmp_path / "person.jpg"
    photo.write_bytes(b"\xff\xd8\xff photo")
    sent = {}

    class Models:
        def generate_content(self, model, contents, config):
            sent["contents"] = contents

            class Response:
                text = '{"character": "A woman in a brown headscarf.", "hero_props": "", "setting": "", "voice": ""}'
            return Response()

    class Client:
        models = Models()

    monkeypatch.setattr(pipeline, "get_client", lambda: Client())
    result = extract_asset_bible("Ad for a watch", "some-model", pictures=[
        {"path": str(photo), "role": "speaker", "description": ""},
        {"path": str(tmp_path / "missing.jpg"), "role": "reference", "description": "gone"},
    ])
    assert result["character"] == "A woman in a brown headscarf."
    assert len(sent["contents"]) == 2                       # the photo, then the text; the missing file is left out
    assert sent["contents"][0].inline_data.mime_type == "image/jpeg"
    assert "Picture 1: the person who speaks" in sent["contents"][1]
    assert "Picture 2" not in sent["contents"][1]


def test_project_pictures_are_the_photo_first_then_the_video_wide_pictures():
    specs = project_picture_specs("u1", {
        "startingImageRef": PHOTO,
        "globalImages": [{"storageRef": WATCH, "description": " silver watch "}, {"description": "no file"}, "junk"],
    })
    assert [(s["role"], s["storageRef"], s["description"]) for s in specs] == [
        ("speaker", PHOTO, ""),
        ("reference", WATCH, "silver watch"),
    ]


def test_pictures_outside_the_users_own_files_are_never_read():
    specs = project_picture_specs("u1", {
        "startingImageRef": "users/someone-else/projects/x/starting_image.jpg",
        "globalImages": [{"storageRef": "users/u1/../u2/secret.jpg"}],
    })
    assert specs == []


def test_the_endpoint_writes_the_details_from_the_projects_pictures(api, monkeypatch):
    api.db.collection("projects").document("p1").set({
        "userId": "u1", "startingImageRef": PHOTO, "globalImages": [{"storageRef": WATCH, "description": "silver watch"}],
    })
    downloaded, seen = [], {}
    monkeypatch.setattr(scenes_route, "download_file", lambda ref, path: downloaded.append(ref))

    def fake_extract(idea, llm_model, pictures=None, product_name=None, video_type=None):
        seen["pictures"] = pictures
        return {"character": "As in the photo.", "hero_props": "", "setting": "", "voice": ""}

    monkeypatch.setattr(scenes_route, "extract_asset_bible", fake_extract)
    response = api.post("/api/extract-assets", json={"idea": "Ad for a watch", "project_id": "p1"})
    assert response.status_code == 200
    assert response.json()["asset_bible"]["character"] == "As in the photo."
    assert downloaded == [PHOTO, WATCH]
    assert [(p["role"], p["description"]) for p in seen["pictures"]] == [("speaker", ""), ("reference", "silver watch")]


def test_a_picture_that_cannot_be_loaded_is_left_out(api, monkeypatch):
    api.db.collection("projects").document("p1").set({"userId": "u1", "startingImageRef": PHOTO})

    def broken(ref, path):
        raise RuntimeError("storage is down")

    seen = {}
    monkeypatch.setattr(scenes_route, "download_file", broken)
    monkeypatch.setattr(scenes_route, "extract_asset_bible",
                        lambda idea, llm_model, pictures=None, product_name=None, video_type=None: seen.update(pictures=pictures, name=product_name) or {})
    assert api.post("/api/extract-assets", json={"idea": "Ad", "project_id": "p1"}).status_code == 200
    assert seen["pictures"] == []


def test_the_endpoint_refuses_someone_elses_project(api, monkeypatch):
    api.db.collection("projects").document("p2").set({"userId": "someone-else", "startingImageRef": PHOTO})
    monkeypatch.setattr(scenes_route, "extract_asset_bible", lambda *a, **k: pytest.fail("must not be called"))
    assert api.post("/api/extract-assets", json={"idea": "Ad", "project_id": "p2"}).status_code == 403
    assert api.post("/api/extract-assets", json={"idea": "Ad", "project_id": "nope"}).status_code == 404


def test_without_a_project_the_details_come_from_the_idea(api, monkeypatch):
    seen = {}
    monkeypatch.setattr(scenes_route, "extract_asset_bible",
                        lambda idea, llm_model, pictures=None, product_name=None, video_type=None: seen.update(pictures=pictures, name=product_name) or {})
    assert api.post("/api/extract-assets", json={"idea": "Ad", "product_name": "Luma"}).status_code == 200
    assert seen["pictures"] == []
    assert seen["name"] == "Luma"


# --- the product's name is the user's, never invented ---------------------------------------

def test_a_given_product_name_must_be_used_as_written():
    rule = pipeline.product_name_rule("  Luma   One ")
    assert 'PRODUCT NAME: "Luma One"' in rule
    assert "Never invent another product or brand name" in rule


def test_without_a_name_none_may_be_invented():
    for missing in (None, "", "   "):
        rule = pipeline.product_name_rule(missing)
        assert "not given" in rule and "Do not invent a product or brand name" in rule


def test_the_details_prompt_carries_the_name_rule_and_a_steady_tone():
    assert 'PRODUCT NAME: "Luma"' in asset_bible_prompt("Ad for a watch", product_name="Luma")
    plain = asset_bible_prompt("Ad for a watch")
    assert "PRODUCT NAME: not given" in plain
    assert "one steady mood that holds from the first" in plain


def test_the_script_writer_gets_the_name_rule(monkeypatch):
    prompts = []

    class Models:
        def generate_content(self, model, contents, config):
            prompts.append(contents if isinstance(contents, str) else contents[-1])

            class Response:
                text = '{"video_context": "A room.", "scenes": [{"description": "d", "script": "s", "context": "c", "prompt": "p"}]}'
            return Response()

    class Client:
        models = Models()

    monkeypatch.setattr(pipeline, "get_client", lambda: Client())
    pipeline.generate_script_and_scenes(idea="Ad for a watch", num_scenes=1, product_name="Luma")
    pipeline.generate_script_and_scenes(idea="Ad for a watch", num_scenes=1)
    assert 'PRODUCT NAME: "Luma"' in prompts[0]
    assert "PRODUCT NAME: not given" in prompts[1]


# --- the creator photo goes along when a scene starts from the scene before -------------------

@pytest.mark.parametrize("source", ["last_frame", "ai_cut", "extend"])
def test_a_scene_that_starts_from_the_previous_one_gets_the_creator_photo(source):
    spec = creator_reference_spec({"startingImageRef": PHOTO}, source, used=1, limit=6, uid="u1")
    assert spec == {"scope": "creator", "storageRef": PHOTO, "url": None, "description": CREATOR_REFERENCE_TEXT}
    assert "head covering" in CREATOR_REFERENCE_TEXT


@pytest.mark.parametrize("source", ["creator", "uploaded"])
def test_a_scene_with_its_own_starting_picture_does_not(source):
    assert creator_reference_spec({"startingImageRef": PHOTO}, source, used=0, limit=6, uid="u1") is None


def test_no_photo_or_no_room_means_no_extra_picture():
    assert creator_reference_spec({}, "last_frame", used=0, limit=6, uid="u1") is None
    assert creator_reference_spec({"startingImageRef": PHOTO}, "last_frame", used=6, limit=6, uid="u1") is None


def test_a_creator_photo_outside_the_users_files_is_refused():
    with pytest.raises(ValueError, match="outside your storage area"):
        creator_reference_spec({"startingImageRef": "users/u2/x.jpg"}, "last_frame", used=0, limit=6, uid="u1")


def test_a_missing_creator_photo_is_reported_in_plain_words(tmp_path, monkeypatch):
    def broken(ref, path):
        raise RuntimeError("404")

    monkeypatch.setattr(jobs, "download_file", broken)
    spec = creator_reference_spec({"startingImageRef": PHOTO}, "last_frame", used=0, limit=6, uid="u1")
    with pytest.raises(ValueError, match="Upload it again on the Idea step"):
        jobs.download_reference_images([spec], str(tmp_path), 6)


# --- the automatic check compares the face with the creator photo -----------------------------

def test_the_take_check_gets_the_creator_photo_and_a_rule_for_it(tmp_path, monkeypatch):
    video = tmp_path / "take.mp4"; video.write_bytes(b"video")
    photo = tmp_path / "person.jpg"; photo.write_bytes(b"\xff\xd8\xff photo")
    sent = {}

    class Models:
        def generate_content(self, model, contents, config):
            sent["contents"] = contents

            class Response:
                text = '{"spoken_text": "Hi there.", "issues": [{"kind": "speaker", "detail": "The woman in the second half is not the woman in the photo."}]}'
            return Response()

    class Client:
        models = Models()

    monkeypatch.setattr(pipeline, "get_client", lambda: Client())
    monkeypatch.setattr(pipeline, "upload_to_files_api", lambda client, path, mime, timeout_seconds=0: "video-file")
    result = pipeline.check_take(str(video), script="Hi there.", person_photo_path=str(photo))
    assert sent["contents"][0] == "video-file"
    assert sent["contents"][1].inline_data.mime_type == "image/jpeg"
    assert "The attached photo shows the real speaker" in sent["contents"][2]
    assert "only partly in frame" in sent["contents"][2]
    assert result["ok"] is False and result["issues"][0]["kind"] == "speaker"

    pipeline.check_take(str(video), script="Hi there.")                                  # no photo: as before
    assert len(sent["contents"]) == 2 and "attached photo" not in sent["contents"][1]
    pipeline.check_take(str(video), script="Hi there.", person_photo_path=str(tmp_path / "gone.jpg"))
    assert len(sent["contents"]) == 2


def test_the_creator_photo_is_loaded_for_the_check_only_from_the_users_own_files(tmp_path, monkeypatch):
    loaded = []
    monkeypatch.setattr(jobs, "download_file", lambda ref, path: loaded.append(ref))
    assert jobs.creator_photo_for_check({"startingImageRef": PHOTO}, "u1", str(tmp_path)).endswith("creator_for_check.jpg")
    assert jobs.creator_photo_for_check({"startingImageRef": "users/u2/x.jpg"}, "u1", str(tmp_path)) is None
    assert jobs.creator_photo_for_check({}, "u1", str(tmp_path)) is None
    assert loaded == [PHOTO]


def test_a_photo_that_cannot_be_loaded_does_not_stop_the_check(tmp_path, monkeypatch):
    def broken(ref, path):
        raise RuntimeError("storage is down")

    monkeypatch.setattr(jobs, "download_file", broken)
    assert jobs.creator_photo_for_check({"startingImageRef": PHOTO}, "u1", str(tmp_path)) is None


def test_the_creator_reference_covers_a_face_that_comes_back_into_view():
    assert "only part" in CREATOR_REFERENCE_TEXT and "Never a different person" in CREATOR_REFERENCE_TEXT
