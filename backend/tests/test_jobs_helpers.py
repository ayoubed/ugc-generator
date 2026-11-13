"""Scene order, takes and prompt context (the pure helpers in app/jobs.py)."""
import datetime

from app import jobs


def scenes_ref(fake_db, scenes):
    for doc_id, data in scenes.items():
        fake_db.store[f"projects/p1/scenes/{doc_id}"] = data
    return fake_db.collection("projects").document("p1")


def test_scenes_are_labelled_in_video_order_with_letters_for_alternatives(fake_db):
    ref = scenes_ref(fake_db, {"0": {}, "2": {}, "5": {"variantOf": 2}, "7": {}, "notes": {}})
    assert [(label, doc_id) for label, doc_id, _ in jobs.ordered_scenes(ref)] == [
        ("1", "0"), ("2A", "2"), ("2B", "5"), ("3", "7"),
    ]


def test_previous_scene_skips_gaps_skipped_scenes_and_alternatives(fake_db):
    ref = scenes_ref(fake_db, {
        "0": {"script": "first"},
        "1": {"skipped": True},
        "3": {"script": "third"},
        "4": {"variantOf": 3},
    })
    assert jobs.find_previous_scene(ref, 3)[0] == "0"      # scene 1 is skipped, scene 2 was deleted
    assert jobs.find_previous_scene(ref, 4)[0] == "0"      # an alternative never follows its sibling
    assert jobs.find_previous_scene(ref, 0) == (None, None)


def test_generate_all_only_makes_scenes_in_the_video_without_a_take(fake_db):
    ref = scenes_ref(fake_db, {"0": {"storageRef": "a.mp4"}, "1": {}, "2": {"skipped": True}})
    assert [doc_id for _, doc_id, _ in jobs.scenes_needing_video(ref)] == ["1"]


def test_starting_picture_rules():
    assert jobs.starting_source_for({}, is_first=True) == "creator"
    assert jobs.starting_source_for({}, is_first=False) == "last_frame"
    assert jobs.starting_source_for({"customStartImageRef": "x"}, is_first=False) == "uploaded"
    # The first scene has no previous scene to continue from.
    assert jobs.starting_source_for({"imageSource": "extend"}, is_first=True) == "creator"
    assert jobs.starting_source_for({"imageSource": "ai_cut", "customStartImageRef": "x"}, is_first=True) == "uploaded"
    assert jobs.starting_source_for({"imageSource": "extend"}, is_first=False) == "extend"
    assert jobs.starting_source_for({"imageSource": "nonsense"}, is_first=False) == "last_frame"


def test_old_takes_are_dropped_but_never_the_one_in_use():
    history = [{"attempt": n} for n in range(1, 7)] + [{"note": "not a take"}]
    kept, dropped = jobs.split_takes_to_keep(history, active_attempt=1, max_takes=3)
    assert [t["attempt"] for t in dropped] == [2, 3, 4]
    assert [t.get("attempt") for t in kept] == [1, 5, 6, None]


def test_few_takes_are_all_kept():
    history = [{"attempt": 1}, {"attempt": 2}]
    assert jobs.split_takes_to_keep(history, 2, max_takes=3) == (history, [])


def test_scene_context_uses_saved_guidelines_and_no_music_tags_in_voice_only_mode():
    parts = jobs.build_global_context({
        "idea": " A mug ",
        "settings": {
            "videoContext": "A kitchen.",
            "assetBible": {"hero_props": "One steel mug"},
            "cameraTags": ["Phone front camera", " "],
            "audioTags": ["Soft background music", "Clear voice"],
            "accent": "British",
        },
        "guidelines": {"camera_specifics": "ignored, settings win"},
    })
    assert parts[0] == "Global Video Idea: A mug"
    assert "Video Context: A kitchen." in parts
    assert "Products and props: One steel mug" in parts
    assert any(p.endswith(": Phone front camera") for p in parts)
    assert any(p.endswith(": Clear voice") for p in parts)
    assert not any("music" in p.lower() for p in parts)
    assert parts[-1] == "Speaker Accent: British"


def test_music_needs_a_file_and_a_known_volume():
    assert jobs.project_music({"settings": {"music": {"source": "none", "storageRef": "m.mp3"}}}) is None
    assert jobs.project_music({"settings": {"music": {"source": "upload"}}}) is None
    assert jobs.project_music({"settings": {"music": {"source": "upload", "storageRef": "m.mp3", "volume": "max"}}})["volume"] == "medium"


