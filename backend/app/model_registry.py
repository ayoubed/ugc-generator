"""
The models the app offers. This is the single source of truth: the frontend loads these lists
from GET /api/models, and the backend checks every saved choice against them.

To add a model, add an entry. A new Gemini Omni version only needs an entry; a new kind of
model (a new `provider`) also needs a generator in pipeline.generate_scene_video.
"""
from typing import Any, Dict, List, Optional

VIDEO_MODELS: List[Dict[str, Any]] = [
    {
        "id": "gemini-omni-1.2-flash",
        "label": "Gemini Omni Flash 1.2",
        "description": "Starts from a picture, uses up to 6 context pictures, and takes can be refined.",
        "provider": "omni",
        "max_reference_images": 6,
        "can_refine": True,
        # A scene can continue the previous scene's video in the same shot, up to this total length.
        "max_extended_seconds": 30,
        "durations": [5, 6, 7, 8],
        "resolutions": ["720p", "1080p"],
        "aspect_ratios": ["9:16", "16:9"],
    },
]

SCRIPT_MODELS: List[Dict[str, Any]] = [
    {
        "id": "gemini-2.5-pro",
        "label": "Gemini 2.5 Pro",
        "description": "Best writing quality. Slower.",
    },
    {
        "id": "gemini-2.5-flash",
        "label": "Gemini 2.5 Flash",
        "description": "Faster, a little less polished.",
    },
]

# Background music, added over the whole video when stitching (see pipeline.generate_music).
MUSIC_MODELS: List[Dict[str, Any]] = [
    {
        "id": "lyria-3-clip-preview",
        "label": "Lyria 3 Clip",
        "description": "30-second clips. Fast. Looped for longer videos.",
        "clip_seconds": 30,
    },
    {
        "id": "lyria-3.5",
        "label": "Lyria 3.5",
        "description": "Full-length tracks, for videos longer than 30 seconds. Slower.",
        "clip_seconds": None,
    },
    {
        "id": "elevenlabs-music",
        "label": "ElevenLabs Music",
        "description": "Made to the exact length of your video, with a real ending.",
        "clip_seconds": None,
        "provider": "elevenlabs",   # offered only when ELEVENLABS_API_KEY is set
    },
]


def _offered(model: Dict[str, Any]) -> bool:
    if model.get("provider") == "elevenlabs":
        from app import elevenlabs
        return elevenlabs.is_configured()
    return True


DEFAULT_VIDEO_MODEL_ID = VIDEO_MODELS[0]["id"]
DEFAULT_SCRIPT_MODEL_ID = SCRIPT_MODELS[0]["id"]
DEFAULT_MUSIC_MODEL_ID = MUSIC_MODELS[0]["id"]

# Watches each finished take and reports clear problems (see pipeline.check_take). A fast model is
# enough: it costs a fraction of the take it checks.
TAKE_CHECK_MODEL_ID = "gemini-2.5-flash"

# Watches a reference video once per project and breaks its structure down
# (see pipeline.analyse_reference_video).
REFERENCE_MODEL_ID = "gemini-2.5-pro"

# Draw the storyboard frames (pipeline.generate_storyboard_frame) and the first frame of a scene
# that cuts to a new camera position (pipeline.generate_cut_still). project.settings.imageModel.
IMAGE_MODELS: List[Dict[str, Any]] = [
    {
        "id": "gemini-3-pro-image",
        "label": "Nano Banana Pro",
        "description": "Best at fine detail and readable text on a product. Slower.",
    },
    {
        "id": "gemini-3.1-flash-image",
        "label": "Nano Banana 2",
        "description": "Faster and cheaper. Small text on a product often comes out wrong.",
    },
]
DEFAULT_IMAGE_MODEL_ID = IMAGE_MODELS[0]["id"]


def _find(models: List[Dict[str, Any]], model_id: Optional[str]) -> Optional[Dict[str, Any]]:
    return next((m for m in models if m["id"] == model_id), None)


def get_video_model(model_id: Optional[str]) -> Dict[str, Any]:
    """The saved model, or the default if it's missing or no longer offered (e.g. retired Veo models)."""
    return _find(VIDEO_MODELS, model_id) or VIDEO_MODELS[0]


def get_image_model(model_id: Optional[str]) -> Dict[str, Any]:
    """The saved image model, or the default if it's missing or no longer offered."""
    return _find(IMAGE_MODELS, model_id) or IMAGE_MODELS[0]


def get_script_model(model_id: Optional[str]) -> Dict[str, Any]:
    return _find(SCRIPT_MODELS, model_id) or SCRIPT_MODELS[0]


def get_music_model(model_id: Optional[str]) -> Dict[str, Any]:
    """The chosen music model, or the default when it is unknown or its service is not set up."""
    model = _find(MUSIC_MODELS, model_id)
    return model if model and _offered(model) else MUSIC_MODELS[0]


def is_offered_video_model(model_id: Optional[str]) -> bool:
    return _find(VIDEO_MODELS, model_id) is not None


def max_reference_images(model_id: Optional[str]) -> int:
    return int(get_video_model(model_id).get("max_reference_images") or 0)


def refine_model_for_take(take_model: Optional[str]) -> Optional[str]:
    """
    The model to refine a take with, or None if it can't be refined: the take's model must still be
    offered and support refining. Takes that didn't record a model were made with Omni (the only
    model that could refine), so they use the default.
    """
    if not take_model:
        default = VIDEO_MODELS[0]
        return default["id"] if default.get("can_refine") else None
    model = _find(VIDEO_MODELS, take_model)
    return model["id"] if model and model.get("can_refine") else None


def models_payload() -> Dict[str, Any]:
    return {
        "video_models": VIDEO_MODELS,
        "script_models": SCRIPT_MODELS,
        "music_models": [m for m in MUSIC_MODELS if _offered(m)],
        "image_models": IMAGE_MODELS,
        "default_image_model": DEFAULT_IMAGE_MODEL_ID,
        "default_video_model": DEFAULT_VIDEO_MODEL_ID,
        "default_script_model": DEFAULT_SCRIPT_MODEL_ID,
        "default_music_model": DEFAULT_MUSIC_MODEL_ID,
    }
