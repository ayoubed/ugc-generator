"""The storyboard: frames made before any video, and how an accepted frame becomes a scene's start."""
import pytest

from app import pipeline, prompts, storyboard
from app.routes import storyboard as routes

BASE = "users/u1/projects/p1/"


def frame(fid, order=0, accepted=False, look=False, ref=None):
    return {"id": fid, "order": order, "accepted": accepted, "look": look,
            "imageRef": ref or f"{BASE}scenes/0/storyboard/{fid}_v1.png", "imageUrl": f"https://x/{fid}", "version": 1}


# --- the prompts ----------------------------------------------------------------------------------

def test_a_frame_prompt_names_the_moment_the_size_rule_and_each_picture():
    text = pipeline.build_storyboard_frame_prompt(
        "A wrist  wearing the watch", [{"description": "The watch"}, {"description": ""}],
        ["Products and props: steel watch"], product_led=True,
    )
    assert "What the frame shows: A wrist wearing the watch" in text
    assert "true real-life size" in text
    assert prompts.text("storyboard.frame.product_led") in text
    assert "- Picture 1: The watch" in text and "- Picture 2: Additional visual reference." in text
    assert "- Products and props: steel watch" in text
    assert "last try" not in text


def test_a_presenter_video_keeps_the_person_and_a_second_try_is_told_what_was_wrong():
    text = pipeline.build_storyboard_frame_prompt("She holds it", [], None, product_led=False, feedback=["The watch is too big."])
    assert prompts.text("storyboard.frame.creator") in text
    assert text.endswith("- The watch is too big.")
    assert "(none given)" in text and "(none)" in text


def test_an_edit_prompt_keeps_the_frame_and_numbers_the_other_pictures_from_two():
    text = pipeline.build_storyboard_edit_prompt("make the watch  smaller", [{"description": "The watch"}])
    assert "The change: make the watch smaller" in text
    assert "- Picture 2: The watch" in text


def test_drawing_sends_the_frame_first_when_changing_it(monkeypatch, tmp_path):
    sent = {}
    monkeypatch.setattr(pipeline, "_image_part", lambda path: f"<{path}>")
    monkeypatch.setattr(pipeline, "_draw_still", lambda contents, out, ratio, what, model=None: sent.update(contents=contents, ratio=ratio, model=model) or out)
    base, ref = tmp_path / "base.png", tmp_path / "ref.png"
    base.write_bytes(b"x"), ref.write_bytes(b"y")
    pictures = [{"path": str(ref), "description": "The watch"}, {"path": str(tmp_path / "missing.png")}]

    pipeline.generate_storyboard_frame("out.png", "A wrist", "9:16", pictures, base_image_path=str(base), instruction="smaller")
    assert sent["contents"][:2] == [f"<{base}>", f"<{ref}>"] and len(sent["contents"]) == 3
    assert "The change: smaller" in sent["contents"][-1]

    pipeline.generate_storyboard_frame("out.png", "A wrist", "1:1", pictures, base_image_path=str(base))   # no instruction: a new picture
    assert sent["contents"][0] == f"<{ref}>" and sent["ratio"] == "1:1"
    assert "What the frame shows: A wrist" in sent["contents"][-1]
    assert sent["model"] is None

    pipeline.generate_storyboard_frame("out.png", "A wrist", "9:16", pictures, image_model="gemini-3.1-flash-image")
    assert sent["model"] == "gemini-3.1-flash-image"


def test_nano_banana_pro_is_the_default_and_an_unknown_choice_falls_back_to_it():
    from app import model_registry
    payload = model_registry.models_payload()
    assert payload["default_image_model"] == "gemini-3-pro-image"
    assert [m["label"] for m in payload["image_models"]] == ["Nano Banana Pro", "Nano Banana 2"]
    assert model_registry.get_image_model(None)["id"] == "gemini-3-pro-image"
    assert model_registry.get_image_model("retired-model")["id"] == "gemini-3-pro-image"
    assert model_registry.get_image_model("gemini-3.1-flash-image")["label"] == "Nano Banana 2"


