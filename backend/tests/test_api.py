"""The HTTP API, with Firebase replaced by an in-memory database and no model calls."""
import datetime

import pytest

from app.routes import health, projects, scenes


def project(api, **fields):
    api.db.store["projects/p1"] = {"userId": "u1", "status": "draft", "settings": {}, **fields}


def scene(api, doc_id, **fields):
    api.db.store[f"projects/p1/scenes/{doc_id}"] = {"index": int(doc_id), "videoStatus": "pending", **fields}


def now():
    return datetime.datetime.now(datetime.timezone.utc)


# ── Access ──

def test_health_needs_no_sign_in(api):
    assert api.get("/api/health").json() == {"status": "healthy"}


def test_me_marks_a_new_account_and_asks_for_a_token_refresh(api, monkeypatch):
    marked = []
    monkeypatch.setattr(health, "grant_access_claim", marked.append)
    api.user["has_access_claim"] = False
    assert api.get("/api/me").json() == {"email": "ana@example.com", "allowed": True, "refresh_token": True}
    assert marked == ["u1"]


def test_me_leaves_a_marked_account_alone(api, monkeypatch):
    monkeypatch.setattr(health, "grant_access_claim", lambda uid: pytest.fail("already marked"))
    assert api.get("/api/me").json()["refresh_token"] is False


def test_me_reports_when_the_mark_cannot_be_written(api, monkeypatch):
    def fail(uid):
        raise RuntimeError("identity service down")

    monkeypatch.setattr(health, "grant_access_claim", fail)
    api.user["has_access_claim"] = False
    assert api.get("/api/me").status_code == 503


def test_api_without_a_token_is_401(api):
    import app.main as main
    main.app.dependency_overrides.clear()
    assert api.get("/api/me").status_code == 401
    assert api.post("/api/projects/p1/generate-all").status_code == 401


# ── Reference video ──

REFERENCE = "users/u1/projects/p1/reference/video_1.mp4"


def test_reference_analysis_starts_in_the_background(api):
    project(api)
    response = api.post("/api/projects/p1/reference/analyse", json={"storage_ref": REFERENCE})
    assert response.status_code == 202
    assert api.db.store["projects/p1"]["referenceStatus"] == "analysing"
    assert api.started == ["run_reference_job"]


def test_reference_analysis_is_not_started_twice(api):
    project(api, referenceStatus="analysing", referenceStartedAt=now())
    response = api.post("/api/projects/p1/reference/analyse", json={"storage_ref": REFERENCE})
    assert response.status_code == 202
    assert "already" in response.json()["message"]
    assert api.started == []


def test_a_stuck_reference_analysis_can_be_started_again(api):
    project(api, referenceStatus="analysing", referenceStartedAt=now() - datetime.timedelta(minutes=30))
    api.post("/api/projects/p1/reference/analyse", json={"storage_ref": REFERENCE})
    assert api.started == ["run_reference_job"]


@pytest.mark.parametrize("path", [
    "users/u2/projects/p1/reference/video.mp4",          # another user's file
    "users/u1/projects/other/reference/video.mp4",       # another project's file
    "users/u1/projects/p1/reference/../../x.mp4",
    "users/u1/projects/p1/music/track.mp3",              # not a reference video
])
def test_reference_video_must_belong_to_the_project(api, path):
    project(api)
    assert api.post("/api/projects/p1/reference/analyse", json={"storage_ref": path}).status_code == 400
    assert api.started == []


def test_reference_analysis_of_someone_elses_or_a_missing_project(api):
    assert api.post("/api/projects/p1/reference/analyse", json={"storage_ref": REFERENCE}).status_code == 404
    project(api, userId="u2")
    assert api.post("/api/projects/p1/reference/analyse", json={"storage_ref": REFERENCE}).status_code == 403


# ── Generate all ──

def test_generate_all_counts_the_scenes_it_will_make(api):
    project(api)
    scene(api, "0", storageRef="done.mp4")
    scene(api, "1")
    scene(api, "2", skipped=True)
    response = api.post("/api/projects/p1/generate-all", json={"stitch": True})
    assert response.status_code == 202
    assert response.json()["scenes"] == 1
    state = api.db.store["projects/p1"]["generateAll"]
    assert (state["status"], state["total"], state["stitch"]) == ("running", 1, True)
    assert api.started == ["run_generate_all"]


def test_generate_all_with_nothing_to_make(api):
    project(api)
    scene(api, "0", storageRef="done.mp4")
    assert api.post("/api/projects/p1/generate-all").status_code == 400


def test_generate_all_waits_for_a_take_in_progress(api):
    project(api)
    scene(api, "0", videoStatus="generating", heartbeatAt=now())
    scene(api, "1")
    response = api.post("/api/projects/p1/generate-all")
    assert response.status_code == 409
    assert "Scene 1" in response.json()["detail"]


def test_generate_all_is_marked_failed_when_it_cannot_start(api, monkeypatch):
    project(api)
    scene(api, "0")

    def broken(coro):
        coro.close()
        raise RuntimeError("no event loop")

    monkeypatch.setattr(projects, "spawn_background", broken)
    with pytest.raises(RuntimeError):
        api.post("/api/projects/p1/generate-all")
    assert api.db.store["projects/p1"]["generateAll"]["status"] == "failed"


# ── Writing the script ──

def written(count):
    return {
        "video_context": "A kitchen.",
        "scenes": [{"description": f"d{n}", "script": f"s{n}", "context": "", "prompt": f"p{n}"} for n in range(count)],
    }


