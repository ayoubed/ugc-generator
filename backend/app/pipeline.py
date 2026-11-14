import os
import time
import json
import math
import re
import base64
import shutil
import logging
import subprocess
import tempfile
from typing import Any, Callable, Dict, List, Union, Optional, Tuple
import cv2
from google import genai
from google.genai import types
import difflib
from app.models import Scene, SceneList, AssetBible, TakeCheckResult, ReferenceBreakdown
from app.model_registry import get_video_model, get_music_model, TAKE_CHECK_MODEL_ID, STILL_MODEL_ID, REFERENCE_MODEL_ID
from app import prompts
from app.captions import build_ass, fit_words_to_clip, word_timings
from app.beats import music_fit_for_cuts

logger = logging.getLogger(__name__)

# project.settings.sceneAudio
SCENE_AUDIO_VOICE_ONLY = "voice_only"   # scenes carry only the voice; music is added when stitching
SCENE_AUDIO_MODEL = "model"             # the video model picks the audio (may add its own music)
SCENE_AUDIO_MODES = (SCENE_AUDIO_VOICE_ONLY, SCENE_AUDIO_MODEL)

MUSIC_INSTRUMENTAL_SUFFIX = "Instrumental only, no vocals."


def generate_music(
    prompt: str, output_path: str, music_model: Optional[str] = None, seconds: Optional[float] = None
) -> Tuple[str, str]:
    """
    Generates a music track. Vocals are always excluded so lyrics never clash with the speaker.
    `seconds` is the length of the video: ElevenLabs makes the track exactly that long, with a
    real ending; Lyria ignores it (its track is looped or cut when stitching).
    Returns (output_path, mime_type).
    """
    model = get_music_model(music_model)
    text = (prompt or "").strip() or "Light, upbeat instrumental background music for a casual social media video."
    if model.get("provider") == "elevenlabs":
        from app import elevenlabs  # imported here: elevenlabs has no need of this module

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        elevenlabs.compose_music(text, output_path, seconds or 30.0)
        return output_path, "audio/mpeg"
    if "no vocals" not in text.lower():
        text = f"{text.rstrip('.')}. {MUSIC_INSTRUMENTAL_SUFFIX}"

    client = get_client()
    interaction = client.interactions.create(model=model["id"], input=text)
    audio = interaction.output_audio
    if not audio or not audio.data:
        raise RuntimeError("The music model returned no audio. Try a different description.")

    data = audio.data
    audio_bytes = base64.b64decode(data) if isinstance(data, str) else bytes(data)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "wb") as f:
        f.write(audio_bytes)
    return output_path, getattr(audio, "mime_type", None) or "audio/mpeg"


def clean_api_key(value: Optional[str]) -> str:
    """The key without the spaces or quote marks that a settings file or a shell can leave around it."""
    return (value or "").strip().strip("\"'").strip()


def get_client() -> genai.Client:
    """
    Returns a Google GenAI Client configured for either AI Studio (API key)
    or Vertex AI (GCP Project ID and Location).
    """
    provider = os.environ.get("API_PROVIDER", "AI_STUDIO")

    if provider == "VERTEX_AI":
        project_id = os.environ.get("VERTEX_PROJECT_ID")
        location = os.environ.get("VERTEX_LOCATION", "us-central1")
        if not project_id:
            raise ValueError("VERTEX_PROJECT_ID environment variable is not set.")
        return genai.Client(
            vertexai=True,
            project=project_id,
            location=location,
            http_options={"api_version": "v1beta1"},
        )
    else:
        api_key = clean_api_key(os.environ.get("GEMINI_API_KEY"))
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is not set.")
        return genai.Client(
            http_options={"api_version": "v1beta"},
            api_key=api_key,
        )


def _format_guideline(val: Optional[Union[List[str], str]]) -> str:
    """
    Formats list or string guidelines into a prompt string. There are no built-in defaults:
    an empty guideline means the user removed it, so it stays empty and is left out of the prompt.
    """
    if val is None or val == "" or val == []:
        return ""
    if isinstance(val, list):
        return ", ".join(str(item).strip() for item in val if item and str(item).strip())
    return str(val).strip()


def _parse_json_response(text: str) -> Any:
    """Parses a structured-output response, tolerating a ```json fence around it."""
    text = (text or "").strip()
    if text.startswith("```"):
        parts = text.split("```")
        if len(parts) >= 2:
            inner = parts[1]
            if inner.startswith("json"):
                inner = inner[4:]
            text = inner.strip()
    return json.loads(text)


# Asset Bible fields in prompt order, with the label used in every prompt. The look (camera,
# lighting, visual style) is not here: the sidebar guidelines already set it.
ASSET_BIBLE_FIELDS = (
    ("character", "Speaker"),
    ("hero_props", "Products and props"),
    ("setting", "Setting"),
    # Scenes are generated separately, so without one fixed description the voice changes between them.
    ("voice", "Voice"),
)


def asset_bible_lines(asset_bible: Optional[Dict[str, Any]]) -> List[str]:
    """
    The filled-in Asset Bible entries as 'Label: text' lines. The script writer and every scene's
    video prompt use these same lines, so a prop is described word for word the same everywhere.
    """
    ab = asset_bible if isinstance(asset_bible, dict) else {}
    lines = []
    for key, label in ASSET_BIBLE_FIELDS:
        text = str(ab.get(key) or "").strip()
        if text:
            lines.append(f"{label}: {text}")
    return lines


# How many pictures are looked at when the consistent details are written.
MAX_DETAIL_PICTURES = 7


# The two kinds of video. "creator": a person talks to the camera. "product": the product is shown
# (hands, close-ups) while a narrator who is never seen talks over it.
VIDEO_TYPE_CREATOR, VIDEO_TYPE_PRODUCT = "creator", "product"


def video_type_of(value: Any) -> str:
    return VIDEO_TYPE_PRODUCT if value == VIDEO_TYPE_PRODUCT else VIDEO_TYPE_CREATOR


# Added to every scene's video prompt of a product-led video.
PRODUCT_LED_SCENE_RULE = prompts.text("video.product_led")


def product_led_script_rules(video_type: Any) -> str:
    """What the script writer is told when the video is product-led ('' for a creator video)."""
    if video_type_of(video_type) != VIDEO_TYPE_PRODUCT:
        return ""
    return prompts.text("script_writer.product_led")


def product_name_rule(product_name: Optional[str]) -> str:
    """
    What the script writer and the details writer are told about the product's name. Without this,
    a brand name gets made up (e.g. "the Aura watch") and ends up spoken in the ad.
    """
    name = " ".join(str(product_name or "").split())
    if name:
        return prompts.render("product_name.given", name=name)
    return prompts.text("product_name.missing")


def asset_bible_prompt(
    idea: str, pictures: Optional[List[Dict[str, Any]]] = None, product_name: Optional[str] = None,
    video_type: Any = None,
) -> str:
    """
    The instruction for writing the Asset Bible. `pictures` are the attached pictures in order:
    [{"role": "speaker" | "reference", "description": str}].
    """
    picture_lines = []
    for number, picture in enumerate(pictures or [], start=1):
        if picture.get("role") == "speaker":
            described = "the person who speaks in the video."
        else:
            described = (picture.get("description") or "").strip() or "a product, prop or place shown in the video."
        picture_lines.append(f"- Picture {number}: {described}")
    return prompts.render(
        "asset_bible",
        idea=idea,
        product_name_rule=product_name_rule(product_name),
        pictures_section=prompts.render("asset_bible.pictures", picture_lines="\n".join(picture_lines)) if picture_lines else "",
        product_led_section=prompts.text("asset_bible.product_led") if video_type_of(video_type) == VIDEO_TYPE_PRODUCT else "",
    )