def test_a_picture_is_asked_of_the_chosen_model(monkeypatch, tmp_path):
    asked = []

    class Models:
        def generate_content(self, model, contents, config):
            asked.append(model)
            from types import SimpleNamespace as NS
            part = NS(inline_data=NS(data=b"png"))
            return NS(candidates=[NS(content=NS(parts=[part]))])

    monkeypatch.setattr(pipeline, "get_client", lambda: type("C", (), {"models": Models()})())
    out = str(tmp_path / "a.png")
    pipeline._draw_still(["x"], out, "9:16", "this frame")
    pipeline._draw_still(["x"], out, "9:16", "this frame", "gemini-3.1-flash-image")
    pipeline._draw_still(["x"], out, "9:16", "this frame", "no-such-model")
    assert asked == ["gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-3-pro-image"]
    assert open(out, "rb").read() == b"png"


# --- which frame a scene starts on ---------------------------------------------------------------

def test_frames_come_back_in_order_and_the_first_accepted_one_is_the_start():
    scene = {"storyboard": {"frames": {"b": frame("b", 1, accepted=True), "a": frame("a", 0), "junk": "x"}}}
    frames = storyboard.frames_in_order(scene)
    assert [f["id"] for f in frames] == ["a", "b"]
    assert storyboard.start_frame(frames)["id"] == "b"
    assert storyboard.frames_in_order({}) == [] and storyboard.start_frame([]) is None


def test_the_first_frame_is_described_by_the_scene_itself():
    assert storyboard.default_moment({"description": "A hand lifts the watch.", "context": "Close-up."}) == "A hand lifts the watch. Close-up."
    assert storyboard.default_moment({"script": "Look at this."}) == "Look at this."


def test_accepting_a_frame_makes_it_the_start_and_taking_it_back_restores_the_scene():
    scene = {"imageSource": "last_frame", "customStartImageRef": None}
    accepted = frame("a", accepted=True)
    update = storyboard.scene_update_for(scene, [accepted])
    assert update["customStartImageRef"] == accepted["imageRef"] and update["imageSource"] == "uploaded"
    assert update["storyboard"]["start"]["previous"]["imageSource"] == "last_frame"

    linked = {**scene, **update}
    back = storyboard.scene_update_for(linked, [{**accepted, "accepted": False}])
    assert back["imageSource"] == "last_frame" and back["customStartImageRef"] is None
    assert back["storyboard"]["start"] is None


def test_what_the_scene_started_from_is_remembered_across_several_accepted_frames():
    scene = {"imageSource": "creator"}
    first = storyboard.scene_update_for(scene, [frame("a", accepted=True)])
    second = storyboard.scene_update_for({**scene, **first}, [frame("b", accepted=True), frame("a", accepted=True)])
    assert second["storyboard"]["start"]["frameId"] == "b"
    assert second["storyboard"]["start"]["previous"]["imageSource"] == "creator"   # not "uploaded"
    assert [f["order"] for f in second["storyboard"]["frames"].values()] == [0, 1]


def test_a_custom_picture_chosen_afterwards_is_not_overwritten():
    scene = {"imageSource": "creator"}
    linked = {**scene, **storyboard.scene_update_for(scene, [frame("a", accepted=True)])}
    linked["customStartImageRef"] = f"{BASE}scenes/0/custom_start.png"     # the user picked another picture
    back = storyboard.scene_update_for(linked, [])
    assert "customStartImageRef" not in back and "imageSource" not in back


def test_a_scene_with_no_frames_and_no_link_is_left_alone():
    assert set(storyboard.scene_update_for({"imageSource": "creator"}, [])) == {"storyboard"}


# --- the pictures a frame is drawn from ----------------------------------------------------------

def test_look_frames_are_the_accepted_ones_marked_as_the_look_at_most_two():
    scenes = [
        ("0", {"storyboard": {"frames": {"a": frame("a", accepted=True, look=True)}}}),
        ("1", {"storyboard": {"frames": {"b": frame("b", accepted=False, look=True), "c": frame("c", 1, accepted=True, look=True)}}}),
        ("2", {"storyboard": {"frames": {"d": frame("d", accepted=True, look=True)}}}),
    ]
    assert [f["id"] for f in storyboard.look_frames(scenes)] == ["a", "c"]
    assert [f["id"] for f in storyboard.look_frames(scenes, skip_frame_id="a")] == ["c", "d"]
    assert storyboard.has_look_frame(scenes) and not storyboard.has_look_frame([])


