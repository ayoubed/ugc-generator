from enum import Enum
from typing import Any, List, Optional, Union
from pydantic import BaseModel, Field, model_validator


# Models matching structured output from Gemini
class Scene(BaseModel):
    description: str = Field(
        description="What visibly happens in the scene. DO NOT include stage directions, emotions, or acting notes (e.g. 'looks stressed', 'expression changes')."
    )
    script: str = Field(
        description="The exact spoken words only. NO stage directions or action brackets in the text. Match the script tone the user asked for."
    )
    context: str = Field(
        default="",
        description="Where and how this scene is filmed: location, background, framing, time of day, anything specific to this scene. No action and no dialogue.",
    )
    prompt: str = Field(
        description="The prompt for the video generation AI. MUST be formatted EXACTLY as:\nWhat They Say: [script here]\nWhat happens: [visual description here]\nContext: [context here]"
    )


class SceneList(BaseModel):
    video_context: str = Field(
        default="",
        description="One paragraph that applies to every scene: who the speaker is, where the video is filmed and the setting that stays the same. No dialogue, no actions.",
    )
    scenes: List[Scene]


# Asset Bible for visual & entity continuity across scenes
class AssetBible(BaseModel):
    character: str = Field(
        default="",
        description="Canonical description of the primary speaker/actor: hair, age, wardrobe, distinctive features.",
    )
    hero_props: str = Field(
        default="",
        description="Canonical description of key products, items, packaging, or display cases present in the video.",
    )
    setting: str = Field(
        default="",
        description="Canonical description of the environment, desk, room, or background location.",
    )
    voice: str = Field(
        default="",
        description="How the speaker sounds, identical in every scene: apparent age and gender, pitch, pace, energy, accent, recording quality.",
    )
    # No look/lighting/camera field: the sidebar guidelines (cameraTags, lightingTags, visualTags) own those.


# Structured output of the automatic take check
class TakeIssue(BaseModel):
    kind: str = Field(
        description="One of: speech, product, speaker, hands_or_face, on_screen_text, cut, audio, other."
    )
    detail: str = Field(description="One short sentence a non-technical person understands, saying what is wrong and where.")


class TakeCheckResult(BaseModel):
    spoken_text: str = Field(default="", description="Exactly what is said in the video, word for word. Empty if nobody speaks.")
    issues: List[TakeIssue] = Field(default_factory=list, description="Clear, visible or audible problems only. Empty when the take is fine.")


# Structured output of the reference-video breakdown (see pipeline.analyse_reference_video)
class ReferenceScene(BaseModel):
    start: float = Field(description="Second at which this part starts.")
    end: float = Field(description="Second at which this part ends.")
    purpose: str = Field(description="The job this part does in the ad, in a few words, without naming the product (e.g. 'Calls out the pain point', 'Shows the result', 'Asks to buy').")
    said: str = Field(default="", description="Exactly what is said in this part, word for word. Empty if nobody speaks.")
    happens: str = Field(description="What visibly happens, in one sentence.")
    framing: str = Field(default="", description="How it is filmed: shot size, angle, camera movement, where the person and product are.")


class ReferenceStyle(BaseModel):
    camera: List[str] = Field(default_factory=list, description="Up to 3 short instructions: device, framing, camera movement.")
    lighting: List[str] = Field(default_factory=list, description="Up to 3: light source, time of day, colour treatment.")
    action: List[str] = Field(default_factory=list, description="Up to 3: what the person does on camera and how they come across.")
    script_tone: List[str] = Field(default_factory=list, description="Up to 3: how the words sound (voice, energy, selling style).")
    visual: List[str] = Field(default_factory=list, description="Up to 3: setting, background, editing pace.")
    audio: List[str] = Field(default_factory=list, description="Up to 3: voice quality, room sound.")


class ReferenceBreakdown(BaseModel):
    summary: str = Field(description="One or two sentences: what kind of ad this is and why it holds attention.")
    hook_type: str = Field(description="One of: The Snippet, The Question, The On-Screen Text, The You-Feature, The Quick Cuts, Other.")
    hook: str = Field(description="How the first seconds grab attention, written as an instruction another video about a different product could follow. Do not name this ad's product or brand and do not quote its words.")
    scenes: List[ReferenceScene]
    pacing: str = Field(default="", description="One sentence on rhythm: how fast it is cut and spoken.")
    caption_style: str = Field(default="", description="How on-screen captions look, or 'No captions'.")
    music_mood: str = Field(default="", description="The background music as a short brief a composer could follow (genre, mood, tempo, instruments). Empty if there is no music.")
    call_to_action: str = Field(default="", description="How the ad closes and what it asks the viewer to do, without naming the product or brand.")
    style: ReferenceStyle = Field(default_factory=ReferenceStyle)