def test_script_is_saved_as_scenes_and_extra_scenes_are_removed(api, monkeypatch):
    project(api)
    scene(api, "0", attempt=2, storageRef="take.mp4", imageSource="creator")
    scene(api, "1")
    scene(api, "2")
    removed = []
    monkeypatch.setattr(scenes, "generate_script_and_scenes", lambda **kwargs: written(2))
    monkeypatch.setattr(scenes, "delete_prefix", removed.append)

    response = api.post("/api/generate-scenes", json={"project_id": "p1", "idea": "A mug", "num_scenes": 2})

    assert response.status_code == 200
    store = api.db.store
    assert store["projects/p1/scenes/0"]["script"] == "s0"
    assert store["projects/p1/scenes/0"]["storageRef"] == "take.mp4"      # takes survive a rewrite
    assert "projects/p1/scenes/2" not in store
    assert removed == ["users/u1/projects/p1/scenes/2/"]
    assert store["projects/p1"]["status"] == "scripted"
    assert store["projects/p1"]["settings"]["videoContext"] == "A kitchen."


def test_new_scenes_start_from_the_creator_photo_then_the_previous_scene(api, monkeypatch):
    project(api)
    monkeypatch.setattr(scenes, "generate_script_and_scenes", lambda **kwargs: written(2))
    api.post("/api/generate-scenes", json={"project_id": "p1", "idea": "A mug"})
    assert api.db.store["projects/p1/scenes/0"]["imageSource"] == "creator"
    assert api.db.store["projects/p1/scenes/1"]["imageSource"] == "last_frame"


def test_script_request_passes_the_reference_structure_without_their_words(api, monkeypatch):
    project(api)
    seen = {}

    def write(**kwargs):
        seen.update(kwargs)
        return written(1)

    monkeypatch.setattr(scenes, "generate_script_and_scenes", write)
    api.post("/api/generate-scenes", json={
        "project_id": "p1", "idea": "A mug",
        "structure": {"scenes": [{"purpose": "Hook", "happens": "She frowns", "said": "their exact words"}], "pacing": "Fast"},
    })
    assert seen["structure"]["scenes"] == [{"purpose": "Hook", "happens": "She frowns", "framing": ""}]
    assert seen["structure"]["pacing"] == "Fast"


def test_script_is_not_rewritten_while_a_take_is_being_made(api, monkeypatch):
    project(api)
    scene(api, "0", videoStatus="generating", heartbeatAt=now())
    monkeypatch.setattr(scenes, "generate_script_and_scenes", lambda **kwargs: written(1))
    assert api.post("/api/generate-scenes", json={"project_id": "p1", "idea": "A mug"}).status_code == 409


def test_script_for_someone_elses_project_is_refused(api, monkeypatch):
    project(api, userId="u2")
    monkeypatch.setattr(scenes, "generate_script_and_scenes", lambda **kwargs: pytest.fail("must not be written"))
    assert api.post("/api/generate-scenes", json={"project_id": "p1", "idea": "A mug"}).status_code == 403


def test_older_frontends_flat_fields_are_still_understood(api, monkeypatch):
    project(api)
    seen = {}

    def write(**kwargs):
        seen.update(kwargs)
        return written(1)

    monkeypatch.setattr(scenes, "generate_script_and_scenes", write)
    api.post("/api/generate-scenes", json={"project_id": "p1", "idea": "A mug", "camera_specifics": ["Phone"], "words_per_scene": 12})
    assert seen["camera_specifics"] == ["Phone"]
    assert seen["target_words_per_scene"] == 12


# ── Duplicating and deleting ──

def test_duplicate_copies_the_script_and_files_but_no_takes(api, monkeypatch):
    project(api, title="Mug ad", idea="A mug", status="done", startingImageRef="users/u1/projects/p1/creator.jpg", settings={
        "duration": 6,
        "reference": {"storageRef": REFERENCE, "url": "old", "breakdown": {"scenes": [{"purpose": "Hook"}]}},
        "endCard": {"imageRef": "users/u2/projects/x/card.png", "enabled": True},   # not this project's file
    })
    scene(api, "0", script="Hello", storageRef="take.mp4", attempt=3, imageSource="uploaded", customStartImageRef="users/u1/projects/p1/scenes/0/start.png")
    monkeypatch.setattr(projects, "copy_file", lambda source, target: f"https://files/{target}")

    response = api.post("/api/projects/p1/duplicate")

    assert response.status_code == 201
    new_id = response.json()["project_id"]
    copy = api.db.store[f"projects/{new_id}"]
    assert copy["title"] == "Copy of Mug ad"
    assert copy["status"] == "scripted"
    assert copy["startingImageRef"] == f"users/u1/projects/{new_id}/creator.jpg"
    assert copy["settings"]["reference"]["storageRef"] == f"users/u1/projects/{new_id}/reference/video_1.mp4"
    assert copy["settings"]["reference"]["breakdown"] == {"scenes": [{"purpose": "Hook"}]}
    assert "endCard" not in copy["settings"]
    new_scene = api.db.store[f"projects/{new_id}/scenes/0"]
    assert new_scene["script"] == "Hello"
    assert new_scene["attempt"] == 0 and "storageRef" not in new_scene
    assert new_scene["customStartImageRef"] == f"users/u1/projects/{new_id}/scenes/0/start.png"


def test_delete_removes_the_project_its_scenes_and_files_and_stops_takes(api, monkeypatch):
    project(api)
    scene(api, "0", videoStatus="generating", jobId="job1")
    scene(api, "1")
    monkeypatch.setattr(projects, "delete_prefix", lambda prefix: 4)

    response = api.request("DELETE", "/api/projects/p1")

    assert response.json() == {"project_id": "p1", "status": "deleted", "files_removed": 4}
    assert not any(path.startswith("projects/") for path in api.db.store)
    assert api.db.store["jobs/job1"]["cancelRequested"] is True


def test_dev_sign_in_route_does_not_exist_outside_local_test_mode(api):
    assert api.get("/api/dev/token").status_code == 404