def test_a_frame_is_drawn_from_product_pictures_the_creator_photo_and_the_look():
    project = {"startingImageRef": f"{BASE}creator.png", "globalImages": [{"storageRef": f"{BASE}watch.png", "description": "The watch"}]}
    scenes = [("0", {"storyboard": {"frames": {"a": frame("a", accepted=True, look=True)}}})]
    specs = storyboard.frame_picture_specs(project, {}, scenes, "u1")
    assert [s["kind"] for s in specs] == ["product", "creator", "look"]

    led = {**project, "settings": {"videoType": "product"}}
    assert [s["kind"] for s in storyboard.frame_picture_specs(led, {}, scenes, "u1")] == ["product", "look"]   # no presenter

    with pytest.raises(Exception):
        storyboard.frame_picture_specs({"globalImages": [{"storageRef": "users/other/x.png"}]}, {}, [], "u1")


def test_with_too_many_pictures_the_last_product_pictures_are_dropped_first():
    project = {"startingImageRef": f"{BASE}creator.png",
               "globalImages": [{"storageRef": f"{BASE}p{i}.png"} for i in range(10)]}
    specs = storyboard.frame_picture_specs(project, {}, [], "u1")
    assert len(specs) == storyboard.MAX_FRAME_PICTURES
    assert specs[-1]["kind"] == "creator" and specs[0]["storageRef"].endswith("p0.png")


# --- drawing a frame, with the check -------------------------------------------------------------

@pytest.fixture
def studio(monkeypatch):
    """The image model, the check and Storage replaced; `studio.draws` and `studio.uploads` record calls."""
    class Studio:
        draws, uploads, checks = [], [], []
        results = []          # what each check answers, in order; [] once used up

    s = Studio()
    s.draws, s.uploads, s.checks, s.results = [], [], [], []

    def fake_draw(path, moment, **kwargs):
        s.draws.append({"moment": moment, **kwargs})
        with open(path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + bytes([len(s.draws)]))
        return path

    def fake_check(path, moment, product_paths=None, asset_lines=None, product_led=False):
        s.checks.append({"path": path, "products": product_paths, "product_led": product_led})
        result = s.results.pop(0) if s.results else []
        if isinstance(result, Exception):
            raise result
        return result

    def fake_download(ref, local):
        with open(local, "wb") as f:
            f.write(b"picture")
        return local

    monkeypatch.setattr(storyboard, "generate_storyboard_frame", fake_draw)
    monkeypatch.setattr(storyboard, "check_storyboard_frame", fake_check)
    monkeypatch.setattr(storyboard, "download_file", fake_download)
    monkeypatch.setattr(storyboard, "upload_file", lambda local, path, content_type=None: s.uploads.append((path, open(local, "rb").read()[-1])))
    monkeypatch.setattr(storyboard, "get_download_url", lambda path: f"https://files/{path}")
    return s


PROJECT = {"userId": "u1", "settings": {"videoType": "product", "aspectRatio": "9:16", "assetBible": {"hero_props": "Steel watch"}},
           "globalImages": [{"storageRef": f"{BASE}watch.png", "description": "The watch"}]}
SCENE = {"description": "A wrist turns to show the watch.", "imageSource": "creator"}


def test_a_good_frame_is_drawn_once_and_used_by_default(studio):
    made = storyboard.draw_frame("u1", "p1", "0", {"id": "f1", "version": 0}, PROJECT, SCENE, [])
    assert len(studio.draws) == 1 and studio.draws[0]["product_led"] is True
    assert studio.draws[0]["moment"] == "A wrist turns to show the watch."
    assert studio.draws[0]["asset_lines"] == ["Products and props: Steel watch"]
    assert len(studio.checks[0]["products"]) == 1
    assert made["imageRef"] == f"{BASE}scenes/0/storyboard/f1_v1.png" and studio.uploads[0][0] == made["imageRef"]
    assert made["accepted"] is True and made["issues"] == [] and made["checked"] is True and made["version"] == 1
    assert studio.draws[0]["image_model"] is None and made["imageModel"] == "gemini-3-pro-image"


def test_a_frame_is_drawn_with_the_model_the_project_chose(studio):
    project = {**PROJECT, "settings": {**PROJECT["settings"], "imageModel": "gemini-3.1-flash-image"}}
    made = storyboard.draw_frame("u1", "p1", "0", {"id": "f1"}, project, SCENE, [])
    assert studio.draws[0]["image_model"] == "gemini-3.1-flash-image" and made["imageModel"] == "gemini-3.1-flash-image"


