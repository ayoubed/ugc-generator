"""
ElevenLabs, used for two things when a video is stitched:

- one voice for the whole video: every scene's speech is re-voiced to the same chosen voice
  (voice changer), because separately generated scenes can sound like different people;
- exact caption timing: the known script is aligned to the audio word by word (forced alignment).

Everything is optional. Without ELEVENLABS_API_KEY the app works as before: scenes keep their own
voices and caption timing is estimated.
"""
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

API_URL = "https://api.elevenlabs.io"
VOICE_CHANGER_MODEL = "eleven_multilingual_sts_v2"
REQUEST_TIMEOUT_SECONDS = 120
VOICE_LIST_TTL_SECONDS = 10 * 60

Word = Tuple[str, float, float]  # (text, start, end) in seconds

_voice_cache: Dict[str, Any] = {"at": 0.0, "voices": None}


def api_key() -> str:
    """The key without the spaces or quote marks a settings file or a shell can leave around it."""
    return (os.environ.get("ELEVENLABS_API_KEY") or "").strip().strip("\"'").strip()


def is_configured() -> bool:
    return bool(api_key())


class VoiceServiceError(RuntimeError):
    """A failure at ElevenLabs, with a message written for the user."""


def _message_for(status_code: int, doing: str) -> str:
    if status_code in (401, 403):
        return "The voice service rejected its key. This has to be fixed on the server."
    if status_code == 402:
        # Seen for music on a free account: "Music API is not available for free users."
        return (
            "This needs a paid ElevenLabs plan, or the plan's credit has run out. "
            "Upgrade or top up in ElevenLabs, or pick another option."
        )
    if status_code == 429:
        return "The voice service is busy or its usage allowance ran out. Wait a minute and try again."
    if status_code == 404:
        return "That voice no longer exists. Pick another voice on the Video step."
    if status_code >= 500:
        return "The voice service had a problem. Try again in a moment."
    if doing == "Making the music":
        return "The music service did not accept this description. Reword it and try again."
    return f"{doing} was not accepted by the voice service. Try again, or pick another voice."


def _request(method: str, path: str, doing: str, **kwargs) -> httpx.Response:
    key = api_key()
    if not key:
        raise VoiceServiceError("The voice service is not set up on the server.")
    try:
        response = httpx.request(
            method, f"{API_URL}{path}", headers={"xi-api-key": key}, timeout=REQUEST_TIMEOUT_SECONDS, **kwargs
        )
    except httpx.HTTPError as e:
        logger.warning("ElevenLabs request failed (%s %s): %s", method, path, e)
        raise VoiceServiceError("The server could not reach the voice service. Try again in a moment.") from e
    if response.status_code >= 400:
        logger.warning("ElevenLabs answered %s for %s %s: %s", response.status_code, method, path, response.text[:500])
        raise VoiceServiceError(_message_for(response.status_code, doing))
    return response


def simplify_voice(voice: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """What the app keeps of a voice: its id, name, a short description and a sample to listen to."""
    voice_id = str(voice.get("voice_id") or "").strip()
    name = str(voice.get("name") or "").strip()
    if not voice_id or not name:
        return None
    labels = voice.get("labels") if isinstance(voice.get("labels"), dict) else {}
    traits = [str(labels.get(key) or "").strip().replace("_", " ") for key in ("gender", "age", "accent", "descriptive")]
    return {
        "id": voice_id,
        "name": name,
        "description": ", ".join(t for t in traits if t),
        "previewUrl": str(voice.get("preview_url") or ""),
    }


def list_voices(force: bool = False) -> List[Dict[str, str]]:
    """The voices of the account, by name. Kept for a few minutes: the list rarely changes."""
    fresh = time.monotonic() - _voice_cache["at"] < VOICE_LIST_TTL_SECONDS
    if _voice_cache["voices"] is not None and fresh and not force:
        return _voice_cache["voices"]
    data = _request("GET", "/v2/voices", "Loading the voices", params={"page_size": 100}).json()
    voices = [v for v in (simplify_voice(item) for item in data.get("voices") or [] if isinstance(item, dict)) if v]
    voices.sort(key=lambda v: v["name"].lower())
    _voice_cache.update({"at": time.monotonic(), "voices": voices})
    return voices


def change_voice(audio_path: str, voice_id: str, output_path: str) -> str:
    """
    Re-voices the speech in `audio_path` to `voice_id` and writes an MP3. The words, timing and
    delivery stay as they are, so lips still match; room sound is removed with the old voice.
    """
    with open(audio_path, "rb") as audio:
        response = _request(
            "POST",
            f"/v1/voice-changer/{voice_id}",
            "Changing the voice",
            params={"output_format": "mp3_44100_128"},
            data={"model_id": VOICE_CHANGER_MODEL, "remove_background_noise": "true"},
            files={"audio": (os.path.basename(audio_path), audio, "audio/mpeg")},
        )
    if not response.content:
        raise VoiceServiceError("The voice service returned no audio. Try again.")
    with open(output_path, "wb") as out:
        out.write(response.content)
    return output_path


MUSIC_MIN_SECONDS, MUSIC_MAX_SECONDS = 3.0, 600.0


def compose_music(prompt: str, output_path: str, seconds: float) -> str:
    """An instrumental track of exactly `seconds` (3 to 600), written as an MP3."""
    length = int(round(max(MUSIC_MIN_SECONDS, min(MUSIC_MAX_SECONDS, float(seconds))) * 1000))
    response = _request(
        "POST", "/v1/music", "Making the music",
        json={"prompt": prompt, "music_length_ms": length, "force_instrumental": True},
    )
    if not response.content:
        raise VoiceServiceError("The music service returned no audio. Try a different description.")
    with open(output_path, "wb") as out:
        out.write(response.content)
    return output_path


def words_from_alignment(data: Dict[str, Any], text: str) -> List[Word]:
    """
    Word times from a forced-alignment answer. When the service found the same number of words as
    the caption text has, the caption's own words are kept (with their punctuation and capitals).
    """
    found: List[Word] = []
    for item in data.get("words") or []:
        if not isinstance(item, dict):
            continue
        word = str(item.get("text") or "").strip()
        try:
            start, end = float(item.get("start")), float(item.get("end"))
        except (TypeError, ValueError):
            continue
        if word and end >= start >= 0:
            found.append((word, round(start, 3), round(end, 3)))
    own = [w for w in (text or "").split() if w]
    if own and len(own) == len(found):
        return [(word, start, end) for word, (_, start, end) in zip(own, found)]
    return found


def align_words(audio_path: str, text: str) -> List[Word]:
    """When each word of `text` is spoken in `audio_path`."""
    with open(audio_path, "rb") as audio:
        response = _request(
            "POST",
            "/v1/forced-alignment",
            "Timing the captions",
            data={"text": text},
            files={"file": (os.path.basename(audio_path), audio, "audio/mpeg")},
        )
    return words_from_alignment(response.json(), text)
