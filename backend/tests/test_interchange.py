"""Export for other editors: the timeline file, the captions file and the package job."""
import os
import xml.etree.ElementTree as ET
import zipfile

import pytest

from app import jobs
from app.interchange import build_readme, build_srt, build_xmeml, caption_cues, kept_range, slug, srt_clock
from app.routes import package


# --- what is kept of a scene ---------------------------------------------------------------------

def test_the_export_keeps_what_the_timeline_shows():
    cut = {"start": 0.4, "end": 4.6}
    assert kept_range(5.0) == (0.0, 5.0)                                   # never stitched: the whole clip
    assert kept_range(5.0, None, cut) == (0.4, 4.6)                        # the automatic cut
    assert kept_range(5.0, {"start": 1.0}, cut) == (1.0, 4.6)              # an edit on one side
    assert kept_range(5.0, {"start": 1.0, "end": 9}, cut) == (1.0, 5.0)


def test_a_side_the_last_stitch_took_from_an_edit_is_not_automatic():
    assert kept_range(5.0, None, {"start": 1.5, "end": 4.6}, {"start": 1.5}) == (0.0, 4.6)


def test_an_edit_that_leaves_nothing_falls_back():
    assert kept_range(5.0, {"start": 3, "end": 3.1}, {"start": 0.4, "end": 4.6}) == (0.4, 4.6)


# --- captions ------------------------------------------------------------------------------------

def test_srt_times_and_numbering():
    assert srt_clock(0) == "00:00:00,000"
    assert srt_clock(75.5) == "00:01:15,500"
    assert build_srt([(0, 1.2, "Hello there"), (1.2, 2, "friend")]) == (
        "1\n00:00:00,000 --> 00:00:01,200\nHello there\n\n2\n00:00:01,200 --> 00:00:02,000\nfriend\n"
    )


def test_caption_lines_sit_where_their_scene_is_on_the_timeline():
    clips = [
        {"at": 0.0, "start": 0.5, "end": 2.5, "text": "Hello there.", "words": [("Hello", 0.6, 1.0), ("there.", 1.1, 1.6)]},
        {"at": 2.0, "start": 0.0, "end": 3.0, "text": "", "words": None},                 # no caption on this scene
        {"at": 5.0, "start": 0.0, "end": 2.0, "text": "Bye now.", "words": None},          # no measured times: spread evenly
    ]
    cues = caption_cues(clips)
    assert cues[0] == (0.1, 1.1, "Hello there.")                    # measured times, moved by the trim
    assert cues[1][2] == "Bye now." and cues[1][0] >= 5.0 and cues[1][1] <= 7.0
    assert len(cues) == 2


def test_a_word_left_over_by_a_cut_joins_the_line_before():
    words = [("Okay,", 0.1, 0.4), ("I", 0.4, 0.5), ("have", 0.5, 0.7), ("to", 0.7, 0.8), ("show", 0.8, 1.2), ("you", 1.2, 1.28)]
    cues = caption_cues([{"at": 0.0, "start": 0.0, "end": 1.3, "text": "Okay, I have to show you this.", "words": words}])
    assert cues == [(0.1, 1.28, "Okay, I have to show you")]


# --- the timeline file ---------------------------------------------------------------------------

def timeline(**extra):
    return {
        "name": "Mug & ad", "fps": 24, "width": 720, "height": 1280,
        "clips": [
            {"name": "Scene 1", "file": "media/scene_01.mp4", "duration": 5.0, "start": 0.5, "end": 4.0, "has_audio": True, "muted": False},
            {"name": "Scene 2", "file": "media/scene_02.mp4", "duration": 5.0, "start": 0.0, "end": 2.0, "has_audio": True, "muted": True},
        ],
        "end_card": None, "music": None, **extra,
    }


def parsed(tl):
    text = build_xmeml(tl)
    assert text.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>')
    return ET.fromstring(text.split("<!DOCTYPE xmeml>\n", 1)[1])


def numbers(item):
    return {tag: int(item.findtext(tag)) for tag in ("start", "end", "in", "out", "duration")}


def test_the_sequence_has_the_clips_in_order_with_their_kept_parts_in_frames():
    root = parsed(timeline())
    sequence = root.find("sequence")
    assert sequence.findtext("name") == "Mug & ad"                    # special characters survive
    assert sequence.findtext("rate/timebase") == "24"
    assert sequence.findtext("duration") == str(84 + 48)
    first, second = sequence.findall("media/video/track/clipitem")
    assert numbers(first) == {"start": 0, "end": 84, "in": 12, "out": 96, "duration": 120}
    assert numbers(second) == {"start": 84, "end": 132, "in": 0, "out": 48, "duration": 120}
    assert first.findtext("file/pathurl") == "media/scene_01.mp4"
    assert sequence.findtext("media/video/format/samplecharacteristics/height") == "1280"


def test_scene_sound_is_on_two_tracks_and_a_muted_scene_has_none():
    tracks = parsed(timeline()).findall("sequence/media/audio/track")
    assert len(tracks) == 2
    for channel, track in enumerate(tracks, start=1):
        items = track.findall("clipitem")
        assert [i.findtext("name") for i in items] == ["Scene 1"]        # scene 2 is muted
        assert items[0].findtext("sourcetrack/trackindex") == str(channel)
        assert items[0].find("file").get("id") == "file-1" and items[0].find("file").find("pathurl") is None