def test_a_flagged_frame_is_drawn_once_more_with_what_was_wrong(studio):
    studio.results = [[{"kind": "scale", "detail": "The watch is wider than the wrist."}], []]
    made = storyboard.draw_frame("u1", "p1", "0", {"id": "f1"}, PROJECT, SCENE, [])
    assert len(studio.draws) == 2 and studio.draws[1]["feedback"] == ["The watch is wider than the wrist."]
    assert made["issues"] == [] and studio.uploads[0][1] == 2          # the second picture is kept


def test_the_first_picture_is_kept_when_the_second_is_worse(studio):
    one = [{"kind": "scale", "detail": "Too big."}]
    studio.results = [one, one + [{"kind": "hands_or_face", "detail": "Six fingers."}]]
    made = storyboard.draw_frame("u1", "p1", "0", {"id": "f1"}, PROJECT, SCENE, [])
    assert made["issues"] == one and studio.uploads[0][1] == 1


def test_a_check_that_cannot_run_does_not_stop_the_frame(studio):
    studio.results = [RuntimeError("down")]
    made = storyboard.draw_frame("u1", "p1", "0", {"id": "f1"}, PROJECT, SCENE, [])
    assert len(studio.draws) == 1 and made["checked"] is False and made["issues"] == []


def test_an_instruction_changes_the_picture_the_frame_has(studio):
    current = {"id": "f1", "version": 2, "imageRef": f"{BASE}scenes/0/storyboard/f1_v2.png", "accepted": True, "look": True,
               "description": "A wrist."}
    made = storyboard.draw_frame("u1", "p1", "0", current, PROJECT, SCENE, [], instruction="  watch   smaller ")
    assert studio.draws[0]["instruction"] == "watch smaller" and studio.draws[0]["base_image_path"]
    assert made["version"] == 3 and made["imageRef"].endswith("f1_v3.png")
    assert made["accepted"] is True and made["look"] is True            # it stays in use, as it was


def test_a_frame_the_user_switched_off_stays_off_when_drawn_again(studio):
    made = storyboard.draw_frame("u1", "p1", "0", {"id": "f1", "version": 1, "accepted": False}, PROJECT, SCENE, [])
    assert made["accepted"] is False


def test_the_first_picture_in_use_sets_the_look_and_later_ones_do_not():
    used, off = frame("a", accepted=True), frame("b", accepted=False, look=True)
    assert storyboard.with_default_look(used, [])["look"] is True
    assert storyboard.with_default_look(off, [])["look"] is False                # not in use: never the look
    other = [("1", {"storyboard": {"frames": {"z": frame("z", accepted=True, look=True)}}})]
    assert storyboard.with_default_look(used, other)["look"] is False
    own = [("0", {"storyboard": {"frames": {"a": frame("a", accepted=True, look=True)}}})]
    assert storyboard.with_default_look(used, own)["look"] is True               # itself does not count as "another"


# --- the API ---------------------------------------------------------------------------------------

@pytest.fixture
def board(api, studio, monkeypatch):
    api.db.store["projects/p1"] = dict(PROJECT)
    api.db.store["projects/p1/scenes/0"] = dict(SCENE)
    api.db.store["projects/p1/scenes/1"] = {"description": "The watch on a desk.", "imageSource": "last_frame"}
    api.studio = studio
    api.scene = lambda n=0: api.db.store[f"projects/p1/scenes/{n}"]
    return api


def add(board, n=0, **body):
    response = board.post(f"/api/projects/p1/scenes/{n}/storyboard/frames", json=body)
    assert response.status_code == 200, response.text
    return list(response.json()["storyboard"]["frames"].values())[-1]


def test_a_drawn_frame_is_the_scene_start_right_away_and_sets_the_look(board):
    made = add(board)
    assert made["description"] == SCENE["description"] and made["order"] == 0
    assert made["accepted"] is True and made["look"] is True
    scene = board.scene()
    assert scene["customStartImageRef"] == made["imageRef"] and scene["imageSource"] == "uploaded"

    second = add(board, n=1)                               # drawn to match the first, and not the look itself
    assert [p["kind"] for p in board.studio.draws[-1]["reference_images"]] == ["product", "look"]
    assert second["accepted"] is True and second["look"] is False
    assert board.scene(1)["customStartImageRef"] == second["imageRef"]