class AnalyseReferenceRequest(BaseModel):
    storage_ref: str = Field(..., max_length=1024)
    name: Optional[str] = Field(default="", max_length=200)


class ScriptStructureScene(BaseModel):
    """One part of a reference video's structure. The reference's spoken words are never included."""
    purpose: str = Field(default="", max_length=300)
    happens: str = Field(default="", max_length=600)
    framing: str = Field(default="", max_length=400)


class ScriptStructure(BaseModel):
    scenes: List[ScriptStructureScene] = Field(default_factory=list, max_length=10)
    pacing: str = Field(default="", max_length=400)
    call_to_action: str = Field(default="", max_length=400)


class ExtractAssetsRequest(BaseModel):
    idea: str
    llm_model: Optional[str] = None  # None = the default script model


class ExtractAssetsResponse(BaseModel):
    asset_bible: AssetBible


class SceneGuidelines(BaseModel):
    camera_specifics: Optional[Union[List[str], str]] = None
    lighting_restraints: Optional[Union[List[str], str]] = None
    relatable_action: Optional[Union[List[str], str]] = None
    script_tone: Optional[Union[List[str], str]] = None
    visual_consistency: Optional[Union[List[str], str]] = None
    audio_consistency: Optional[Union[List[str], str]] = None
    accent: Optional[str] = None


_GUIDELINE_KEYS = (
    "camera_specifics",
    "lighting_restraints",
    "relatable_action",
    "script_tone",
    "visual_consistency",
    "audio_consistency",
)


class GenerateScenesRequest(BaseModel):
    project_id: str
    idea: str
    num_scenes: int = Field(default=3, ge=1, le=10)
    target_words_per_scene: int = Field(default=20, ge=5, le=100)
    hook_style: str = "Auto-Select"
    custom_hook_desc: Optional[str] = ""
    llm_model: str = "gemini-2.5-pro"
    guidelines: Optional[SceneGuidelines] = None
    asset_bible: Optional[AssetBible] = None
    # The structure of a reference video to follow, scene by scene (sets the number of scenes).
    structure: Optional[ScriptStructure] = None

    @model_validator(mode="before")
    @classmethod
    def _accept_flat_fields(cls, data: Any) -> Any:
        """
        Older frontends sent guidelines and a few settings flat, under other names. Pydantic
        drops unknown fields silently, so map them instead of losing the user's choices.
        """
        if not isinstance(data, dict):
            return data
        data = dict(data)
        if "guidelines" not in data and any(k in data for k in _GUIDELINE_KEYS):
            data["guidelines"] = {k: data[k] for k in _GUIDELINE_KEYS if k in data}
            if data.get("accent"):
                data["guidelines"]["accent"] = data["accent"]
        if "target_words_per_scene" not in data and data.get("words_per_scene"):
            data["target_words_per_scene"] = data["words_per_scene"]
        if "llm_model" not in data and data.get("script_model"):
            data["llm_model"] = data["script_model"]
        return data


class GenerateScenesResponse(BaseModel):
    project_id: str
    video_context: str = ""
    scenes: List[Scene]


class ImageSourceEnum(str, Enum):
    uploaded = "uploaded"      # the scene's custom starting picture (falls back to the creator photo)
    creator = "creator"        # the creator photo uploaded in Step 1
    last_frame = "last_frame"  # sharpest of the last frames of the previous scene
    ai_cut = "ai_cut"          # last frame redrawn from a new camera position by the image model
    extend = "extend"          # continues the previous scene's video in the same shot (no cut)


class JobStatus(BaseModel):
    job_id: str
    status: str
    project_id: Optional[str] = None
    scene_index: Optional[int] = None
    attempt: Optional[int] = 1
    message: Optional[str] = None


class SelectAttemptRequest(BaseModel):
    """Make a past attempt the scene's active video (used for stitching and by the next scene)."""
    attempt: int = Field(..., ge=1)


class StitchRequest(BaseModel):
    aspect_ratio: Optional[str] = "9:16"


class StitchResponse(BaseModel):
    project_id: str
    status: str
    message: Optional[str] = None


class SceneData(BaseModel):
    scene_index: int
    description: str
    script: str
    prompt: str
    image_source: Optional[str] = None
    video_status: Optional[str] = "pending"
    storage_ref: Optional[str] = None
    video_url: Optional[str] = None
    attempt: Optional[int] = 0
    error_message: Optional[str] = None


class HealthResponse(BaseModel):
    status: str = "healthy"
