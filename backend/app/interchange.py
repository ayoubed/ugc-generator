"""
Taking a project to another editor (Premiere Pro, DaVinci Resolve, and others that read Final Cut
Pro 7 XML): the cut as a timeline file that points at the scene clips, plus the captions as an SRT
file. The package route puts these in a zip with the media.

Everything here is pure (no ffmpeg, no network, no Firebase), so it is easy to test.
"""
import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

from app.captions import chunk_words, fit_words_to_clip, word_timings

MIN_KEPT_SECONDS = 0.3
SRT_MAX_WORDS, SRT_MAX_CHARS = 5, 32
MIN_CUE_SECONDS = 0.3


def _number(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def kept_range(
    duration: float,
    edit: Optional[Dict[str, Any]] = None,
    cut: Optional[Dict[str, Any]] = None,
    stitched_edit: Optional[Dict[str, Any]] = None,
) -> Tuple[float, float]:
    """
    The part of a scene's clip that is in the video, the way the editor's timeline shows it: an
    edit's start and end first, otherwise what the last stitch kept (its automatic cut), otherwise
    the whole clip. `stitched_edit` is the edit that stitch was made with: a side it set was not
    automatic, so it is not reused.
    """
    def inside(value: float) -> float:
        return max(0.0, min(duration, value))

    edit, cut, stitched_edit = edit or {}, cut or {}, stitched_edit or {}
    auto_start = inside(_number(cut.get("start")) or 0.0) if _number(stitched_edit.get("start")) is None else 0.0
    auto_end = inside(_number(cut.get("end")) or duration) if _number(stitched_edit.get("end")) is None else duration
    start = inside(_number(edit.get("start"))) if _number(edit.get("start")) is not None else auto_start
    end = inside(_number(edit.get("end"))) if _number(edit.get("end")) is not None else auto_end
    if end - start < MIN_KEPT_SECONDS - 1e-6:
        start, end = (auto_start, auto_end) if auto_end - auto_start >= MIN_KEPT_SECONDS else (0.0, duration)
    return round(start, 3), round(end, 3)


def slug(text: str, fallback: str = "video") -> str:
    """A file-name-safe version of a title."""
    cleaned = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:48].strip("-")
    return cleaned or fallback