def test_the_end_card_and_the_music_are_on_the_timeline():
    root = parsed(timeline(end_card={"file": "media/end_card.jpg", "seconds": 2.5}, music={"file": "media/music.mp3", "duration": 30.0}))
    video = root.findall("sequence/media/video/track/clipitem")
    assert video[-1].findtext("name") == "End card" and video[-1].findtext("stillframe") == "TRUE"
    assert numbers(video[-1])["start"] == 132 and numbers(video[-1])["end"] == 132 + 60
    music = root.findall("sequence/media/audio/track")[2].find("clipitem")
    assert numbers(music) == {"start": 0, "end": 192, "in": 0, "out": 192, "duration": 720}   # cut to the video's length


def test_music_shorter_than_the_video_is_not_stretched():
    root = parsed(timeline(music={"file": "media/music.mp3", "duration": 2.0}))
    assert numbers(root.findall("sequence/media/audio/track")[2].find("clipitem"))["end"] == 48


def test_file_names_and_the_readme():
    assert slug("Ad for a Carré Royale watch!") == "ad-for-a-carr-royale-watch"
    assert slug("", "video") == "video"
    readme = build_readme("Mug ad", has_captions=False, has_music=True, has_card=False)
    assert "Premiere Pro" in readme and "DaVinci Resolve" in readme
    assert "captions are off" in readme and "the music" in readme and "end card picture" not in readme


# --- the package job -----------------------------------------------------------------------------

@pytest.fixture
def packaged(fake_db, monkeypatch, tmp_path):
    project = fake_db.collection("projects").document("p1")
    project.set({
        "userId": "u1", "title": "Mug ad", "finalVideoVersion": 1,
        "finalVideos": [{"version": 1, "cuts": {"0": {"start": 0.4, "end": 4.6, "attempt": 1}}}],
        "settings": {"edits": {"1": {"attempt": 1, "muted": True}}, "music": {"source": "upload", "storageRef": "users/u1/projects/p1/music/m.mp3"}},
    })
    for index in range(2):
        project.collection("scenes").document(str(index)).set({
            "index": index, "script": f"Line {index}.", "activeAttempt": 1, "storageRef": f"users/u1/projects/p1/scenes/{index}/v.mp4",
        })
    uploaded = {}

    def fake_download(ref, path):
        with open(path, "wb") as f:
            f.write(b"media:" + ref.encode())

    def fake_upload(path, ref, content_type=None):
        target = tmp_path / "uploaded.zip"
        target.write_bytes(open(path, "rb").read())
        uploaded.update(ref=ref, path=str(target), content_type=content_type)

    monkeypatch.setattr(package, "download_file", fake_download)
    monkeypatch.setattr(package, "upload_file", fake_upload)
    monkeypatch.setattr(package, "get_download_url", lambda ref: f"https://files.test/{ref}")
    monkeypatch.setattr(package, "set_download_name", lambda ref, name: uploaded.update(download_name=name))
    monkeypatch.setattr(package, "probe_media", lambda path: {"duration": 5.0, "has_audio": True, "width": 720, "height": 1280, "fps": 24.0})
    return project, uploaded


def test_the_package_holds_the_timeline_the_captions_and_the_media(packaged):
    project, uploaded = packaged
    package._run_package_job_sync("u1", "p1")
    state = project.get().to_dict()
    assert (state["packageStatus"], state["packageName"], state["packageError"]) == ("ready", "mug-ad.zip", None)
    assert state["packageUrl"] == "https://files.test/users/u1/projects/p1/package/mug-ad_v1.zip"
    assert uploaded["content_type"] == "application/zip"
    assert uploaded["download_name"] == "mug-ad.zip"            # saved under this name, not opened in the tab
    with zipfile.ZipFile(uploaded["path"]) as archive:
        names = sorted(archive.namelist())
        assert names == ["mug-ad/README.txt", "mug-ad/captions.srt", "mug-ad/media/music.mp3", "mug-ad/media/scene_01.mp4",
                         "mug-ad/media/scene_02.mp4", "mug-ad/timeline.xml"]
        xml = archive.read("mug-ad/timeline.xml").decode()
        srt = archive.read("mug-ad/captions.srt").decode()
        assert archive.read("mug-ad/media/scene_01.mp4") == b"media:users/u1/projects/p1/scenes/0/v.mp4"
    root = ET.fromstring(xml.split("<!DOCTYPE xmeml>\n", 1)[1])
    first = root.find("sequence/media/video/track/clipitem")
    assert (first.findtext("in"), first.findtext("out")) == ("10", "110")            # the automatic cut, 0.4s to 4.6s
    assert len(root.findall("sequence/media/audio/track")[0].findall("clipitem")) == 1   # scene 2 is muted
    assert "Line 0." in srt and "Line 1." in srt


def test_a_project_with_a_scene_that_has_no_video_cannot_be_exported(packaged):
    project, _ = packaged
    project.collection("scenes").document("1").update({"storageRef": None})
    package._run_package_job_sync("u1", "p1")
    state = project.get().to_dict()
    assert state["packageStatus"] == "failed"
    assert "needs a video" in state["packageError"]


def test_the_export_starts_in_the_background_for_the_owner_only(api):
    api.db.collection("projects").document("p1").set({"userId": "u1"})
    api.db.collection("projects").document("p2").set({"userId": "someone-else"})
    assert api.post("/api/projects/p1/package").status_code == 202
    assert api.db.store["projects/p1"]["packageStatus"] == "building"
    assert api.started == ["run_package_job"]
    assert api.post("/api/projects/p2/package").status_code == 403
    assert api.post("/api/projects/nope/package").status_code == 404