def extract_asset_bible(
    idea: str, llm_model: str, pictures: Optional[List[Dict[str, Any]]] = None, product_name: Optional[str] = None,
    video_type: Any = None,
) -> Dict[str, str]:
    """
    Writes an Asset Bible: one fixed, detailed description of the speaker, the products/props and
    the setting. Video models don't remember earlier scenes, so this exact text goes into every
    scene's prompt to keep things like a product's colour from drifting.

    `pictures` ([{"path", "role", "description"}]) are the creator photo and the product pictures.
    The descriptions are written from them: a description made up from the idea alone can
    contradict the photo, and the video model then switches to the described person.
    Raises on failure so the caller can show the error.
    """
    pictures = [p for p in (pictures or []) if p.get("path") and os.path.exists(p["path"])][:MAX_DETAIL_PICTURES]
    contents: List[Any] = []
    for picture in pictures:
        with open(picture["path"], "rb") as f:
            contents.append(types.Part.from_bytes(data=f.read(), mime_type=detect_image_mime(picture["path"])))
    contents.append(asset_bible_prompt(idea, pictures, product_name, video_type))
    client = get_client()  # kept in a variable: a dropped client can close its connection mid-request
    response = client.models.generate_content(
        model=llm_model,
        contents=contents,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=AssetBible,
            temperature=0.4,
        ),
    )
    data = _parse_json_response(response.text)
    return {key: str(data.get(key) or "").strip() for key, _ in ASSET_BIBLE_FIELDS}


def detect_image_mime(path: str) -> str:
    """Detects an image MIME type from the file header, falling back to the file extension."""
    try:
        with open(path, "rb") as f:
            header = f.read(12)
    except OSError:
        header = b""

    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"

    lower_path = path.lower()
    if lower_path.endswith(".png"):
        return "image/png"
    if lower_path.endswith(".webp"):
        return "image/webp"
    return "image/jpeg"


def upload_to_files_api(client: genai.Client, path: str, mime_type: Optional[str] = None, timeout_seconds: int = 180):
    """Uploads a local media file to the Gemini Files API and waits until it is ready to be referenced."""
    mime_type = mime_type or detect_image_mime(path)
    file_meta = client.files.upload(file=path, config={"mime_type": mime_type})

    deadline = time.monotonic() + timeout_seconds
    while file_meta.state is not None and file_meta.state.name == "PROCESSING":
        if time.monotonic() > deadline:
            raise TimeoutError(f"Timed out waiting for {os.path.basename(path)} to be processed by the Files API.")
        time.sleep(2)
        file_meta = client.files.get(name=file_meta.name)

    if file_meta.state is not None and file_meta.state.name == "FAILED":
        raise RuntimeError(f"The Files API could not process {os.path.basename(path)}.")

    return file_meta


def scene_audio_instruction(scene_audio: Optional[str]) -> str:
    """
    Audio line added to every scene prompt. Omni picks its own audio (often music) unless the prompt
    describes it, and separately generated scenes then get different music. In voice-only mode the
    scenes carry just the voice, and one music track is added over the whole video when stitching.
    """
    if (scene_audio or SCENE_AUDIO_VOICE_ONLY) == SCENE_AUDIO_VOICE_ONLY:
        return prompts.text("video.audio_voice_only")
    return ""


SILENT_SCENE_INSTRUCTION = prompts.text("video.silent_scene")


def scene_speech_rule(script: Optional[str]) -> str:
    """
    Extra line for a scene without a script. Left alone, the video model fills the silence by
    speaking anyway, often repeating a line it was given for the whole video.
    """
    return "" if (script or "").strip() else SILENT_SCENE_INSTRUCTION


# Two things generated product shots get wrong often enough to say every time.
REALISM_INSTRUCTION = prompts.text("video.realism")


# Left alone, Omni tends to split one generation into several shots (its docs say so). A scene here
# is one shot; cuts happen between scenes, where the app controls them.
SINGLE_SHOT_INSTRUCTION = prompts.text("video.single_shot")


def build_omni_generation_prompt(
    prompt: str,
    reference_descriptions: Optional[List[str]] = None,
    scene_audio: Optional[str] = None,
    has_end_frame: bool = False,
) -> str:
    """
    Builds the text part of an Omni generation request.

    The pictures are sent in this order: the first frame, the last frame (if any), then the
    reference pictures. Their roles are stated in plain language: the Omni docs deprecated the
    <FIRST_FRAME> / <IMAGE_REF_N> control tags.
    """
    refs = reference_descriptions or []
    lines = [prompt.strip(), "", SINGLE_SHOT_INSTRUCTION, REALISM_INSTRUCTION, "", "Picture 1 is the first frame of the video."]
    if has_end_frame:
        lines.append("Picture 2 is the last frame of the video: the video ends on it.")
    if refs:
        first_ref = 3 if has_end_frame else 2
        lines += ["", "The other pictures are references for how things look. Never show them as frames of the video:"]
        for i, description in enumerate(refs):
            text = (description or "").strip() or "Additional visual reference for this video."
            lines.append(f"- Picture {i + first_ref}: {text}")
    audio_line = scene_audio_instruction(scene_audio)
    if audio_line:
        lines += ["", audio_line]
    return "\n".join(lines)


EXTEND_INSTRUCTION = prompts.text("video.extend")


def build_omni_extend_prompt(prompt: str, scene_audio: Optional[str] = None) -> str:
    """Text of a request that continues the previous scene's video (see generate_scene_video)."""
    lines = [EXTEND_INSTRUCTION, "", prompt.strip(), "", "Keep it one continuous shot. No scene cuts.", REALISM_INSTRUCTION]
    audio_line = scene_audio_instruction(scene_audio)
    if audio_line:
        lines += ["", audio_line]
    return "\n".join(lines)


def generate_script_and_scenes(
    idea: str,
    num_scenes: int = 3,
    camera_specifics: Optional[Union[str, List[str]]] = None,
    lighting_restraints: Optional[Union[str, List[str]]] = None,
    relatable_action: Optional[Union[str, List[str]]] = None,
    script_tone: Optional[Union[str, List[str]]] = None,
    visual_consistency: Optional[Union[str, List[str]]] = None,
    audio_consistency: Optional[Union[str, List[str]]] = None,
    accent: Optional[str] = None,
    llm_model: str = "gemini-2.5-pro",
    hook_style: str = "Auto-Select",
    custom_hook_desc: str = "",
    target_words_per_scene: int = 20,
    context_image_descriptions: Optional[List[str]] = None,
    asset_bible: Optional[Dict[str, str]] = None,
    structure: Optional[Dict[str, Any]] = None,
    product_name: Optional[str] = None,
    video_type: Any = None,
) -> Dict[str, Any]:
    """
    Writes the video context and the scenes from a user idea.

    `structure` is the breakdown of a reference video (see analyse_reference_video) without its
    spoken words: the script then follows it part by part and has as many scenes as it has parts.

    Returns {"video_context": str, "scenes": [scene dicts]}.
    The guidelines come only from the user (the Idea page). Nothing is added when one is empty.
    """
    client = get_client()

    camera_specifics_str = _format_guideline(camera_specifics)
    lighting_restraints_str = _format_guideline(lighting_restraints)
    relatable_action_str = _format_guideline(relatable_action)
    script_tone_str = _format_guideline(script_tone)
    visual_consistency_str = _format_guideline(visual_consistency)
    audio_consistency_str = _format_guideline(audio_consistency)
    accent_str = _format_guideline(accent)

    guideline_lines = "\n".join(
        f"- {label}: {value}"
        for label, value in (
            ("Camera", camera_specifics_str),
            ("Lighting", lighting_restraints_str),
            ("Action & Performance", relatable_action_str),
            ("Script Tone", script_tone_str),
            ("Visual Style", visual_consistency_str),
            ("Audio & Delivery", audio_consistency_str),
            ("Speaker Accent", accent_str),
        )
        if value
    )

    hook_frameworks = prompts.text("script_writer.hook_frameworks")
    if hook_style == "Auto-Select":
        hook_instruction = prompts.render("script_writer.hook_auto", hook_frameworks=hook_frameworks)
    elif hook_style == "Custom Hook":
        hook_instruction = prompts.render("script_writer.hook_custom", custom_hook=custom_hook_desc)
    else:
        hook_instruction = prompts.render("script_writer.hook_named", hook_style=hook_style, hook_frameworks=hook_frameworks)

    context_descriptions = [d.strip() for d in (context_image_descriptions or []) if d and d.strip()]
    context_pictures_section = prompts.render(
        "script_writer.context_pictures", context_lines="\n".join(f"- {d}" for d in context_descriptions)
    ) if context_descriptions else ""

    bible_lines = asset_bible_lines(asset_bible)
    asset_bible_section = prompts.render(
        "script_writer.asset_bible", bible_text="\n".join(f"- {line}" for line in bible_lines)
    ) if bible_lines else ""

    structure_scenes = [
        sc for sc in ((structure or {}).get("scenes") or [])
        if isinstance(sc, dict) and (str(sc.get("purpose") or "").strip() or str(sc.get("happens") or "").strip())
    ][:10]
    if structure_scenes:
        num_scenes = len(structure_scenes)
        part_lines = []
        for n, sc in enumerate(structure_scenes, start=1):
            bits = [f"Job: {str(sc.get('purpose') or '').strip() or 'not given'}"]
            if str(sc.get("happens") or "").strip():
                bits.append(f"In the reference: {str(sc['happens']).strip()}")
            if str(sc.get("framing") or "").strip():
                bits.append(f"Filmed as: {str(sc['framing']).strip()}")
            part_lines.append(f"- Scene {n}. " + " | ".join(bits))
        extra = []
        if str((structure or {}).get("pacing") or "").strip():
            extra.append(f"Rhythm: {str(structure['pacing']).strip()}")
        if str((structure or {}).get("call_to_action") or "").strip():
            extra.append(f"How it closes: {str(structure['call_to_action']).strip()}")
        structure_section = prompts.render(
            "script_writer.structure", part_lines="\n".join(part_lines), extra_lines="\n".join(extra)
        )
    else:
        structure_section = ""

    prompt = prompts.render(
        "script_writer",
        idea=idea,
        product_name_rule=product_name_rule(product_name),
        product_led_rules=product_led_script_rules(video_type),
        context_pictures_section=context_pictures_section,
        asset_bible_section=asset_bible_section,
        structure_section=structure_section,
        hook_instruction=hook_instruction,
        num_scenes=num_scenes,
        target_words_per_scene=target_words_per_scene,
        guideline_lines=guideline_lines,
    )

    response = client.models.generate_content(
        model=llm_model,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=SceneList,
            temperature=0.7,
        ),
    )

    data = _parse_json_response(response.text)
    return {
        "video_context": str(data.get("video_context") or "").strip(),
        "scenes": data.get("scenes", []),
    }


