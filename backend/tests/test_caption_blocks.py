"""Captions placed by hand in the editor: shown exactly when they were put, in place of the automatic one."""
import pytest

from app import captions, jobs
from app.jobs import caption_blocks_signature, scene_caption_blocks
from tests.test_elevenlabs import stitch  # noqa: F401  (a fixture: the stitch job with its services replaced)


def settings(manual=("0",), **blocks):
    return {"captions": {"manual": {scene: True for scene in manual}, "blocks": blocks}}


def block(scene="0", at=0.0, length=1.0, text="Hello there"):
    return {"sceneId": scene, "at": at, "length": length, "text": text}


# --- which captions a scene has -----------------------------------------------------------------------

def test_a_scene_keeps_its_automatic_caption_until_it_is_switched_to_by_hand():
    assert scene_caption_blocks({}, "0") is None
    assert scene_caption_blocks(settings(manual=(), a=block()), "0") is None          # placed, but not switched
    assert scene_caption_blocks(settings(), "0") == []                                # by hand, nothing placed: no caption


def test_the_captions_of_a_scene_come_back_in_order_and_cleaned():
    found = scene_caption_blocks(settings(
        b=block(at=2.5, text="  second   one "), a=block(at=0.5, length=1.25), other=block(scene="1"),
        empty=block(text="  "), flat=block(length=0), junk="x", bad=block(at="soon"),
    ), "0")
    assert found == [{"at": 0.5, "length": 1.25, "text": "Hello there"}, {"at": 2.5, "length": 1.0, "text": "second one"}]


def test_the_signature_changes_with_anything_that_is_seen():
    one = [{"at": 0.5, "length": 1.25, "text": "Hello"}]
    assert caption_blocks_signature(one) == "0.50:1.25:Hello"
    assert caption_blocks_signature([]) == ""
    assert caption_blocks_signature(one) != caption_blocks_signature([{**one[0], "at": 0.6}])


# --- when each word is shown ----------------------------------------------------------------------------

def test_a_caption_fills_exactly_the_time_it_was_given():
    words = captions.block_words("Looks far more expensive.", 2.0, 1.5)
    assert [w[0] for w in words] == ["Looks", "far", "more", "expensive."]
    assert words[0][1] == 2.0 and words[-1][2] == pytest.approx(3.5)
    assert all(a[2] == pytest.approx(b[1]) for a, b in zip(words, words[1:]))         # no gaps inside it
    assert words[3][2] - words[3][1] > words[1][2] - words[1][1]                      # a long word takes longer
    assert captions.block_words("  ", 0, 1) == []


def test_a_caption_on_a_trimmed_clip_moves_with_the_cut_and_is_cut_at_its_edges():
    words = [("one", 0.0, 1.0), ("two", 1.0, 2.0), ("three", 2.0, 3.0), ("four", 3.0, 4.0)]
    fitted = captions.fit_block_to_clip(words, 1.5, 2.0)                              # the clip keeps 1.5s to 3.5s
    assert [w[0] for w in fitted] == ["two", "three", "four"]
    assert fitted[0][1:] == (0.0, 0.5) and fitted[-1][1:] == (1.5, 2.0)
    assert captions.fit_block_to_clip(words, 10, 2.0) == []


def test_a_line_never_stays_up_into_the_next_caption():
    first = [("Hello", 0.0, 1.0)]
    second = [("there", 1.1, 2.0)]
    ass = captions.build_ass([first, [], second], "minimal", 1080, 1920)
    events = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
    assert len(events) == 2
    assert events[0].split(",")[2] == "0:00:01.10"                                    # not 1.25: the next one starts at 1.1
    assert events[1].split(",")[2] == "0:00:02.25"                                    # the last one keeps its short hold


# --- the stitch -------------------------------------------------------------------------------------------

def test_the_stitch_shows_what_was_placed_and_times_only_the_other_scenes(stitch):
    project, seen = stitch(settings(a=block(at=1.0, length=2.0, text="By hand")))
    assert seen["timed"] == ["Line 1."]                                               # scene 0 is not sent for timing
    assert seen["stitched"]["caption_blocks"] == [[{"at": 1.0, "length": 2.0, "text": "By hand"}], None]
    assert seen["stitched"]["caption_texts"] == ["By hand", "Line 1."]
    version = project["finalVideos"].values[-1]
    assert version["captionBlocks"] == {"0": "1.00:2.00:By hand"} and version["captionTiming"] == "exact"


def test_without_captions_placed_by_hand_the_stitch_is_as_before(stitch):
    project, seen = stitch()
    assert seen["stitched"]["caption_blocks"] == [None, None]
    assert project["finalVideos"].values[-1]["captionBlocks"] == {}


def test_with_captions_off_nothing_placed_is_passed_on(stitch):
    project, seen = stitch({"captions": {"style": "none", "manual": {"0": True}, "blocks": {"a": block()}}})
    assert seen["stitched"]["caption_blocks"] is None
    assert project["finalVideos"].values[-1]["captionBlocks"] == {}