def test_switching_a_frame_off_and_on_again_moves_the_scene_start_with_it(board):
    made = add(board)
    url = f"/api/projects/p1/scenes/0/storyboard/frames/{made['id']}"
    assert board.patch(url, json={"accepted": False}).status_code == 200
    assert board.scene()["imageSource"] == "creator" and board.scene()["customStartImageRef"] is None
    assert board.patch(url, json={"accepted": True}).status_code == 200
    scene = board.scene()
    assert scene["customStartImageRef"] == made["imageRef"] and scene["imageSource"] == "uploaded"
    assert scene["storyboard"]["frames"][made["id"]]["look"] is True


def test_taking_the_acceptance_back_restores_how_the_scene_started(board):
    made = add(board)
    url = f"/api/projects/p1/scenes/0/storyboard/frames/{made['id']}"
    board.patch(url, json={"accepted": True})
    board.patch(url, json={"accepted": False})
    scene = board.scene()
    assert scene["imageSource"] == "creator" and scene["customStartImageRef"] is None
    assert scene["storyboard"]["frames"][made["id"]]["look"] is False


def test_a_remade_frame_stays_in_use_with_its_new_picture(board):
    made = add(board)
    url = f"/api/projects/p1/scenes/0/storyboard/frames/{made['id']}"
    board.patch(url, json={"accepted": True})
    response = board.post(url + "/remake", json={"instruction": "smaller watch", "description": "On the left wrist."})
    assert response.status_code == 200
    remade = response.json()["storyboard"]["frames"][made["id"]]
    assert remade["version"] == 2 and remade["accepted"] is True and remade["description"] == "On the left wrist."
    assert board.studio.draws[-1]["instruction"] == "smaller watch"
    assert board.scene()["customStartImageRef"] == remade["imageRef"] != made["imageRef"]

    board.patch(url, json={"accepted": False})
    again = board.post(url + "/remake", json={}).json()["storyboard"]["frames"][made["id"]]
    assert again["accepted"] is False and board.scene()["imageSource"] == "creator"     # switched off stays off


def test_removing_the_start_frame_restores_the_scene_and_a_missing_frame_is_a_404(board):
    made = add(board)
    url = f"/api/projects/p1/scenes/0/storyboard/frames/{made['id']}"
    board.patch(url, json={"accepted": True})
    assert board.delete(url).status_code == 200
    assert board.scene()["storyboard"]["frames"] == {} and board.scene()["imageSource"] == "creator"
    assert board.delete(url).status_code == 404
    assert board.patch(url, json={"accepted": True}).status_code == 404


def test_an_uploaded_picture_is_a_frame_as_it_is(board):
    made = add(board, storage_ref=f"{BASE}scenes/0/storyboard/upload_1.png")
    assert made["source"] == "upload" and board.studio.draws == []
    outside = board.post("/api/projects/p1/scenes/0/storyboard/frames", json={"storage_ref": "users/u1/projects/other/x.png"})
    assert outside.status_code == 403


def test_frames_can_be_put_in_another_order_and_the_start_follows(board):
    first, second = add(board), add(board, description="A close-up of the dial.")
    for made in (first, second):
        board.patch(f"/api/projects/p1/scenes/0/storyboard/frames/{made['id']}", json={"accepted": True})
    assert board.scene()["customStartImageRef"] == first["imageRef"]
    response = board.put("/api/projects/p1/scenes/0/storyboard/order", json={"ids": [second["id"], first["id"]]})
    assert response.status_code == 200 and board.scene()["customStartImageRef"] == second["imageRef"]
    assert board.put("/api/projects/p1/scenes/0/storyboard/order", json={"ids": [first["id"]]}).status_code == 400


def test_the_limits_and_the_owner_are_checked(board, monkeypatch):
    monkeypatch.setattr(storyboard, "MAX_FRAMES_PER_SCENE", 1)
    add(board)
    assert board.post("/api/projects/p1/scenes/0/storyboard/frames", json={}).status_code == 400
    board.db.store["projects/p1"]["userId"] = "someone-else"
    assert board.post("/api/projects/p1/scenes/1/storyboard/frames", json={}).status_code == 403
    assert board.post("/api/projects/nope/scenes/0/storyboard/frames", json={}).status_code == 404