def test_a_job_with_no_recent_sign_of_life_is_stale():
    now = datetime.datetime.now(datetime.timezone.utc)
    assert jobs.is_stale_job({}) is True
    assert jobs.is_stale_job({"heartbeatAt": now}) is False
    assert jobs.is_stale_job({"updatedAt": now - datetime.timedelta(seconds=jobs.STALE_JOB_SECONDS + 60)}) is True


def test_files_outside_the_callers_area_are_refused():
    jobs._assert_owned_path("u1", "users/u1/projects/p/a.png", "picture")
    try:
        jobs._assert_owned_path("u1", "users/u2/projects/p/a.png", "picture")
    except ValueError as error:
        assert "outside your storage area" in str(error)
    else:
        raise AssertionError("a path in another user's area must be refused")


def test_a_take_counts_as_flagged_only_when_the_check_found_problems():
    issues = [{"kind": "speech", "detail": "Cut off at the end."}]
    assert jobs.take_was_flagged({"takeChecks": {"2": {"ok": False, "issues": issues}}}, 2) is True
    assert jobs.take_was_flagged({"takeChecks": {"2": {"ok": True, "issues": []}}}, 2) is False
    assert jobs.take_was_flagged({"takeChecks": {"1": {"ok": False, "issues": issues}}}, 2) is False   # another take
    assert jobs.take_was_flagged({}, 1) is False                                                       # not checked


class FakeTakes:
    """Stands in for the video job: each call finishes a take whose check passes or fails as scripted."""

    def __init__(self, db, check_results, fail_attempts=()):
        self.db, self.check_results, self.fail_attempts, self.made = db, list(check_results), set(fail_attempts), []

    def __call__(self, uid, project_id, scene_index, source, _file, _settings, attempt):
        self.made.append((scene_index, attempt))
        scene = self.db.store[f"projects/{project_id}/scenes/{scene_index}"]
        if attempt in self.fail_attempts:
            scene.update({"videoStatus": "completed" if scene.get("storageRef") else "failed", "errorMessage": "model busy"})
            return
        ok = self.check_results.pop(0)
        scene.update({"videoStatus": "completed", "storageRef": f"take{attempt}.mp4", "activeAttempt": attempt})
        scene.setdefault("takeChecks", {})[str(attempt)] = {"ok": ok, "issues": [] if ok else [{"kind": "speech", "detail": "x"}]}


def run_all(fake_db, monkeypatch, takes, retake):
    fake_db.store["projects/p1"] = {"userId": "u1", "startingImageRef": "creator.png", "settings": {}, "generateAll": {}}
    fake_db.store["projects/p1/scenes/0"] = {"prompt": "Say hi", "attempt": 0}
    fake_db.store["projects/p1/scenes/1"] = {"prompt": "Say bye", "attempt": 0, "imageSource": "last_frame"}
    monkeypatch.setattr(jobs, "_run_video_generation_job_sync", takes)
    jobs._run_generate_all_sync("u1", "p1", stitch=False, retake=retake)
    return fake_db.store["projects/p1"]["generateAll"]


def test_generate_all_retakes_a_flagged_scene_once_and_moves_on(fake_db, monkeypatch):
    takes = FakeTakes(fake_db, [False, False, True])   # scene 0: flagged twice; scene 1: fine
    state = run_all(fake_db, monkeypatch, takes, retake=True)
    assert takes.made == [(0, 1), (0, 2), (1, 1)]
    assert state["status"] == "done" and state["retaking"] is False
    assert fake_db.store["projects/p1/scenes/0"]["activeAttempt"] == 2


def test_generate_all_without_the_option_never_retakes(fake_db, monkeypatch):
    takes = FakeTakes(fake_db, [False, True])
    assert run_all(fake_db, monkeypatch, takes, retake=False)["status"] == "done"
    assert takes.made == [(0, 1), (1, 1)]


def test_a_failed_retake_keeps_the_first_take_and_the_run_goes_on(fake_db, monkeypatch):
    takes = FakeTakes(fake_db, [False, True], fail_attempts={2})
    state = run_all(fake_db, monkeypatch, takes, retake=True)
    assert takes.made == [(0, 1), (0, 2), (1, 1)]
    assert state["status"] == "done"
    assert fake_db.store["projects/p1/scenes/0"]["storageRef"] == "take1.mp4"


