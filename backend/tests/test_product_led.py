"""The product-led video type: the product on screen, a narrator who is never seen, no presenter."""
from app import jobs, pipeline
from app.pipeline import PRODUCT_LED_SCENE_RULE, asset_bible_prompt, product_led_script_rules, video_type_of
from app.routes import scenes as scenes_route
from app.routes.scenes import project_picture_specs

PHOTO = "users/u1/projects/p1/starting_image.jpg"
WATCH = "users/u1/projects/p1/context/watch.jpg"
PRODUCT = {"settings": {"videoType": "product"}, "startingImageRef": PHOTO, "globalImages": [{"description": "no file"}, {"storageRef": WATCH}]}
CREATOR = {"settings": {}, "startingImageRef": PHOTO, "globalImages": [{"storageRef": WATCH}]}


def test_a_video_is_a_creator_video_unless_it_says_product():
    assert video_type_of("product") == "product"
    for other in (None, "", "creator", "something"):
        assert video_type_of(other) == "creator"
    assert jobs.is_product_led(PRODUCT) and not jobs.is_product_led(CREATOR) and not jobs.is_product_led(None)


def test_the_script_writer_is_told_to_show_the_product_and_no_face():
    rules = product_led_script_rules("product")
    assert "No face appears in any scene" in rules
    assert "narration spoken over the pictures by one off-screen voice" in rules
    assert product_led_script_rules("creator") == "" and product_led_script_rules(None) == ""


def test_the_script_prompt_carries_those_rules_only_for_a_product_led_video(monkeypatch):
    prompts = []

    class Models:
        def generate_content(self, model, contents, config):
            prompts.append(contents if isinstance(contents, str) else contents[-1])

            class Response:
                text = '{"video_context": "A dark surface.", "scenes": [{"description": "d", "script": "s", "context": "c", "prompt": "p"}]}'
            return Response()

    class Client:
        models = Models()

    monkeypatch.setattr(pipeline, "get_client", lambda: Client())
    pipeline.generate_script_and_scenes(idea="Ad for a watch", num_scenes=1, video_type="product")
    pipeline.generate_script_and_scenes(idea="Ad for a watch", num_scenes=1)
    assert "PRODUCT-LED" in prompts[0] and "PRODUCT-LED" not in prompts[1]


def test_the_details_describe_hands_and_a_narrator_not_a_presenter():
    prompt = asset_bible_prompt("Ad for a watch", video_type="product")
    assert "describe only the hands and forearms" in prompt and "describe the narrator" in prompt
    assert "product-led" not in asset_bible_prompt("Ad for a watch")


def test_the_presenter_photo_is_not_looked_at_for_a_product_led_video():
    assert [s["storageRef"] for s in project_picture_specs("u1", PRODUCT)] == [WATCH]
    assert [s["role"] for s in project_picture_specs("u1", CREATOR)] == ["speaker", "reference"]


def test_the_first_scene_starts_from_the_product_picture():
    assert jobs.start_picture_ref(PRODUCT) == WATCH
    assert jobs.start_picture_ref(CREATOR) == PHOTO
    assert jobs.start_picture_ref({"settings": {"videoType": "product"}, "startingImageRef": PHOTO}) == ""
    assert "product picture" in jobs.missing_start_picture_message(PRODUCT)
    assert "creator photo" in jobs.missing_start_picture_message(CREATOR)


def test_no_face_reference_is_sent_and_no_face_is_checked():
    assert jobs.creator_reference_spec(PRODUCT, "last_frame", used=0, limit=6, uid="u1") is None
    assert jobs.creator_reference_spec(CREATOR, "last_frame", used=0, limit=6, uid="u1") is not None
    assert jobs.creator_photo_for_check(PRODUCT, "u1", "/tmp") is None


def test_every_scene_prompt_of_a_product_led_video_says_no_face_and_no_lips():
    assert "No face is ever on screen" in PRODUCT_LED_SCENE_RULE
    assert "nobody in the picture speaks" in PRODUCT_LED_SCENE_RULE


def test_the_endpoints_pass_the_video_type_on(api, monkeypatch):
    seen = {}
    monkeypatch.setattr(scenes_route, "extract_asset_bible",
                        lambda idea, llm_model, pictures=None, product_name=None, video_type=None: seen.update(type=video_type) or {})
    assert api.post("/api/extract-assets", json={"idea": "Ad", "video_type": "product"}).status_code == 200
    assert seen["type"] == "product"


def test_a_take_without_a_product_picture_is_refused_with_the_right_words(api):
    api.db.collection("projects").document("p1").set({"userId": "u1", "settings": {"videoType": "product"}, "startingImageRef": PHOTO})
    api.db.collection("projects").document("p1").collection("scenes").document("0").set({"index": 0, "prompt": "Show the watch."})
    response = api.post("/api/projects/p1/scenes/0/generate", data={"image_source": "creator"})
    assert response.status_code == 400
    assert "No product picture found" in response.json()["detail"]