def test_a_failed_drawing_is_said_in_plain_words_and_saves_nothing(board, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("The image model returned no picture for this frame.")
    monkeypatch.setattr(storyboard, "generate_storyboard_frame", broken)
    response = board.post("/api/projects/p1/scenes/0/storyboard/frames", json={})
    assert response.status_code == 502 and "no picture" in response.json()["detail"]
    assert "storyboard" not in board.scene()


def test_only_a_frame_in_use_can_be_the_look(board):
    made = add(board)
    url = f"/api/projects/p1/scenes/0/storyboard/frames/{made['id']}"
    board.patch(url, json={"accepted": False})
    assert board.patch(url, json={"look": True}).status_code == 400
    board.patch(url, json={"accepted": True, "look": False})
    assert board.scene()["storyboard"]["frames"][made["id"]]["look"] is False
    assert routes.router is not None


# --- the picture a scene ends on -----------------------------------------------------------------

def end(fid, order=1, accepted=True):
    return {**frame(fid, order, accepted=accepted), "role": "end"}


def test_an_end_frame_is_never_the_start_and_a_start_frame_never_the_end():
    frames = [end("e", 0), frame("s", 1, accepted=True)]
    assert storyboard.start_frame(frames)["id"] == "s" and storyboard.end_frame(frames)["id"] == "e"
    assert storyboard.end_frame([frame("s", accepted=True), end("e", accepted=False)]) is None
    assert storyboard.role_of({}) == "start" and storyboard.role_of({"role": "end"}) == "end"


def test_an_end_frame_becomes_the_scene_end_picture_and_gives_it_back():
    scene = {"imageSource": "creator", "endImageRef": f"{BASE}scenes/0/end_old.png", "endImageUrl": "https://x/old"}
    made = end("e")
    update = storyboard.scene_update_for(scene, [made])
    assert update["endImageRef"] == made["imageRef"] and "customStartImageRef" not in update
    assert update["storyboard"]["end"]["previous"]["endImageRef"].endswith("end_old.png")

    back = storyboard.scene_update_for({**scene, **update}, [{**made, "accepted": False}])
    assert back["endImageRef"].endswith("end_old.png") and back["endImageUrl"] == "https://x/old"
    assert back["storyboard"]["end"] is None

    changed = {**scene, **update, "endImageRef": f"{BASE}scenes/0/end_new.png"}       # the user uploaded another one since
    assert "endImageRef" not in storyboard.scene_update_for(changed, [])


def test_an_end_frame_is_drawn_from_the_scene_start_and_described_as_the_last_moment():
    scene = {"description": "A hand fastens the watch.", "storyboard": {"frames": {"s": frame("s", accepted=True, look=True)}}}
    specs = storyboard.frame_picture_specs(PROJECT, scene, [("0", scene)], "u1", role="end")
    assert [s["kind"] for s in specs] == ["product", "start"]                        # its own start is sent once
    assert specs[-1]["description"] == storyboard.START_FRAME_TEXT
    assert storyboard.default_moment(scene, "end").startswith("The last moment of this scene")
    assert "a video scene ends on" in pipeline.build_storyboard_frame_prompt("x", [], ends_scene=True)
    assert "a video scene starts on" in pipeline.build_storyboard_frame_prompt("x", [])


def test_an_end_frame_never_sets_the_look():
    assert storyboard.with_default_look(end("e"), [])["look"] is False
    scenes = [("0", {"storyboard": {"frames": {"e": {**end("e"), "look": True}}}})]
    assert storyboard.look_frames(scenes) == []


def test_the_api_draws_an_end_picture_next_to_the_start(board):
    start = add(board)
    made = add(board, role="end")
    assert made["role"] == "end" and made["accepted"] is True and made["look"] is False
    assert board.studio.draws[-1]["ends_scene"] is True
    assert board.studio.draws[-1]["moment"].startswith("The last moment of this scene")
    assert [p["kind"] for p in board.studio.draws[-1]["reference_images"]] == ["product", "start"]
    scene = board.scene()
    assert scene["customStartImageRef"] == start["imageRef"] and scene["endImageRef"] == made["imageRef"]

    url = f"/api/projects/p1/scenes/0/storyboard/frames/{made['id']}"
    assert board.patch(url, json={"look": True}).status_code == 400
    assert board.delete(url).status_code == 200
    assert board.scene()["endImageRef"] is None and board.scene()["customStartImageRef"] == start["imageRef"]
    assert board.post("/api/projects/p1/scenes/0/storyboard/frames", json={"role": "middle"}).status_code == 422