def test_generate_all_stops_at_a_scene_that_fails_outright(fake_db, monkeypatch):
    takes = FakeTakes(fake_db, [], fail_attempts={1})
    state = run_all(fake_db, monkeypatch, takes, retake=True)
    assert takes.made == [(0, 1)]
    assert state["status"] == "failed" and "Scene 1 failed" in state["error"]


# --- new takes of scenes that already have a video ----------------------------------------------

def remake_project(fake_db):
    fake_db.store["projects/p1"] = {"userId": "u1", "startingImageRef": "creator.png", "settings": {}, "generateAll": {}}
    for index in range(3):
        fake_db.store[f"projects/p1/scenes/{index}"] = {
            "prompt": f"Line {index}", "attempt": 1, "activeAttempt": 1, "storageRef": "take1.mp4",
            "videoStatus": "completed", **({"imageSource": "last_frame"} if index else {}),
        }


def test_only_scenes_that_have_a_video_and_are_in_the_video_can_be_remade():
    scenes = [("1", "0", {"storageRef": "a.mp4"}), ("2", "1", {}), ("3", "2", {"storageRef": "c.mp4", "skipped": True}),
              ("4", "3", {"storageRef": "d.mp4"})]
    assert jobs.scenes_to_remake(scenes, ["3", "0", "1", "2", "nope"]) == ["0", "3"]
    assert jobs.scenes_to_remake(scenes, None) == []


def test_a_run_makes_new_takes_of_the_chosen_scenes_and_leaves_the_others(fake_db, monkeypatch):
    remake_project(fake_db)
    takes = FakeTakes(fake_db, [True, True])
    monkeypatch.setattr(jobs, "_run_video_generation_job_sync", takes)
    jobs._run_generate_all_sync("u1", "p1", stitch=False, retake=False, remake=["0", "2"])
    assert takes.made == [(0, 2), (2, 2)]
    assert fake_db.store["projects/p1/scenes/0"]["activeAttempt"] == 2
    assert fake_db.store["projects/p1/scenes/1"]["activeAttempt"] == 1      # not asked for: untouched
    assert fake_db.store["projects/p1"]["generateAll"]["status"] == "done"


def test_a_run_makes_missing_scenes_and_remakes_together_in_video_order(fake_db, monkeypatch):
    remake_project(fake_db)
    fake_db.store["projects/p1/scenes/1"] = {"prompt": "Line 1", "attempt": 0, "imageSource": "last_frame"}
    takes = FakeTakes(fake_db, [True, True])
    monkeypatch.setattr(jobs, "_run_video_generation_job_sync", takes)
    jobs._run_generate_all_sync("u1", "p1", stitch=False, retake=False, remake=["0"])
    assert takes.made == [(0, 2), (1, 1)]


def test_a_new_take_that_fails_stops_the_run_and_keeps_the_earlier_take(fake_db, monkeypatch):
    remake_project(fake_db)

    def failing(uid, project_id, scene_index, source, _file, _settings, attempt):
        fake_db.store[f"projects/{project_id}/scenes/{scene_index}"].update(
            {"videoStatus": "completed", "failedAttempt": attempt, "errorMessage": "The model is busy."})

    monkeypatch.setattr(jobs, "_run_video_generation_job_sync", failing)
    jobs._run_generate_all_sync("u1", "p1", stitch=False, retake=False, remake=["0", "1"])
    state = fake_db.store["projects/p1"]["generateAll"]
    assert state["status"] == "failed"
    assert "The new take of scene 1 failed: The model is busy." in state["error"]
    assert "earlier take is still in use" in state["error"]
    assert fake_db.store["projects/p1/scenes/0"]["storageRef"] == "take1.mp4"
    assert fake_db.store["projects/p1/scenes/1"]["attempt"] == 1            # the run did not go on


def test_a_new_take_cancelled_on_the_scene_stops_the_run_quietly(fake_db, monkeypatch):
    remake_project(fake_db)
    monkeypatch.setattr(jobs, "_run_video_generation_job_sync",
                        lambda uid, pid, index, *rest: fake_db.store[f"projects/{pid}/scenes/{index}"].update({"videoStatus": "completed"}))
    jobs._run_generate_all_sync("u1", "p1", stitch=False, retake=False, remake=["0", "1"])
    state = fake_db.store["projects/p1"]["generateAll"]
    assert state["status"] == "cancelled"
    assert fake_db.store["projects/p1/scenes/1"]["attempt"] == 1
