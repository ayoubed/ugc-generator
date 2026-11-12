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