def srt_clock(seconds: float) -> str:
    total = max(0, int(round(seconds * 1000)))
    hours, rest = divmod(total, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def caption_cues(clips: List[Dict[str, Any]]) -> List[Tuple[float, float, str]]:
    """
    Caption lines for the whole video as (start, end, text) in seconds of the timeline.
    Each clip has "at", "start", "end" (its kept part), "text" and optionally "words": measured
    word times in the clip ([(word, start, end)]); without them the words are spread evenly.
    """
    cues: List[Tuple[float, float, str]] = []
    for clip in clips:
        text = (clip.get("text") or "").strip()
        length = clip["end"] - clip["start"]
        if not text or length <= 0:
            continue
        measured = clip.get("words")
        words = fit_words_to_clip(measured, clip["start"], length) if measured else []
        if not words:
            words = word_timings(text, [], length)
        first_of_clip = len(cues)
        for line in chunk_words(words, SRT_MAX_WORDS, SRT_MAX_CHARS):
            start, end = round(clip["at"] + line[0][1], 3), round(clip["at"] + line[-1][2], 3)
            line_text = " ".join(w[0] for w in line)
            if end - start < MIN_CUE_SECONDS and len(cues) > first_of_clip:
                # Too short to read (a word left over where the scene was cut): joined to the line before.
                before = cues[-1]
                cues[-1] = (before[0], end, f"{before[2]} {line_text}")
            else:
                cues.append((start, end, line_text))
    return cues


def build_srt(cues: List[Tuple[float, float, str]]) -> str:
    blocks = [f"{n}\n{srt_clock(start)} --> {srt_clock(end)}\n{text}\n" for n, (start, end, text) in enumerate(cues, start=1)]
    return "\n".join(blocks)


def _rate(parent: ET.Element, timebase: int) -> None:
    rate = ET.SubElement(parent, "rate")
    ET.SubElement(rate, "timebase").text = str(timebase)
    ET.SubElement(rate, "ntsc").text = "FALSE"


def _text(parent: ET.Element, tag: str, value: Any) -> ET.Element:
    element = ET.SubElement(parent, tag)
    element.text = str(value)
    return element


def build_xmeml(timeline: Dict[str, Any]) -> str:
    """
    A Final Cut Pro 7 XML sequence (the interchange format Premiere Pro and DaVinci Resolve import).

    timeline = {
      "name", "fps", "width", "height",
      "clips": [{"name", "file" (path inside the package), "duration" (whole file, seconds),
                 "start", "end" (kept part), "has_audio", "muted"}],
      "end_card": {"file", "seconds"} or None,
      "music": {"file", "duration"} or None,
      "sounds": [{"name", "file", "duration", "time" (seconds into the video)}] (optional),
    }
    Video is one track. Each scene's sound is on audio tracks 1 and 2 (left and right), the music
    on 3 and 4, cut to the video's length. A muted scene has no audio clip. Sound effects come after
    the music, on as few track pairs as it takes for none to overlap.
    """
    timebase = max(1, int(round(float(timeline.get("fps") or 24))))

    def frames(seconds: float) -> int:
        return int(round(seconds * timebase))

    root = ET.Element("xmeml", version="4")
    sequence = ET.SubElement(root, "sequence", id="sequence-1")
    _text(sequence, "name", timeline.get("name") or "Video")
    duration_element = _text(sequence, "duration", 0)
    _rate(sequence, timebase)
    media = ET.SubElement(sequence, "media")

    video = ET.SubElement(media, "video")
    characteristics = ET.SubElement(ET.SubElement(video, "format"), "samplecharacteristics")
    _rate(characteristics, timebase)
    _text(characteristics, "width", int(timeline.get("width") or 720))
    _text(characteristics, "height", int(timeline.get("height") or 1280))
    _text(characteristics, "pixelaspectratio", "square")
    video_track = ET.SubElement(video, "track")

    audio = ET.SubElement(media, "audio")
    scene_tracks = [ET.SubElement(audio, "track"), ET.SubElement(audio, "track")]

    def file_element(parent: ET.Element, file_id: str, path: str, seconds: float, has_video: bool, has_audio: bool, declared: set) -> None:
        if file_id in declared:      # a file is described once, then referred to by id
            ET.SubElement(parent, "file", id=file_id)
            return
        declared.add(file_id)
        element = ET.SubElement(parent, "file", id=file_id)
        _text(element, "name", path.split("/")[-1])
        _text(element, "pathurl", path)
        _rate(element, timebase)
        _text(element, "duration", frames(seconds))
        inner = ET.SubElement(element, "media")
        if has_video:
            sample = ET.SubElement(ET.SubElement(inner, "video"), "samplecharacteristics")
            _text(sample, "width", int(timeline.get("width") or 720))
            _text(sample, "height", int(timeline.get("height") or 1280))
        if has_audio:
            sound = ET.SubElement(inner, "audio")
            sample = ET.SubElement(sound, "samplecharacteristics")
            _text(sample, "depth", 16)
            _text(sample, "samplerate", 48000)
            _text(sound, "channelcount", 2)

    def clip_item(track: ET.Element, item_id: str, name: str, at: int, length: int, in_frame: int, whole: int) -> ET.Element:
        item = ET.SubElement(track, "clipitem", id=item_id)
        _text(item, "name", name)
        _text(item, "enabled", "TRUE")
        _text(item, "duration", whole)
        _rate(item, timebase)
        _text(item, "start", at)
        _text(item, "end", at + length)
        _text(item, "in", in_frame)
        _text(item, "out", in_frame + length)
        return item

    declared: set = set()
    cursor = 0
    for number, clip in enumerate(timeline.get("clips") or [], start=1):
        in_frame = frames(clip["start"])
        length = max(1, frames(clip["end"]) - in_frame)
        whole = max(in_frame + length, frames(clip["duration"]))
        file_id = f"file-{number}"
        has_audio = bool(clip.get("has_audio"))
        item = clip_item(video_track, f"clipitem-v{number}", clip["name"], cursor, length, in_frame, whole)
        file_element(item, file_id, clip["file"], clip["duration"], True, has_audio, declared)
        if has_audio and not clip.get("muted"):
            for channel, track in enumerate(scene_tracks, start=1):
                sound = clip_item(track, f"clipitem-a{number}-{channel}", clip["name"], cursor, length, in_frame, whole)
                file_element(sound, file_id, clip["file"], clip["duration"], True, True, declared)
                source = ET.SubElement(sound, "sourcetrack")
                _text(source, "mediatype", "audio")
                _text(source, "trackindex", channel)
        cursor += length

    card = timeline.get("end_card")
    if card and card.get("file") and float(card.get("seconds") or 0) > 0:
        length = max(1, frames(float(card["seconds"])))
        item = clip_item(video_track, "clipitem-card", "End card", cursor, length, 0, length)
        file_element(item, "file-card", card["file"], float(card["seconds"]), True, False, declared)
        _text(item, "stillframe", "TRUE")
        cursor += length

    music = timeline.get("music")
    if music and music.get("file") and cursor > 0:
        whole = max(1, frames(float(music.get("duration") or 0)))
        length = min(cursor, whole)            # a shorter track is not looped: the other editor does that
        for channel in (1, 2):
            track = ET.SubElement(audio, "track")
            sound = clip_item(track, f"clipitem-music-{channel}", "Music", 0, length, 0, whole)
            file_element(sound, "file-music", music["file"], float(music.get("duration") or 0), False, True, declared)
            source = ET.SubElement(sound, "sourcetrack")
            _text(source, "mediatype", "audio")
            _text(source, "trackindex", channel)

    # Sound effects: each pair of tracks holds the sounds that do not overlap on it.
    lanes: List[Dict[str, Any]] = []
    for number, sound in enumerate(sorted(timeline.get("sounds") or [], key=lambda item: float(item["time"])), start=1):
        at = frames(float(sound["time"]))
        whole = max(1, frames(float(sound.get("duration") or 0)))
        length = min(whole, cursor - at)
        if length <= 0:
            continue
        lane = next((lane for lane in lanes if lane["free_at"] <= at), None)
        if lane is None:
            lane = {"tracks": [ET.SubElement(audio, "track"), ET.SubElement(audio, "track")], "free_at": 0}
            lanes.append(lane)
        lane["free_at"] = at + length
        for channel, track in enumerate(lane["tracks"], start=1):
            item = clip_item(track, f"clipitem-sound{number}-{channel}", sound.get("name") or "Sound", at, length, 0, whole)
            file_element(item, f"file-sound{number}", sound["file"], float(sound.get("duration") or 0), False, True, declared)
            source = ET.SubElement(item, "sourcetrack")
            _text(source, "mediatype", "audio")
            _text(source, "trackindex", channel)

    duration_element.text = str(cursor)
    ET.indent(root, space="  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + ET.tostring(root, encoding="unicode") + "\n"


README = """{name}: project package from Eleviat

What is in this folder
  timeline.xml   The cut as a Final Cut Pro 7 XML sequence.
  captions.srt   The captions with their timing{no_captions}.
  media/         The scene clips{extras}.

Opening it
  Premiere Pro:     File > Import, choose timeline.xml.
  DaVinci Resolve:  File > Import > Timeline, choose timeline.xml.
  If the editor asks where the media is, point it to the media folder.
  Captions: import captions.srt and drop it on the timeline at the start.

What carries over
  The order of the scenes and the part kept of each one, the scenes' own sound on audio tracks 1
  and 2 (a muted scene has none), the music on tracks 3 and 4, the sound effects on the tracks
  after it, and the end card as a still.

What does not
  Volume levels, the way the music dips under the voice, the burned-in caption style, and a voice
  chosen for the whole video: those are added when Eleviat stitches the video. Set them again in
  your editor, or use the stitched video as a guide.
"""


def build_readme(name: str, has_captions: bool, has_music: bool, has_card: bool, has_sounds: bool = False) -> str:
    extras = "".join([
        ", the music" if has_music else "", ", the sound effects" if has_sounds else "",
        ", the end card picture" if has_card else "",
    ])
    return README.format(name=name, no_captions="" if has_captions else " (empty: captions are off)", extras=extras)