REFERENCE_MAX_PARTS = 10


def analyse_reference_video(video_path: str, mime_type: str = "video/mp4") -> Dict[str, Any]:
    """
    Watches a reference ad (e.g. a competitor's video that works) and returns its structure as a
    ReferenceBreakdown dict: hook, the parts it is made of, pacing, captions, music mood, call to
    action and style tags. Adds `seconds` (length of the video) and `wordsPerSecond` (speaking pace).

    Only the structure is used later. The transcript is shown to the user and never sent to the
    script writer; no frame of the video is ever used as a picture.
    """
    client = get_client()
    video_file = upload_to_files_api(client, video_path, mime_type, timeout_seconds=300)
    prompt = prompts.render("reference_breakdown", max_parts=REFERENCE_MAX_PARTS)
    response = client.models.generate_content(
        model=REFERENCE_MODEL_ID,
        contents=[video_file, prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ReferenceBreakdown,
            temperature=0.2,
        ),
    )
    data = ReferenceBreakdown.model_validate(_parse_json_response(response.text)).model_dump()
    data["scenes"] = data["scenes"][:REFERENCE_MAX_PARTS]
    for key, tags in data["style"].items():
        data["style"][key] = [str(t).strip()[:80] for t in tags if str(t).strip()][:3]

    try:
        seconds = float(probe_media(video_path).get("duration") or 0.0)
    except Exception:
        seconds = 0.0
    if seconds <= 0 and data["scenes"]:
        seconds = float(data["scenes"][-1]["end"])
    spoken_words = sum(len(_words(sc["said"])) for sc in data["scenes"])
    spoken_seconds = sum(max(0.0, sc["end"] - sc["start"]) for sc in data["scenes"] if sc["said"].strip())
    data["seconds"] = round(seconds, 1)
    data["wordsPerSecond"] = round(spoken_words / spoken_seconds, 2) if spoken_seconds > 0 else 0.0
    return data


def _words(text: str) -> List[str]:
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def speech_match(script: str, spoken: str) -> float:
    """How closely what was said follows the script, from 0 to 1 (word order matters, punctuation doesn't)."""
    a, b = _words(script), _words(spoken)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return round(difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), 3)


# Below this, the take is flagged as not saying the script.
SPEECH_MATCH_THRESHOLD = 0.85


def _image_part(path: str):
    with open(path, "rb") as f:
        return types.Part.from_bytes(data=f.read(), mime_type=detect_image_mime(path))


def take_check_photo_rule(has_photo: bool) -> str:
    """The extra line of the take check when the creator photo is attached."""
    if not has_photo:
        return ""
    return prompts.text("take_check.photo_rule")


