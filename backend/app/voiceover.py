"""
What the stitch does to a scene's sound with ElevenLabs (see app/elevenlabs.py): re-voice it to
the project's chosen voice, and find when each caption word is spoken.

Both results are kept, so stitching again does not pay for them again: the re-voiced audio in
Storage next to the take, the word times on the scene.
"""
import logging
import os
import re
from typing import Any, Dict, List, Optional

from app import elevenlabs
from app.pipeline import _run_ffmpeg, probe_media
from app.storage import download_file, upload_file

logger = logging.getLogger(__name__)


def project_voice(project_data: Optional[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    """The one voice chosen for the whole video ({"id", "name"}), or None to keep each scene's own."""
    voice = ((project_data or {}).get("settings") or {}).get("voice")
    if not isinstance(voice, dict) or not str(voice.get("id") or "").strip():
        return None
    return {"id": str(voice["id"]).strip(), "name": str(voice.get("name") or "").strip()}


def voice_cache_path(uid: str, project_id: str, scene_id: str, attempt: Any, voice_id: str) -> str:
    """Where a take's re-voiced audio is kept: one file per take and voice."""
    safe_voice = re.sub(r"[^A-Za-z0-9_-]", "", voice_id)[:64] or "voice"
    return f"users/{uid}/projects/{project_id}/scenes/{scene_id}/voice_{safe_voice}_v{attempt or 0}.mp3"


def extract_audio(video_path: str, audio_path: str) -> str:
    _run_ffmpeg(
        ["ffmpeg", "-y", "-i", video_path, "-vn", "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", audio_path],
        "Reading the scene's sound",
    )
    return audio_path


def replace_audio(video_path: str, audio_path: str, output_path: str, duration: float) -> str:
    """The same picture (copied, not re-encoded) with new sound, padded or cut to the clip's length."""
    _run_ffmpeg(
        ["ffmpeg", "-y", "-i", video_path, "-i", audio_path, "-map", "0:v:0", "-map", "1:a:0",
         "-c:v", "copy", "-af", "apad", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
         "-t", f"{max(0.05, duration):.3f}", output_path],
        "Putting the new voice on the scene",
    )
    return output_path


def revoiced_scene(
    uid: str, project_id: str, scene_id: str, attempt: Any, video_path: str, voice_id: str, work_dir: str
) -> str:
    """
    The scene's video with its speech in `voice_id`. Returns the original path for a scene without
    sound. The re-voiced audio is reused when this take was already re-voiced to this voice.
    """
    clip = probe_media(video_path)
    if not clip.get("has_audio"):
        return video_path

    cache_ref = voice_cache_path(uid, project_id, scene_id, attempt, voice_id)
    new_audio = os.path.join(work_dir, f"voice_{scene_id}.mp3")
    try:
        download_file(cache_ref, new_audio)
    except Exception:
        own_audio = extract_audio(video_path, os.path.join(work_dir, f"own_{scene_id}.mp3"))
        elevenlabs.change_voice(own_audio, voice_id, new_audio)
        try:
            upload_file(new_audio, cache_ref, content_type="audio/mpeg")
        except Exception as e:  # the stitch still has the audio; only the reuse is lost
            logger.warning("Could not keep the re-voiced audio of scene %s: %s", scene_id, e)

    return replace_audio(video_path, new_audio, os.path.join(work_dir, f"revoiced_{scene_id}.mp4"), float(clip["duration"]))


def saved_alignment(scene_data: Dict[str, Any], attempt: Any, text: str) -> Optional[List[tuple]]:
    """Word times found earlier for this take and this exact caption text, if any."""
    saved = scene_data.get("captionAlignment")
    if not isinstance(saved, dict) or saved.get("attempt") != attempt or saved.get("text") != text:
        return None
    try:
        return [(str(w["word"]), float(w["start"]), float(w["end"])) for w in saved.get("words") or []] or None
    except (KeyError, TypeError, ValueError):
        return None


def caption_word_times(
    scene_ref, scene_data: Dict[str, Any], attempt: Any, text: str, video_path: str, work_dir: str, scene_id: str
) -> Optional[List[tuple]]:
    """
    When each word of the caption is spoken in the scene, or None when that could not be found
    (the caption timing is then estimated, as without ElevenLabs). Never raises.
    """
    text = (text or "").strip()
    if not text:
        return None
    saved = saved_alignment(scene_data, attempt, text)
    if saved:
        return saved
    try:
        if not probe_media(video_path).get("has_audio"):
            return None
        audio = extract_audio(video_path, os.path.join(work_dir, f"align_{scene_id}.mp3"))
        words = elevenlabs.align_words(audio, text)
        if not words:
            return None
        scene_ref.update({"captionAlignment": {
            "attempt": attempt,
            "text": text,
            "words": [{"word": w, "start": a, "end": b} for w, a, b in words],
        }})
        return words
    except Exception as e:
        logger.warning("Exact caption timing for scene %s failed, estimating instead: %s", scene_id, e)
        return None