def check_take(
    video_path: str,
    script: str,
    asset_lines: Optional[List[str]] = None,
    picture_descriptions: Optional[List[str]] = None,
    voice_only: bool = True,
    person_photo_path: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Watches a finished take and reports clear problems, so a bad take is noticed without watching it
    closely: speech that doesn't follow the script, a product or speaker that doesn't match the
    consistent details, deformed hands, garbled text, a jarring cut, unwanted music.

    person_photo_path: the creator photo. With it, a face that is clearly not the person in the
    photo is reported too: a description in words cannot catch that, and it happens when a scene
    starts on a frame that shows only part of the face.

    Returns {"ok", "spokenText", "speechMatch", "issues": [{"kind", "detail"}]}. Raises on API errors.
    """
    client = get_client()
    video_file = upload_to_files_api(client, video_path, "video/mp4", timeout_seconds=120)
    has_photo = bool(person_photo_path and os.path.exists(person_photo_path))

    details = "\n".join(f"- {line}" for line in (asset_lines or [])) or "(none given)"
    pictures = "\n".join(f"- {d}" for d in (picture_descriptions or []) if d) or "(none given)"
    prompt = prompts.render(
        "take_check",
        script=script,
        details=details,
        pictures=pictures,
        photo_rule=take_check_photo_rule(has_photo),
        audio_rule=(
            "background music or a soundtrack (the clip must have the voice and room sound only)"
            if voice_only else "loud noise or distorted sound"
        ),
    )
    response = client.models.generate_content(
        model=TAKE_CHECK_MODEL_ID,
        contents=[video_file] + ([_image_part(person_photo_path)] if has_photo else []) + [prompt],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=TakeCheckResult,
            temperature=0.1,
        ),
    )
    data = _parse_json_response(response.text)
    spoken = str(data.get("spoken_text") or "").strip()
    issues = [
        {"kind": str(i.get("kind") or "other"), "detail": str(i.get("detail") or "").strip()}
        for i in (data.get("issues") or [])
        if isinstance(i, dict) and str(i.get("detail") or "").strip()
    ]
    match = speech_match(script, spoken)
    if _words(script) and match < SPEECH_MATCH_THRESHOLD:
        issues.insert(0, {
            "kind": "script",
            "detail": "What is said differs from the script." if spoken else "Nobody speaks, but the scene has a script.",
        })
    return {"ok": not issues, "spokenText": spoken, "speechMatch": match, "issues": issues[:8]}


class GenerationCancelled(Exception):
    """The user cancelled the take while it was being made."""


# How often a running video request is checked, and how long it may run before it is given up on.
VIDEO_POLL_SECONDS = 5
VIDEO_TIMEOUT_SECONDS = 20 * 60
_FINISHED_STATUSES = {"completed", "failed", "cancelled", "incomplete"}


def _status_of(interaction: Any) -> str:
    status = getattr(interaction, "status", None)
    return str(getattr(status, "value", status) or "").lower()


def _background_rejected(err: Exception) -> bool:
    """Whether the API refused the request because the model doesn't support background mode."""
    return "background" in str(err).lower()


def _run_video_interaction(
    client: Any,
    request: Dict[str, Any],
    on_started: Optional[Callable[[str], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Any:
    """
    Starts a video request in background mode and waits for it, so it can be stopped while it runs:
    the interaction ID is passed to on_started straight away, and if should_cancel() turns true the
    interaction is cancelled at Google and GenerationCancelled is raised.

    Falls back to a blocking request if the model rejects background mode; a cancel then only takes
    effect once the video is back (the result is thrown away).
    """
    def cancelled() -> bool:
        return bool(should_cancel and should_cancel())

    if cancelled():
        raise GenerationCancelled()

    try:
        interaction = client.interactions.create(**request, background=True)
    except Exception as e:
        if not _background_rejected(e):
            raise
        logger.warning("Video model rejected background mode (%s). Using a blocking request; cancel will discard the result.", e)
        interaction = client.interactions.create(**request)
        if on_started and interaction.id:
            on_started(interaction.id)
        if cancelled():
            raise GenerationCancelled()
        return interaction

    if on_started and interaction.id:
        on_started(interaction.id)

    deadline = time.monotonic() + VIDEO_TIMEOUT_SECONDS
    poll_errors = 0
    while _status_of(interaction) not in _FINISHED_STATUSES:
        if cancelled():
            try:
                client.interactions.cancel(id=interaction.id)
            except Exception as e:  # The cancel endpoint may already have stopped it.
                logger.info("Cancel of interaction %s: %s", interaction.id, e)
            raise GenerationCancelled()
        if time.monotonic() > deadline:
            try:
                client.interactions.cancel(id=interaction.id)
            except Exception:
                pass
            raise TimeoutError(f"The video took longer than {VIDEO_TIMEOUT_SECONDS // 60} minutes and was stopped. Try again.")
        time.sleep(VIDEO_POLL_SECONDS)
        try:
            interaction = client.interactions.get(id=interaction.id)
            poll_errors = 0
        except Exception as e:
            poll_errors += 1
            logger.warning("Checking interaction %s failed (%d in a row): %s", interaction.id, poll_errors, e)
            if poll_errors >= 5:
                raise

    status = _status_of(interaction)
    if status == "cancelled":
        raise GenerationCancelled()
    if status != "completed":
        detail = getattr(interaction, "error", None) or status
        raise Exception(f"The video model could not make this video ({detail}).")
    return interaction


def generate_scene_video(
    prompt: str,
    image_path: str,
    output_path: str,
    aspect_ratio: str = "9:16",
    duration_seconds: int = 8,
    resolution: str = "1080p",
    video_model: Optional[str] = None,
    edit_prompt: Optional[str] = None,
    previous_interaction_id: Optional[str] = None,
    reference_images: Optional[List[Dict[str, Any]]] = None,
    scene_audio: Optional[str] = None,
    on_started: Optional[Callable[[str], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    end_image_path: Optional[str] = None,
    extend_interaction_id: Optional[str] = None,
) -> Tuple[str, Optional[str], str]:
    """
    Generates a video for a scene with the given model (see model_registry.VIDEO_MODELS).

    Three kinds of request:
    - previous_interaction_id + edit_prompt: refine that take.
    - extend_interaction_id: continue the video of that interaction (the previous scene's take) in
      the same shot. The model returns the earlier video WITH the new part appended, so the caller
      cuts the earlier part off (trim_video_start). image_path and pictures are not used.
    - otherwise: a new video from image_path, ending on end_image_path if given.

    reference_images: optional list of {"path": local_image_path, "description": str}, sent after
    the first (and last) frame.
    on_started / should_cancel: see _run_video_interaction. Raises GenerationCancelled when cancelled.

    Returns (output_path, interaction_id, prompt_text_sent_to_the_model).
    """
    model = get_video_model(video_model)
    video_model = model["id"]
    if model["provider"] != "omni":
        raise ValueError(f"No generator for video model provider '{model['provider']}'.")

    client = get_client()

    references = [r for r in (reference_images or []) if r.get("path") and os.path.exists(r["path"])]

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    video_config = {
        "type": "video",
        "delivery": "uri",
        "aspect_ratio": aspect_ratio,
        "duration": f"{duration_seconds}s",
        "resolution": resolution
    }

    if previous_interaction_id and edit_prompt:
        # Refining a previous attempt: the earlier turn already holds the starting frame and references.
        audio_line = scene_audio_instruction(scene_audio)
        sent_prompt = f"{edit_prompt}\n\n{audio_line}" if audio_line else edit_prompt
        interaction = _run_video_interaction(client, {
            "model": video_model,
            "input": [{"type": "text", "text": sent_prompt}],
            "previous_interaction_id": previous_interaction_id,
            "response_format": video_config,
        }, on_started, should_cancel)
    elif extend_interaction_id:
        sent_prompt = build_omni_extend_prompt(prompt, scene_audio=scene_audio)
        interaction = _run_video_interaction(client, {
            "model": video_model,
            "input": [{"type": "text", "text": sent_prompt}],
            "previous_interaction_id": extend_interaction_id,
            "response_format": video_config,
        }, on_started, should_cancel)
    else:
        # Order matters, the prompt names the pictures by position: first frame, last frame, references.
        has_end_frame = bool(end_image_path and os.path.exists(end_image_path))
        frames = [image_path] + ([end_image_path] if has_end_frame else [])
        input_parts = []
        for path in frames + [ref["path"] for ref in references]:
            meta = upload_to_files_api(client, path)
            input_parts.append({"type": "image", "uri": meta.uri, "mime_type": meta.mime_type})

        sent_prompt = build_omni_generation_prompt(
            prompt, [r.get("description", "") for r in references], scene_audio=scene_audio,
            has_end_frame=has_end_frame,
        )
        input_parts.append({"type": "text", "text": sent_prompt})
        logger.info("Omni request: %d frame(s) + %d reference picture(s).", len(frames), len(references))

        interaction = _run_video_interaction(client, {
            "model": video_model,
            "input": input_parts,
            "response_format": video_config,
        }, on_started, should_cancel)

    output_video = interaction.output_video
    if not output_video or not output_video.uri:
        raise Exception(f"No video content found in response for '{prompt}'.")

    video_bytes = client.files.download(file=output_video.uri)
    with open(output_path, "wb") as f:
        f.write(video_bytes)

    return output_path, interaction.id, sent_prompt


def trim_video_start(video_path: str, output_path: str, seconds: float) -> str:
    """Cuts the first `seconds` off a video (re-encoded, so the cut is exact to the frame)."""
    _run_ffmpeg([
        "ffmpeg", "-y", "-v", "error", "-ss", f"{seconds:.3f}", "-i", video_path,
        "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output_path,
    ], "cutting the earlier scene off the continued video")
    return output_path


def generate_cut_still(
    frame_path: str,
    output_path: str,
    scene_description: str,
    aspect_ratio: str = "9:16",
    reference_images: Optional[List[Dict[str, Any]]] = None,
    asset_lines: Optional[List[str]] = None,
) -> str:
    """
    The first frame of a scene that cuts to a new camera position: the image model redraws the last
    frame of the previous scene from another angle, posed for what this scene shows. Same person,
    products and room, which a fresh start from the creator photo would lose.

    reference_images: [{"path", "description"}], e.g. product pictures, so labels stay exact.
    """
    def image_part(path: str):
        with open(path, "rb") as f:
            return types.Part.from_bytes(data=f.read(), mime_type=detect_image_mime(path))

    references = [r for r in (reference_images or []) if r.get("path") and os.path.exists(r["path"])]
    lines = [
        "Picture 1 is the last frame of a video scene. Make the first frame of the NEXT scene, which "
        "cuts to a different camera position: clearly re-framed (closer or wider, and from another "
        "angle), as if the phone was moved between two takes.",
        "",
        f"What the next scene shows: {(scene_description or '').strip() or 'the same person, continuing to talk to the camera.'}",
        "",
        "Keep exactly the same person (face, hair, clothes, jewellery), the same products with their "
        "exact shape, colours and label text, the same room and the same light. A photorealistic "
        "frame from a phone video: no captions, no text overlays, no borders.",
    ]
    if asset_lines:
        lines += ["", "Details that must not change:"] + [f"- {line}" for line in asset_lines]
    if references:
        lines += ["", "The other pictures are references for how things look:"]
        for i, ref in enumerate(references):
            text = (ref.get("description") or "").strip() or "Additional visual reference."
            lines.append(f"- Picture {i + 2}: {text}")

    contents: List[Any] = [image_part(frame_path)] + [image_part(r["path"]) for r in references]
    contents.append("\n".join(lines))
    client = get_client()  # kept in a variable: a dropped client closes its connection mid-request
    response = client.models.generate_content(
        model=STILL_MODEL_ID,
        contents=contents,
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=types.ImageConfig(aspect_ratio=aspect_ratio),
        ),
    )
    candidates = response.candidates or []
    parts = (candidates[0].content.parts if candidates and candidates[0].content else None) or []
    for part in parts:
        inline = getattr(part, "inline_data", None)
        if inline is not None and inline.data:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            with open(output_path, "wb") as f:
                f.write(inline.data)
            return output_path
    raise RuntimeError("The image model returned no picture for the camera cut.")


def extract_last_frame(video_path: str, output_image_path: str) -> str:
    """Extracts the sharpest frame from the final portion of the video to avoid blurry transitions."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception(f"Failed to open video file {video_path}")

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Analyze the last 15 frames to find the sharpest one (highest Laplacian variance)
    # This prevents using a blurry, half-generated, or heavily compressed final frame.
    lookback = min(15, total_frames)
    best_frame = None
    best_sharpness = -1.0

    start_frame = max(0, total_frames - lookback)
    for i in range(start_frame, total_frames):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ret, frame = cap.read()
        if not ret or frame is None:
            continue

        # Calculate sharpness using the variance of the Laplacian
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()

        if sharpness > best_sharpness:
            best_sharpness = sharpness
            best_frame = frame

    os.makedirs(os.path.dirname(os.path.abspath(output_image_path)), exist_ok=True)

    if best_frame is not None:
        cv2.imwrite(output_image_path, best_frame)
    else:
        # Fallback to standard last frame if something goes wrong
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, total_frames - 1))
        ret, frame = cap.read()
        if ret and frame is not None:
            cv2.imwrite(output_image_path, frame)
        else:
            cap.release()
            raise Exception("Failed to extract any readable frame from the video.")

    cap.release()
    return output_image_path


def generate_camera_cut_variation(image_path: str, output_path: str) -> str:
    """
    Simulates a camera cut variation using CV2 zoom and crop.
    Zooms by 15% and shifts center slightly to simulate a natural jump cut.
    """
    img = cv2.imread(image_path)
    if img is None:
        raise Exception(f"Failed to read image for variation: {image_path}")

    h, w = img.shape[:2]
    # Zoom by 15%
    zoom_factor = 1.15
    new_h, new_w = int(h / zoom_factor), int(w / zoom_factor)

    # Shift slightly down and right to simulate a jump cut
    start_y = int((h - new_h) * 0.7)  # biased towards bottom
    start_x = int((w - new_w) * 0.8)  # biased towards right

    cropped = img[start_y:start_y + new_h, start_x:start_x + new_w]
    resized = cv2.resize(cropped, (w, h), interpolation=cv2.INTER_CUBIC)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    cv2.imwrite(output_path, resized)
    return output_path


def _run_ffmpeg(cmd: List[str], what: str, cwd: Optional[str] = None) -> str:
    """Runs ffmpeg and returns its stderr (where filters like loudnorm print their measurements)."""
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, cwd=cwd)
    stderr_output = result.stderr.decode("utf-8", errors="replace")
    if result.returncode != 0:
        raise RuntimeError(f"{what} failed (exit code {result.returncode}): {stderr_output[-3000:]}")
    return stderr_output


def probe_media(path: str) -> Dict[str, Any]:
    """Duration (seconds, of the video stream when there is one) and whether the file has audio."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration",
        "-of", "json", path,
    ]
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"Could not read {os.path.basename(path)}: {result.stderr.decode('utf-8', 'replace')[-500:]}")
    info = json.loads(result.stdout or b"{}")
    streams = info.get("streams") or []
    video_durations = [float(s["duration"]) for s in streams if s.get("codec_type") == "video" and s.get("duration")]
    duration = video_durations[0] if video_durations else float((info.get("format") or {}).get("duration") or 0)
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    return {
        "duration": duration,
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
        "width": video.get("width"),
        "height": video.get("height"),
        "video_codec": video.get("codec_name"),
        "fps": _frame_rate(video.get("r_frame_rate")),
    }


def _frame_rate(value: Any) -> Optional[float]:
    """'24000/1001' -> 23.976. None when unknown or implausible."""
    try:
        top, _, bottom = str(value).partition("/")
        rate = float(top) / float(bottom or 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return rate if 10 <= rate <= 120 else None


def check_clips_match(clips: List[Dict[str, Any]], labels: Optional[List[str]] = None) -> None:
    """
    The picture is joined without re-encoding, which only works when every clip has the same size
    and codec. Takes made before a change of resolution or aspect ratio don't, and would give a
    broken video, so say which scenes to redo instead.
    """
    def shape(clip: Dict[str, Any]):
        return (clip.get("width"), clip.get("height"), clip.get("video_codec"))

    def describe(clip: Dict[str, Any]) -> str:
        return f"{clip.get('width')}x{clip.get('height')}"

    names = labels or [f"Clip {i + 1}" for i in range(len(clips))]
    known = [(names[i], c) for i, c in enumerate(clips) if c.get("width") and c.get("height")]
    if len({shape(c) for _, c in known}) < 2:
        return
    listed = ", ".join(f"{name} ({describe(c)})" for name, c in known)
    raise ValueError(
        f"The scenes don't all have the same picture size: {listed}. Some takes were made with other "
        "video settings. Make new takes so every scene uses the current settings, then stitch again."
    )


# Music volume relative to the voice (after both are leveled). The music is also ducked under speech.
MUSIC_VOLUMES = {"low": 0.12, "medium": 0.2, "high": 0.32}
MUSIC_VOLUME_MAX_PERCENT = 100


def music_volume_factor(value: Any) -> float:
    """
    How loud the music is mixed, as a factor on its leveled signal. `value` is "low" / "medium" /
    "high" (older projects) or a number from 0 to 100 from the volume slider, where 40 equals
    "medium". Anything else means "medium".
    """
    if isinstance(value, str) and value in MUSIC_VOLUMES:
        return MUSIC_VOLUMES[value]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return MUSIC_VOLUMES["medium"]
    return round(max(0.0, min(float(MUSIC_VOLUME_MAX_PERCENT), float(value))) / 200.0, 4)


# --- manual edits of a scene in the final video (the editor on the Video step) ---
MIN_EDIT_SECONDS = 0.3
MAX_SCENE_VOLUME = 2.0


def apply_scene_edit(
    duration: float, auto_start: float, auto_end: float, edit: Optional[Dict[str, Any]]
) -> Tuple[float, float]:
    """
    The part of a clip that is kept. An edit's "start"/"end" (seconds in the clip) replace the
    automatic trim; a missing or unusable one leaves that side automatic.
    """
    start, end = auto_start, auto_end
    if isinstance(edit, dict):
        s, e = _as_float(edit.get("start")), _as_float(edit.get("end"))
        if s is not None:
            start = max(0.0, min(duration, s))
        if e is not None:
            end = max(0.0, min(duration, e))
        if end - start < MIN_EDIT_SECONDS - 1e-6:   # tolerance: 5 - 4.7 is a hair under 0.3
            return auto_start, auto_end
    return start, end


def scene_volume_db(edit: Optional[Dict[str, Any]]) -> float:
    """Extra gain for a scene's voice from the editor's volume (1 = unchanged, 0.5 = half, 2 = double)."""
    volume = _as_float((edit or {}).get("volume")) if isinstance(edit, dict) else None
    if volume is None or volume <= 0:
        return 0.0
    return round(20.0 * math.log10(min(MAX_SCENE_VOLUME, max(0.05, volume))), 2)

# --- sound effects placed in the editor ---
SOUND_DEFAULT_PERCENT = 60
SOUND_START_SLACK = 0.01   # a hair before the kept start still counts as the start (places are saved to 0.01s)
SOUND_PEAK_DB = -3.0   # every effect is brought to this peak, then turned down by its volume


def sound_volume_factor(value: Any) -> float:
    """An effect's volume from the editor (0 to 100) as a factor on its leveled signal."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        value = SOUND_DEFAULT_PERCENT
    return round(max(0.0, min(100.0, float(value))) / 100.0, 3)


def place_sounds(clips: List[Dict[str, Any]], sounds: Optional[List[Dict[str, Any]]], has_end_card: bool = False) -> List[Dict[str, Any]]:
    """
    When each sound effect starts in the finished video. A sound is pinned to a moment of a scene's
    clip ({"clip": index, "at": seconds in that clip's file}) so it stays on the same frame however
    the scenes are trimmed; {"clip": "end"} pins it to the end card. `clips` are the clips as cut
    (trim_start, duration), the end card last when there is one. A sound whose moment was cut away,
    or whose scene is not in the video, is left out. Returns the kept sounds with "time" added.
    """
    starts, at = [], 0.0
    for clip in clips:
        starts.append(at)
        at += max(0.05, float(clip["duration"]))
    scene_count = len(clips) - (1 if has_end_card else 0)
    placed = []
    for sound in sounds or []:
        moment = _as_float(sound.get("at"))
        if moment is None or moment < 0:
            continue
        index = sound.get("clip")
        if index == "end":
            index = len(clips) - 1 if has_end_card else None
        elif isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < scene_count:
            index = None
        if index is None:
            continue
        clip = clips[index]
        t0, d = float(clip.get("trim_start") or 0.0), max(0.05, float(clip["duration"]))
        if not t0 - SOUND_START_SLACK <= moment < t0 + d:
            continue
        placed.append({**sound, "time": round(starts[index] + max(0.0, moment - t0), 3)})
    return placed


def measure_peak_db(path: str) -> Optional[float]:
    """The loudest peak of an audio file in dBFS, or None when it is silent or cannot be read."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as e:
        logger.warning("Could not measure the peak of %s: %s", path, e)
        return None
    match = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?) dB", result.stderr or "")
    peak = float(match.group(1)) if match else None
    return peak if peak is not None and peak > SILENCE_LUFS else None


CUT_FADE_SECONDS = 0.03      # tiny fade at every cut, so scene audio never clicks or jumps
SCENE_LOUDNESS_LUFS = -16.0  # every scene (and the music) is leveled to this before mixing
FINAL_LOUDNESS_LUFS = -14.0  # usual target for TikTok / Reels / Shorts
FINAL_TRUE_PEAK_DB = -1.5
SILENCE_LUFS = -60.0         # quieter than this counts as silence: no gain is applied
MAX_GAIN_DB = 20.0           # never boost or cut a scene by more than this
ROOM_TONE_AMPLITUDE = 0.007 # constant, barely audible background under the whole video

# Tightened cuts: dead air before the first word and after the last one is cut, within these limits.
LEAD_KEEP_SECONDS = 0.15     # kept before the first word
TAIL_KEEP_SECONDS = 0.30     # kept after the last word
MAX_TRIM_START_SECONDS = 1.0
MAX_TRIM_END_SECONDS = 1.5
MIN_CLIP_SECONDS = 1.0       # a clip is never trimmed shorter than this


def detect_speech(path: str, duration: float, loudness: Optional[float]) -> List[Tuple[float, float]]:
    """
    The stretches of a clip where something is heard, as (start, end) in seconds. Uses ffmpeg's
    silencedetect with a threshold relative to the clip's own loudness. Empty when nothing is heard.
    """
    if not duration or loudness is None:
        return []
    threshold = max(-55.0, min(-30.0, loudness - 22.0))
    stderr = _run_ffmpeg(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-map", "0:a:0",
         "-af", f"silencedetect=noise={threshold:.1f}dB:d=0.22", "-f", "null", "-"],
        f"Finding the speech in {os.path.basename(path)}",
    )
    silences: List[Tuple[float, float]] = []
    start: Optional[float] = None
    for match in re.finditer(r"silence_(start|end):\s*(-?[0-9.]+)", stderr):
        value = max(0.0, float(match.group(2)))
        if match.group(1) == "start":
            start = value
        elif start is not None:
            silences.append((start, value))
            start = None
    if start is not None:
        silences.append((start, duration))

    speech: List[Tuple[float, float]] = []
    cursor = 0.0
    for a, b in silences:
        if a - cursor > 0.05:
            speech.append((cursor, min(a, duration)))
        cursor = max(cursor, b)
    if duration - cursor > 0.05:
        speech.append((cursor, duration))
    return speech


def plan_trim(duration: float, speech: List[Tuple[float, float]], tight: bool) -> Tuple[float, float]:
    """(start, end) of the part of a clip that is kept. The whole clip when there is nothing to cut."""
    if not tight or not speech or duration < MIN_CLIP_SECONDS:
        return 0.0, duration
    start, end = 0.0, duration
    lead = speech[0][0]
    tail = duration - speech[-1][1]
    if lead > LEAD_KEEP_SECONDS + 0.15:
        start = min(lead - LEAD_KEEP_SECONDS, MAX_TRIM_START_SECONDS)
    if tail > TAIL_KEEP_SECONDS + 0.15:
        end = max(duration - MAX_TRIM_END_SECONDS, speech[-1][1] + TAIL_KEEP_SECONDS)
    if end - start < MIN_CLIP_SECONDS:
        return 0.0, duration
    return start, end


def _loudnorm_stats(stderr_output: str) -> Optional[Dict[str, str]]:
    """The JSON block loudnorm prints with print_format=json."""
    match = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr_output, re.S)
    return json.loads(match.group(0)) if match else None


def _as_float(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def measure_loudness(path: str, duration: Optional[float] = None, loop: bool = False) -> Optional[Dict[str, str]]:
    """
    Integrated loudness (EBU R128) of a file's audio, measured with loudnorm. Returns loudnorm's
    stats, or None when the file has no measurable sound. `loop` + `duration` measure a short music
    track the way it will be used (looped to the video's length).
    """
    cmd = ["ffmpeg", "-hide_banner", "-nostats"]
    if loop:
        cmd += ["-stream_loop", "-1"]
    cmd += ["-i", path]
    if duration:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-map", "0:a:0", "-af", "loudnorm=print_format=json", "-f", "null", "-"]
    stats = _loudnorm_stats(_run_ffmpeg(cmd, f"Measuring the loudness of {os.path.basename(path)}"))
    loudness = _as_float((stats or {}).get("input_i"))
    if loudness is None or loudness < SILENCE_LUFS:
        return None
    return stats


def _gain_to(target_lufs: float, stats: Optional[Dict[str, str]]) -> float:
    """Fixed gain (dB) that brings measured audio to the target loudness. 0 for silence."""
    loudness = _as_float((stats or {}).get("input_i"))
    if loudness is None:
        return 0.0
    return max(-MAX_GAIN_DB, min(MAX_GAIN_DB, target_lufs - loudness))


def build_stitch_audio_filter(
    clips: List[Dict[str, Any]],
    music_input_index: Optional[int] = None,
    music_volume: Any = "medium",
    music_gain_db: float = 0.0,
    room_tone: bool = False,
    music_start: float = 0.0,
    music_tempo: float = 1.0,
    sounds: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, float]:
    """
    ffmpeg filter graph for the stitched audio, before the final loudness pass.
    Input i is clip i (each clip dict has duration, has_audio and gain_db, plus trim_start when the
    clip's start is cut); music is its own input. `room_tone` adds a very quiet, constant background
    under everything so the silence between scenes doesn't drop to dead air.
    `music_tempo` plays the music slightly faster or slower and `music_start` then skips that many
    seconds of it, so its beats land on the cuts (see app.beats).
    `sounds` are the editor's sound effects: [{"input_index", "time" (seconds into the video),
    "gain_db", "volume" (0 to 100)}], each mixed in at its moment, on top of the voice and music.
    Returns (filter_complex, total_duration). The output label is [aout].
    """
    parts: List[str] = []
    labels: List[str] = []
    total = 0.0
    for i, clip in enumerate(clips):
        d = max(0.05, float(clip["duration"]))
        t0 = max(0.0, float(clip.get("trim_start") or 0.0))
        total += d
        fade = min(CUT_FADE_SECONDS, d / 4)
        if clip["has_audio"]:
            # Pad/trim to the picture's length so every cut stays in sync, then level with a fixed gain.
            src = (
                f"[{i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,"
                f"atrim={t0:.3f}:{t0 + d:.3f},asetpts=PTS-STARTPTS,volume={clip.get('gain_db', 0.0):.2f}dB,"
            )
        else:
            # No audio in this scene: silence of the same length.
            src = f"anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp,atrim=0:{d:.3f},asetpts=PTS-STARTPTS,"
        parts.append(f"{src}afade=t=in:st=0:d={fade:.3f},afade=t=out:st={d - fade:.3f}:d={fade:.3f}[s{i}]")
        labels.append(f"[s{i}]")

    parts.append(f"{''.join(labels)}concat=n={len(clips)}:v=0:a=1[voice]")
    final_in = "[voice]"

    if music_input_index is not None:
        vol = music_volume_factor(music_volume)
        fade_in = min(0.5, total / 4)
        fade_out = min(1.5, total / 3)
        tempo = f"atempo={music_tempo:.4f}," if abs(music_tempo - 1.0) > 1e-4 else ""
        parts.append(
            f"[{music_input_index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"{tempo}atrim={music_start:.3f}:{music_start + total:.3f},asetpts=PTS-STARTPTS,"
            f"volume={music_gain_db:.2f}dB,volume={vol},"
            f"afade=t=in:st=0:d={fade_in:.3f},afade=t=out:st={max(0.0, total - fade_out):.3f}:d={fade_out:.3f}[music]"
        )
        # Ducking: the voice drives a compressor on the music, so the music dips while someone talks.
        parts.append("[voice]asplit=2[vmain][vkey]")
        parts.append("[music][vkey]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350[ducked]")
        parts.append("[vmain][ducked]amix=inputs=2:duration=first:normalize=0[mix]")
        final_in = "[mix]"

    heard = [s for s in sounds or [] if sound_volume_factor(s.get("volume")) > 0 and float(s["time"]) < total]
    if heard:
        for n, sound in enumerate(heard):
            delay = int(round(max(0.0, float(sound["time"])) * 1000))
            parts.append(
                f"[{sound['input_index']}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"volume={float(sound.get('gain_db') or 0.0):.2f}dB,volume={sound_volume_factor(sound.get('volume'))},"
                f"adelay={delay}:all=1[fx{n}]"
            )
        fx = "".join(f"[fx{n}]" for n in range(len(heard)))
        parts.append(f"{final_in}{fx}amix=inputs={len(heard) + 1}:duration=first:normalize=0[withfx]")
        final_in = "[withfx]"

    if room_tone:
        parts.append(
            f"anoisesrc=r=48000:c=brown:a={ROOM_TONE_AMPLITUDE}:d={total:.3f},"
            "aformat=sample_fmts=fltp:channel_layouts=stereo[room]"
        )
        parts.append(f"{final_in}[room]amix=inputs=2:duration=first:normalize=0[bed]")
        final_in = "[bed]"

    parts.append(f"{final_in}atrim=0:{total:.3f}[aout]")
    return ";".join(parts), total


END_CARD_MIN_SECONDS, END_CARD_MAX_SECONDS, END_CARD_DEFAULT_SECONDS = 1.5, 5.0, 2.5


def _ass_text(text: str) -> str:
    return (text or "").replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ").strip()


def make_end_card(
    image_path: str,
    output_path: str,
    width: int,
    height: int,
    fps: float,
    seconds: float = END_CARD_DEFAULT_SECONDS,
    headline: str = "",
    subline: str = "",
) -> str:
    """
    A closing clip (picture only, no sound) made from a real product picture: the picture sits in
    the upper part over a blurred, darkened copy of itself, with the headline and a smaller line
    under it. Generated scenes can get a label wrong; this frame is always right.
    """
    seconds = min(END_CARD_MAX_SECONDS, max(END_CARD_MIN_SECONDS, float(seconds or END_CARD_DEFAULT_SECONDS)))
    work_dir = os.path.dirname(os.path.abspath(output_path))
    unit = min(width, height) / 1080.0
    box_w, box_h = int(width * 0.78) // 2 * 2, int(height * 0.46) // 2 * 2
    top = int(height * 0.12)
    filters = [
        f"[0:v]split=2[bgsrc][fgsrc]",
        f"[bgsrc]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},"
        f"boxblur=luma_radius={max(8, int(36 * unit))}:luma_power=2,eq=brightness=-0.22:saturation=0.85[bg]",
        f"[fgsrc]scale={box_w}:{box_h}:force_original_aspect_ratio=decrease[fg]",
        f"[bg][fg]overlay=(W-w)/2:{top}+({box_h}-h)/2,setsar=1,format=yuv420p[card]",
    ]
    out_label = "[card]"
    headline, subline = _ass_text(headline), _ass_text(subline)
    if headline or subline:
        def size(points: float) -> int:
            return max(12, int(round(points * unit)))
        margin_h = int(width * 0.08)
        # Text block starts under the picture and stays above the area the apps' buttons cover.
        y_head = top + box_h + int(height * 0.045)
        y_sub = y_head + (size(84) * 2 + int(height * 0.02) if headline else 0)
        ass = [
            "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}", "WrapStyle: 0",
            "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
            "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, "
            "MarginV, Encoding",
            f"Style: Head,Montserrat,{size(76)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{size(4)},0,8,{margin_h},{margin_h},{y_head},1",
            f"Style: Sub,Montserrat,{size(46)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,{size(3)},0,8,{margin_h},{margin_h},{y_sub},1",
            "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
        end = f"0:00:{seconds + 1:05.2f}"
        if headline:
            ass.append(f"Dialogue: 0,0:00:00.00,{end},Head,,0,0,0,,{{\\fad(250,0)}}{headline}")
        if subline:
            ass.append(f"Dialogue: 0,0:00:00.00,{end},Sub,,0,0,0,,{{\\fad(250,0)}}{subline}")
        with open(os.path.join(work_dir, "end_card.ass"), "w", encoding="utf-8") as f:
            f.write("\n".join(ass) + "\n")
        filters.append("[card]subtitles=filename=end_card.ass[cardtext]")
        out_label = "[cardtext]"
    _run_ffmpeg([
        "ffmpeg", "-y", "-v", "error", "-loop", "1", "-framerate", f"{fps:.3f}", "-t", f"{seconds:.3f}",
        "-i", os.path.abspath(image_path), "-filter_complex", ";".join(filters), "-map", out_label, "-an",
        "-r", f"{fps:.3f}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
        os.path.abspath(output_path),
    ], "Making the end card", cwd=work_dir)
    return output_path


def stitch_videos(
    video_paths: List[str],
    output_path: str,
    music_path: Optional[str] = None,
    music_volume: Any = "medium",
    labels: Optional[List[str]] = None,
    caption_texts: Optional[List[str]] = None,
    caption_style: Optional[str] = None,
    tight_cuts: bool = True,
    end_card: Optional[Dict[str, Any]] = None,
    caption_words: Optional[List[Optional[List[Tuple[str, float, float]]]]] = None,
    edits: Optional[List[Optional[Dict[str, Any]]]] = None,
    report: Optional[Dict[str, Any]] = None,
    sounds: Optional[List[Dict[str, Any]]] = None,
) -> str:
    """
    Stitches scene videos into one video. `labels` name the clips in error messages ("Scene 2").
    caption_words: optional, one entry per clip: when each caption word is spoken in the untrimmed
    clip ([(word, start, end)]), or None to estimate that clip's timing from where speech is heard.
    edits: optional, one entry per clip, from the editor: {"start", "end"} (seconds kept, replacing
    the automatic trim), "muted" (the scene's own sound is dropped) and "volume" (1 = unchanged).
    report: optional dict that receives "cuts": for each clip, the part that was kept
    ({"start", "end", "length"} in seconds, `length` being the whole clip), so the editor's
    timeline can show the automatic cut.
    sounds: optional sound effects from the editor: [{"path", "clip" (index into video_paths, or
    "end" for the end card), "at" (seconds in that clip's file), "volume" (0 to 100)}]. Each is
    leveled and mixed in at its moment; see place_sounds for which are left out. `report` also
    receives "sounds": how many were mixed in.
    end_card: optional {"image_path", "headline", "subline", "seconds"}: a closing card after the
    last scene (see make_end_card). It has no voice; the music carries through it.

    Picture: every clip is trimmed (with tight_cuts, the dead air before the first word and after the
    last one goes), brought to the same size and frame rate, joined, and encoded once. With a
    caption_style, the scripts in caption_texts (one per clip) are burned in as captions.

    Audio: every scene is leveled to the same loudness (measured, fixed gain) with a tiny fade at each
    cut, a very quiet room tone runs under everything, an optional music track runs under the whole
    video (looped/trimmed, ducked under the voice, faded in and out), and the mix is normalized to
    the usual loudness for social apps (two-pass).
    """
    if not video_paths:
        raise ValueError("No videos to stitch.")

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    clips = [probe_media(vp) for vp in video_paths]
    check_clips_match(clips, labels)

    any_sound = False
    for index, (vp, clip) in enumerate(zip(video_paths, clips)):
        stats = measure_loudness(vp) if clip["has_audio"] else None
        clip["gain_db"] = _gain_to(SCENE_LOUDNESS_LUFS, stats)
        any_sound = any_sound or stats is not None
        full = max(0.05, float(clip["duration"]))
        speech = detect_speech(vp, full, _as_float((stats or {}).get("input_i"))) if stats else []
        start, end = plan_trim(full, speech, tight_cuts)
        edit = edits[index] if edits and index < len(edits) else None
        start, end = apply_scene_edit(full, start, end, edit)
        clip["gain_db"] += scene_volume_db(edit)
        if isinstance(edit, dict) and edit.get("muted"):
            clip["has_audio"] = False   # the mix puts silence of the same length in its place
        clip["trim_start"] = start
        clip["full_duration"] = full
        clip["duration"] = end - start
        # Speech as it sits in the trimmed clip (used to time the captions).
        clip["speech"] = [(max(0.0, a - start), min(end, b) - start) for a, b in speech if b > start and a < end]
    total_duration = sum(max(0.05, c["duration"]) for c in clips)
    if report is not None:
        report["cuts"] = [
            {"start": round(c["trim_start"], 3), "end": round(c["trim_start"] + c["duration"], 3), "length": round(c["full_duration"], 3)}
            for c in clips
        ]

    width = next((c["width"] for c in clips if c.get("width")), None)
    height = next((c["height"] for c in clips if c.get("height")), None)
    if not width or not height:
        raise ValueError("Could not read the picture size of the scene videos.")
    width, height = width - width % 2, height - height % 2
    fps = next((c["fps"] for c in clips if c.get("fps")), None) or 24.0

    has_end_card = False
    work_dir = tempfile.mkdtemp(prefix="ugc_stitch_audio_")
    try:
        if end_card and end_card.get("image_path") and os.path.exists(end_card["image_path"]):
            card_path = make_end_card(
                end_card["image_path"], os.path.join(work_dir, "end_card.mp4"), width, height, fps,
                seconds=end_card.get("seconds") or END_CARD_DEFAULT_SECONDS,
                headline=end_card.get("headline") or "", subline=end_card.get("subline") or "",
            )
            card = probe_media(card_path)
            card.update({"gain_db": 0.0, "trim_start": 0.0, "speech": []})
            video_paths = list(video_paths) + [card_path]
            clips.append(card)
            total_duration += max(0.05, card["duration"])
            has_end_card = True

        # 1. Picture: trim, match size and frame rate, join, burn in the captions, encode once.
        video_parts: List[str] = []
        for i, clip in enumerate(clips):
            t0, d = clip["trim_start"], max(0.05, clip["duration"])
            video_parts.append(
                f"[{i}:v]trim=start={t0:.3f}:end={t0 + d:.3f},setpts=PTS-STARTPTS,fps={fps:.3f},"
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{i}]"
            )
        joined = "".join(f"[v{i}]" for i in range(len(clips)))
        video_parts.append(f"{joined}concat=n={len(clips)}:v=1:a=0[vcat]")
        video_out = "[vcat]"

        if caption_style and caption_texts:
            timed, offset = [], 0.0
            for index, (clip, text) in enumerate(zip(clips, caption_texts)):
                d = max(0.05, clip["duration"])
                exact = caption_words[index] if caption_words and index < len(caption_words) else None
                words = fit_words_to_clip(exact, clip["trim_start"], d) if exact else []
                if not words:
                    words = word_timings(text or "", clip.get("speech") or [], d)
                timed.append([(w, offset + a, offset + b) for w, a, b in words])
                offset += d
            if any(timed):
                # Written next to the other work files and referenced by name (ffmpeg runs in work_dir),
                # so no path needs escaping inside the filter.
                with open(os.path.join(work_dir, "captions.ass"), "w", encoding="utf-8") as ass_file:
                    ass_file.write(build_ass(timed, caption_style, width, height))
                video_parts.append("[vcat]subtitles=filename=captions.ass[vsub]")
                video_out = "[vsub]"

        video_only = os.path.join(work_dir, "video_only.mp4")
        cmd = ["ffmpeg", "-y"]
        for vp in video_paths:
            cmd += ["-i", os.path.abspath(vp)]
        cmd += ["-filter_complex", ";".join(video_parts), "-map", video_out, "-an",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", video_only]
        _run_ffmpeg(cmd, "Joining the scene videos", cwd=work_dir)

        # 2. Audio mix (scenes + music) to a lossless intermediate file.
        cmd = ["ffmpeg", "-y"]
        for vp in video_paths:
            cmd += ["-i", vp]
        music_index = None
        music_gain = 0.0
        music_start, music_tempo = 0.0, 1.0
        if music_path:
            if not probe_media(music_path)["has_audio"]:
                raise ValueError("The music file has no audio in it.")
            music_stats = measure_loudness(music_path, duration=total_duration, loop=True)
            if music_stats:
                music_index = len(video_paths)
                music_gain = _gain_to(SCENE_LOUDNESS_LUFS, music_stats)
                # Start the music a fraction of a beat in, so its beats fall on the scene changes.
                cuts, at = [], 0.0
                for clip in clips[:-1]:
                    at += max(0.05, clip["duration"])
                    cuts.append(at)
                music_start, music_tempo, beat_note = music_fit_for_cuts(music_path, cuts)
                if beat_note:
                    logger.info("Music and cuts: %s", beat_note)
                cmd += ["-stream_loop", "-1", "-i", music_path]  # loops short tracks to cover the video

        # Sound effects, each its own input, leveled by its peak (too short for a loudness reading).
        mixed_sounds: List[Dict[str, Any]] = []
        for sound in place_sounds(clips, sounds, has_end_card):
            peak = measure_peak_db(sound["path"]) if os.path.exists(sound["path"]) else None
            if peak is None:
                continue
            mixed_sounds.append({
                **sound, "input_index": cmd.count("-i"),
                "gain_db": max(-MAX_GAIN_DB, min(MAX_GAIN_DB, SOUND_PEAK_DB - peak)),
            })
            cmd += ["-i", sound["path"]]
        if report is not None:
            report["sounds"] = len(mixed_sounds)

        # Room tone only when something is heard: in a silent video the final loudness pass would turn it up.
        filter_complex, total = build_stitch_audio_filter(
            clips, music_index, music_volume, music_gain, room_tone=any_sound or bool(mixed_sounds),
            music_start=music_start, music_tempo=music_tempo, sounds=mixed_sounds,
        )
        mix_path = os.path.join(work_dir, "mix.wav")
        cmd += ["-filter_complex", filter_complex, "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", "48000", mix_path]
        _run_ffmpeg(cmd, "Mixing the audio")

        # 3. Final loudness (two-pass, linear when possible), muxed with the copied picture.
        mix_stats = measure_loudness(mix_path)
        if mix_stats:
            audio_filter = (
                f"loudnorm=I={FINAL_LOUDNESS_LUFS}:TP={FINAL_TRUE_PEAK_DB}:LRA=11"
                f":measured_I={mix_stats['input_i']}:measured_TP={mix_stats['input_tp']}"
                f":measured_LRA={mix_stats['input_lra']}:measured_thresh={mix_stats['input_thresh']}"
                f":offset={mix_stats.get('target_offset', '0')}:linear=true,aresample=48000"
            )
        else:
            audio_filter = "anull"  # the whole video is silent
        _run_ffmpeg(
            ["ffmpeg", "-y", "-i", video_only, "-i", mix_path,
             "-map", "0:v:0", "-map", "1:a:0", "-af", audio_filter,
             "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
             "-t", f"{total:.3f}", "-movflags", "+faststart", output_path],
            "Finishing the audio",
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    return output_path
