import os
import time
import shutil
import asyncio
import logging
import tempfile
import datetime
from typing import Optional, Dict, Any, List
import firebase_admin
from firebase_admin import firestore
from app.storage import upload_file, download_file, get_download_url, delete_file
from app.model_registry import get_video_model, refine_model_for_take
from app.captions import caption_style
from app.pipeline import (
    generate_scene_video,
    extract_last_frame,
    generate_camera_cut_variation,
    generate_cut_still,
    trim_video_start,
    probe_media,
    stitch_videos,
    check_take,
    detect_image_mime,
    SCENE_AUDIO_MODES,
    SCENE_AUDIO_VOICE_ONLY,
    MUSIC_VOLUMES,
    ASSET_BIBLE_FIELDS,
    asset_bible_lines,
    GenerationCancelled,
)

logger = logging.getLogger(__name__)

# Fallback cap on reference pictures (video-wide + scene-specific) sent with one generation.
# The real limit comes from the chosen model (model_registry.max_reference_images).
MAX_REFERENCE_IMAGES = 6

VALID_IMAGE_SOURCES = ("uploaded", "creator", "last_frame", "ai_cut", "extend")
# Starting choices that need the previous scene's video.
FROM_PREVIOUS_SOURCES = ("last_frame", "ai_cut", "extend")

# A queued/generating scene that has shown no sign of life for this long is treated as abandoned
# (e.g. the server restarted mid-job), so the user can start a new take. A running job refreshes
# scene.heartbeatAt every HEARTBEAT_SECONDS, so a slow but healthy take is never taken for dead.
STALE_JOB_SECONDS = 15 * 60
HEARTBEAT_SECONDS = 60

# Takes kept per scene. When a new take would exceed this, the oldest take that is not in use is
# removed together with its files.
MAX_SAVED_TAKES = 3


def _seconds(ts: Any) -> Optional[float]:
    return ts.timestamp() if ts is not None and hasattr(ts, "timestamp") else None


def is_stale_job(scene_data: Optional[Dict[str, Any]]) -> bool:
    """Whether a queued/generating scene stopped giving signs of life (see STALE_JOB_SECONDS)."""
    data = scene_data or {}
    seen = [t for t in (_seconds(data.get("heartbeatAt")), _seconds(data.get("updatedAt"))) if t is not None]
    if not seen:
        return True
    return (datetime.datetime.now(datetime.timezone.utc).timestamp() - max(seen)) > STALE_JOB_SECONDS


def split_takes_to_keep(history: Any, active_attempt: Optional[int], max_takes: int = MAX_SAVED_TAKES):
    """
    Splits a scene's history into (kept, dropped): at most `max_takes` takes stay, the oldest ones
    go first, and the take in use is never dropped. Entries that aren't takes are kept untouched.
    """
    entries = list(history or [])
    takes = sorted(
        (h for h in entries if isinstance(h, dict) and h.get("attempt")),
        key=lambda h: h.get("attempt") or 0,
    )
    dropped: List[Dict[str, Any]] = []
    for take in takes:
        if len(takes) - len(dropped) <= max_takes:
            break
        if take.get("attempt") != active_attempt:
            dropped.append(take)
    dropped_ids = {id(t) for t in dropped}
    kept = [h for h in entries if id(h) not in dropped_ids]
    return kept, dropped


def prune_old_takes(db, scene_ref, scene_prefix: str) -> List[int]:
    """
    Enforces MAX_SAVED_TAKES on a scene after a new take was saved. Returns the removed take numbers.
    Only files inside the scene's own folder are deleted, and a starting frame is kept while a
    remaining take still uses it (a refined take shares the frame of the take it refined).
    """
    result: Dict[str, Any] = {"kept": [], "dropped": []}

    @firestore.transactional
    def run(txn) -> None:
        data = scene_ref.get(transaction=txn).to_dict() or {}
        kept, dropped = split_takes_to_keep(data.get("history"), data.get("activeAttempt"))
        if dropped:
            update: Dict[str, Any] = {"history": kept}
            for take in dropped:
                update[f"takeChecks.{take.get('attempt')}"] = firestore.DELETE_FIELD
            txn.update(scene_ref, update)
        result["kept"], result["dropped"] = kept, dropped

    run(db.transaction())
    dropped = result["dropped"]
    still_used = {
        h.get(key) for h in result["kept"] if isinstance(h, dict) for key in ("storageRef", "startingImageRef") if h.get(key)
    }
    for take in dropped:
        for key in ("storageRef", "startingImageRef"):
            path = take.get(key)
            if not path or path in still_used or not str(path).startswith(scene_prefix):
                continue
            if key == "startingImageRef" and "/starting_frame_v" not in str(path):
                continue  # a custom picture the scene may still use
            delete_file(path)
    return [t.get("attempt") for t in dropped]

# Strong references to running background tasks (asyncio only keeps weak ones, so an
# unreferenced task can be garbage-collected mid-run).
_background_tasks: set = set()


_main_loop: Optional[asyncio.AbstractEventLoop] = None


def remember_main_loop() -> None:
    """Called once at startup, on the server's event loop (see main.lifespan)."""
    global _main_loop
    _main_loop = asyncio.get_running_loop()


def _start_task(coro) -> None:
    task = asyncio.create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def spawn_background(coro) -> None:
    """
    Starts a background job on the server's event loop and keeps it referenced until it finishes.
    Works from async endpoints and from plain `def` endpoints, which run in a worker thread
    where there is no running loop.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        if _main_loop is None:
            coro.close()
            raise RuntimeError("Background jobs can't start: the server's event loop was not recorded at startup.")
        _main_loop.call_soon_threadsafe(_start_task, coro)
        return
    _start_task(coro)


def is_take_cancelled(job_ref) -> bool:
    """Whether the user cancelled this take (POST .../cancel sets jobs/{id}.cancelRequested)."""
    try:
        snap = job_ref.get()
    except Exception as e:
        logger.warning("Could not check whether take %s was cancelled: %s", job_ref.id, e)
        return False
    return bool((snap.to_dict() or {}).get("cancelRequested")) if snap.exists else False


def commit_unless_cancelled(db, job_ref, writes: List[tuple]) -> bool:
    """
    Applies [(doc_ref, update_dict), ...] in one transaction, unless the take was cancelled.
    The cancel endpoint sets the flag in a transaction that reads the same job doc, so the two never
    interleave: a cancelled take can't overwrite the scene. Returns False when it was cancelled.
    """
    @firestore.transactional
    def run(txn) -> bool:
        job = job_ref.get(transaction=txn)
        if (job.to_dict() or {}).get("cancelRequested"):
            return False
        for ref, data in writes:
            txn.update(ref, data)
        return True

    return run(db.transaction())

# (label in the prompt, key in project.settings, legacy key in project.guidelines)
_GUIDELINE_FIELDS = (
    ("Camera", "cameraTags", "camera_specifics"),
    ("Lighting", "lightingTags", "lighting_restraints"),
    ("Visual Style", "visualTags", "visual_consistency"),
    ("Action & Performance", "actionTags", "relatable_action"),
    ("Script Tone", "scriptToneTags", "script_tone"),
    ("Audio & Delivery", "audioTags", "audio_consistency"),
)


def _as_tag_list(value: Any) -> List[str]:
    if not value:
        return []
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [str(v).strip() for v in value if str(v).strip()]


def build_global_context(project_data: Dict[str, Any]) -> List[str]:
    """
    Video-wide context prepended to every scene prompt. Guideline tags are saved by the UI under
    project.settings (cameraTags, lightingTags, ...); project.guidelines is only a legacy fallback.
    """
    settings = project_data.get("settings") or {}
    guidelines = project_data.get("guidelines") or {}

    parts: List[str] = []
    idea = (project_data.get("idea") or "").strip()
    if idea:
        parts.append(f"Global Video Idea: {idea}")

    video_context = str(settings.get("videoContext") or "").strip()
    if video_context:
        parts.append(f"Video Context: {video_context}")

    # The same fixed descriptions in every scene keep people, products and places from drifting.
    parts.extend(asset_bible_lines(settings.get("assetBible")))
    voice_only = project_scene_audio(project_data) == SCENE_AUDIO_VOICE_ONLY
    for label, settings_key, legacy_key in _GUIDELINE_FIELDS:
        values = _as_tag_list(settings.get(settings_key)) if settings_key in settings else _as_tag_list(guidelines.get(legacy_key))
        if voice_only and settings_key == "audioTags":
            # Older projects may still have music tags; music is added when stitching instead.
            values = [v for v in values if "music" not in v.lower()]
        if values:
            parts.append(f"{label}: {', '.join(values)}")

    accent = settings.get("accent") or guidelines.get("accent")
    if accent:
        parts.append(f"Speaker Accent: {accent}")

    return parts


def asset_bible_snapshot(project_data: Dict[str, Any]) -> Dict[str, str]:
    """The project's Asset Bible as saved on a take, so editing it later marks the take as outdated."""
    ab = (project_data.get("settings") or {}).get("assetBible")
    ab = ab if isinstance(ab, dict) else {}
    return {key: str(ab.get(key) or "").strip() for key, _ in ASSET_BIBLE_FIELDS}


def _assert_owned_path(uid: Optional[str], storage_path: str, what: str) -> None:
    """The Admin SDK bypasses Storage rules, so never download a path outside the caller's own area."""
    if uid and not str(storage_path).startswith(f"users/{uid}/"):
        raise ValueError(f"The {what} points outside your storage area. Remove it and upload it again.")


def is_scene_skipped(scene_data: Optional[Dict[str, Any]]) -> bool:
    """A scene switched off on the Generate page: left out of the final video."""
    return bool((scene_data or {}).get("skipped"))


def project_scene_audio(project_data: Optional[Dict[str, Any]]) -> str:
    """settings.sceneAudio, defaulting to voice only (music is added once, when stitching)."""
    value = ((project_data or {}).get("settings") or {}).get("sceneAudio")
    return value if value in SCENE_AUDIO_MODES else SCENE_AUDIO_VOICE_ONLY


def project_music(project_data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The music track chosen on the Export page ({storageRef, volume, ...}), or None."""
    music = ((project_data or {}).get("settings") or {}).get("music")
    if not isinstance(music, dict) or music.get("source") in (None, "none") or not music.get("storageRef"):
        return None
    volume = music.get("volume") if music.get("volume") in MUSIC_VOLUMES else "medium"
    return {**music, "volume": volume}


def scene_slot(doc_id: Any, scene_data: Optional[Dict[str, Any]]) -> Optional[int]:
    """
    The spot a scene takes in the video. Scenes are numbered by their doc id, except alternatives
    (scene groups): an alternative carries variantOf = the id of the scene it stands in for, and
    sits in that scene's spot. Only one scene of a group is in the video; the others are skipped.
    """
    variant_of = (scene_data or {}).get("variantOf")
    for value in (variant_of, doc_id):
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def ordered_scenes(project_ref) -> List[tuple]:
    """Every scene as (label, doc id, data) in video order. Labels read "1", "2A", "2B", "3"."""
    rows = []
    for snap in project_ref.collection("scenes").stream():
        data = snap.to_dict() or {}
        slot = scene_slot(snap.id, data)
        if slot is None:
            continue
        try:
            own = int(snap.id)
        except (TypeError, ValueError):
            own = 0
        rows.append((slot, own, snap.id, data))
    rows.sort(key=lambda r: (r[0], r[1]))

    slots = sorted({r[0] for r in rows})
    number = {slot: i + 1 for i, slot in enumerate(slots)}
    size = {slot: sum(1 for r in rows if r[0] == slot) for slot in slots}
    seen: Dict[int, int] = {}
    result = []
    for slot, _, doc_id, data in rows:
        letter = ""
        if size[slot] > 1:
            letter = chr(ord("A") + min(seen.get(slot, 0), 25))
            seen[slot] = seen.get(slot, 0) + 1
        result.append((f"{number[slot]}{letter}", doc_id, data))
    return result


def find_previous_scene(project_ref, scene_index: int):
    """
    Returns (doc_id, data) of the closest scene before `scene_index` that is in the video, or (None, None).
    "Before" means an earlier spot: deleting a scene leaves a gap in the ids, skipped scenes aren't in
    the final video, and the other alternatives of the same spot never count as previous.
    """
    scenes = {snap.id: (snap.to_dict() or {}) for snap in project_ref.collection("scenes").stream()}
    current_slot = scene_slot(str(scene_index), scenes.get(str(scene_index)))
    if current_slot is None:
        return None, None
    best = None
    for doc_id, data in scenes.items():
        slot = scene_slot(doc_id, data)
        if slot is None or slot >= current_slot or is_scene_skipped(data):
            continue
        if best is None or slot > best[0]:
            best = (slot, doc_id, data)
    if best is None:
        return None, None
    return best[1], best[2]


def _iso(ts: Any) -> Optional[str]:
    return ts.isoformat() if hasattr(ts, "isoformat") else None


def collect_reference_specs(
    project_data: Dict[str, Any], scene_data: Dict[str, Any], uid: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Video-wide pictures first (project.globalImages), then scene pictures (scene.sceneImages)."""
    specs: List[Dict[str, Any]] = []
    for scope, items in (("global", project_data.get("globalImages")), ("scene", scene_data.get("sceneImages"))):
        for item in items or []:
            if not isinstance(item, dict) or not item.get("storageRef"):
                continue
            _assert_owned_path(uid, item["storageRef"], "reference picture")
            specs.append({
                "scope": scope,
                "storageRef": item["storageRef"],
                "url": item.get("url"),
                "description": (item.get("description") or "").strip(),
            })
    return specs


def download_reference_images(
    specs: List[Dict[str, Any]], temp_dir: str, max_images: int = MAX_REFERENCE_IMAGES
) -> List[Dict[str, Any]]:
    """Downloads reference pictures from Storage. Fails loudly so a missing picture is never silently dropped."""
    if len(specs) > max_images:
        raise ValueError(
            f"Too many reference pictures ({len(specs)}). Use at most {max_images} per scene, "
            "including the video-wide pictures."
        )

    downloaded = []
    for i, spec in enumerate(specs):
        ext = os.path.splitext(spec["storageRef"])[1].lower() or ".jpg"
        local_path = os.path.join(temp_dir, f"reference_{i}{ext}")
        try:
            download_file(spec["storageRef"], local_path)
        except Exception as e:
            where = "video-wide" if spec["scope"] == "global" else "scene"
            label = spec["description"] or f"picture #{i + 1}"
            raise ValueError(f"Could not load the {where} reference picture '{label}'. Remove it or upload it again.") from e
        downloaded.append({"path": local_path, "description": spec["description"]})
    return downloaded


async def run_video_generation_job(
    uid: str,
    project_id: str,
    scene_index: int,
    image_source: str,
    image_bytes: Optional[bytes] = None,
    config: Optional[Dict[str, Any]] = None,
    attempt: Optional[int] = None,
) -> None:
    """
    Runs the (blocking) generation job in a worker thread, so the API keeps answering
    other requests (switching attempts, starting other scenes) while a video renders.
    """
    await asyncio.to_thread(
        _run_video_generation_job_sync, uid, project_id, scene_index, image_source, image_bytes, config, attempt
    )


def active_take_record(scene_data: Dict[str, Any]) -> Dict[str, Any]:
    """History record of the take the scene uses (activeAttempt), or its latest take."""
    records = [h for h in (scene_data.get("history") or []) if isinstance(h, dict) and h.get("attempt")]
    active = scene_data.get("activeAttempt")
    match = next((h for h in records if h.get("attempt") == active), None)
    if match:
        return match
    return max(records, key=lambda h: h.get("attempt") or 0) if records else {}


def _run_video_generation_job_sync(
    uid: str,
    project_id: str,
    scene_index: int,
    image_source: str,
    image_bytes: Optional[bytes] = None,
    config: Optional[Dict[str, Any]] = None,
    attempt: Optional[int] = None,
) -> None:
    """
    Background job to generate video for a specific scene:
    1. Update scene doc status to 'generating' in Firestore
    2. Determine starting image (uploaded bytes or extracted from prior scene)
    3. If last_frame: extract sharpest frame from prior scene video
    4. If ai_cut: the image model redraws that frame from a new camera position
       If extend: the prior scene's video is continued in the same shot, and its part is cut off
    5. Call generate_scene_video() with prompt from Firestore and starting image
    6. Upload generated video to Firebase Storage at users/{uid}/projects/{pid}/scenes/{n}/video.mp4
    7. Update scene doc: videoStatus='completed', storageRef=path, activeAttempt=attempt
    8. Later scenes are never touched: regenerating a scene does not reset the scenes that follow it
    9. On error: if the scene already had a video it keeps it (status stays 'completed' and the failure is
       recorded in failedAttempt/errorMessage); otherwise videoStatus='failed', errorMessage=str
    """
    config = config or {}
    db = firestore.client()
    project_ref = db.collection("projects").document(project_id)
    scene_ref = project_ref.collection("scenes").document(str(scene_index))

    project_snap = project_ref.get()
    project_data = project_snap.to_dict() if project_snap.exists else {}

    # Attempt number comes from the route (falls back to the scene doc for older callers)
    scene_snap = scene_ref.get()
    scene_data = scene_snap.to_dict() if scene_snap.exists else {}
    attempt = attempt or scene_data.get("attempt", 1)
    job_id = f"{project_id}_{scene_index}_{attempt}"
    job_ref = db.collection("jobs").document(job_id)

    # A refinement continues the take in use through its Gemini Omni interaction: that turn already holds
    # the starting frame and context pictures, so only the requested change is sent.
    edit_prompt = (config.get("edit_prompt") or "").strip() or None
    previous_interaction_id = scene_data.get("interactionId") if edit_prompt else None
    refining = bool(previous_interaction_id)
    refined_take = active_take_record(scene_data) if refining else {}

    # 1. Update scene doc & job doc status to 'generating' (unless it was cancelled while queued)
    try:
        status_update = {
            "videoStatus": "generating",
            "errorMessage": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
            "heartbeatAt": firestore.SERVER_TIMESTAMP,
        }
        if not refining:
            # A refinement keeps the start of the take it refines, so the choice for new takes stays as it is.
            status_update["imageSource"] = image_source
        started = commit_unless_cancelled(db, job_ref, [
            (scene_ref, status_update),
            (job_ref, {"status": "generating", "updatedAt": firestore.SERVER_TIMESTAMP}),
        ])
        if not started:
            logger.info(f"Take {attempt} of scene {scene_index} in project {project_id} was cancelled before it started.")
            return
    except Exception as e:
        logger.error(f"Failed to update scene status to generating: {e}")

    temp_dir = tempfile.mkdtemp(prefix=f"ugc_gen_{project_id}_{scene_index}_")

    try:
        starting_image_path = os.path.join(temp_dir, "start_frame.jpg")
        source_scene_attempt = None  # which attempt of the previous scene the starting frame came from
        extend_interaction_id = None  # set when this take continues the previous scene's video
        start_note = None             # why the chosen start could not be used as asked, if so
        duration_seconds = int(config.get("duration_seconds", 8))

        video_model = get_video_model(config.get("video_model"))["id"]
        if refining:
            # A refinement continues on the model its take was made with.
            refine_model = refine_model_for_take(refined_take.get("videoModel"))
            if not refine_model:
                raise ValueError("This take was made with a model that can't refine takes. Make a new take instead.")
            video_model = refine_model

        # Reference pictures: video-wide + scene-specific (a refinement already has them from its first turn)
        reference_specs = collect_reference_specs(project_data, scene_data, uid)
        reference_images: List[Dict[str, Any]] = []
        if reference_specs and not previous_interaction_id:
            reference_images = download_reference_images(
                reference_specs, temp_dir, int(get_video_model(video_model).get("max_reference_images") or 0)
            )

        # 2-4. Determine starting image
        if refining:
            # Nothing to prepare: the refined take's interaction already has its starting frame.
            source_scene_attempt = refined_take.get("sourceSceneAttempt")

        elif image_source == "uploaded" and image_bytes and len(image_bytes) > 0:
            # Legacy path: picture sent with the request. Persist it as the scene's custom starting picture.
            with open(starting_image_path, "wb") as f:
                f.write(image_bytes)
            input_storage_path = f"users/{uid}/projects/{project_id}/scenes/{scene_index}/input_image.jpg"
            upload_file(starting_image_path, input_storage_path, content_type=detect_image_mime(starting_image_path))
            input_url = get_download_url(input_storage_path)
            scene_ref.update({
                "startingImageRef": input_storage_path,
                "startingImageUrl": input_url,
                "customStartImageRef": input_storage_path,
                "customStartImageUrl": input_url,
            })

        elif image_source in ("uploaded", "creator"):
            # 'uploaded' = the scene's custom starting picture (falls back to the creator photo).
            # 'creator'  = the creator photo from Step 1.
            legacy_upload = scene_data.get("startingImageRef") or ""
            if "/input_image" not in legacy_upload:
                legacy_upload = ""

            if image_source == "uploaded":
                starting_ref = scene_data.get("customStartImageRef") or legacy_upload or project_data.get("startingImageRef")
            else:
                starting_ref = project_data.get("startingImageRef")

            if not starting_ref:
                raise ValueError("No starting picture available: upload a creator photo in Step 1 or a custom picture for this scene.")

            _assert_owned_path(uid, starting_ref, "starting picture")
            download_file(starting_ref, starting_image_path)
            scene_ref.update({
                "startingImageRef": starting_ref,
                "startingImageUrl": get_download_url(starting_ref),
            })

        elif image_source in FROM_PREVIOUS_SOURCES:
            prev_id, prev_data = find_previous_scene(project_ref, scene_index)
            if prev_id is None:
                raise ValueError(
                    f"This scene cannot use '{image_source}' because no scene comes before it. "
                    "Start it from the creator photo or a custom picture."
                )
            prev_index = int(prev_id)
            if not prev_data.get("storageRef"):
                raise ValueError(
                    "The scene before this one has no video yet. Generate it first, or pick another starting picture for this scene."
                )
            prev_video_ref = prev_data["storageRef"]
            _assert_owned_path(uid, prev_video_ref, "previous scene video")
            prev_attempts = [h.get("attempt") for h in (prev_data.get("history") or []) if isinstance(h, dict) and h.get("attempt")]
            source_scene_attempt = prev_data.get("activeAttempt") or (max(prev_attempts) if prev_attempts else None)

            prev_video_local = os.path.join(temp_dir, f"prev_scene_{prev_index}.mp4")
            download_file(prev_video_ref, prev_video_local)

            raw_extracted_frame = os.path.join(temp_dir, "raw_last_frame.jpg")
            extract_last_frame(prev_video_local, raw_extracted_frame)

            if image_source == "ai_cut":
                try:
                    generate_cut_still(
                        raw_extracted_frame,
                        starting_image_path,
                        scene_description=str(scene_data.get("description") or scene_data.get("script") or ""),
                        aspect_ratio=config.get("aspect_ratio", "9:16"),
                        reference_images=reference_images,
                        asset_lines=asset_bible_lines((project_data.get("settings") or {}).get("assetBible")),
                    )
                except Exception as still_err:
                    # The take still gets a cut: the frame is zoomed and re-framed instead.
                    logger.warning("Camera cut picture for scene %s failed (%s). Using a re-framed frame.", scene_index, still_err)
                    start_note = "The new camera angle could not be drawn, so the last frame was zoomed and re-framed instead."
                    generate_camera_cut_variation(raw_extracted_frame, starting_image_path)
            else:
                shutil.copyfile(raw_extracted_frame, starting_image_path)

            if image_source == "extend":
                # Continue the previous take's own video when possible; otherwise start from its last frame.
                prev_take = active_take_record(prev_data)
                chain_seconds = float(prev_take.get("chainSeconds") or 0) or probe_media(prev_video_local)["duration"]
                limit = float(get_video_model(video_model).get("max_extended_seconds") or 0)
                if not prev_data.get("interactionId") or not limit or (prev_take.get("videoModel") or video_model) != video_model:
                    start_note = "The scene before can't be continued in the same shot, so this take starts from its last frame."
                elif chain_seconds + duration_seconds > limit + 0.5:
                    start_note = (
                        f"One continuous shot can be {int(limit)} seconds at most, so this take starts from the last "
                        "frame of the scene before instead."
                    )
                else:
                    extend_interaction_id = prev_data["interactionId"]

            # Persist the extracted starting frame (one file per attempt, so older attempts keep their own frame)
            extracted_storage_path = f"users/{uid}/projects/{project_id}/scenes/{scene_index}/starting_frame_v{attempt}.jpg"
            upload_file(starting_image_path, extracted_storage_path, content_type=detect_image_mime(starting_image_path))
            extracted_url = get_download_url(extracted_storage_path)
            scene_ref.update({
                "startingImageRef": extracted_storage_path,
                "startingImageUrl": extracted_url,
            })

        else:
            raise ValueError(f"Unsupported image_source: {image_source}")

        # Optional picture the video must end on (not used when refining or continuing a shot).
        end_image_path = None
        end_ref = scene_data.get("endImageRef")
        if end_ref and not refining and not extend_interaction_id:
            _assert_owned_path(uid, end_ref, "end picture")
            end_image_path = os.path.join(temp_dir, "end_frame" + (os.path.splitext(end_ref)[1].lower() or ".jpg"))
            try:
                download_file(end_ref, end_image_path)
            except Exception as e:
                raise ValueError("Could not load this scene's end picture. Remove it or upload it again.") from e

        script = scene_data.get("script", "")
        desc = scene_data.get("description", "")
        scene_context = (scene_data.get("context") or "").strip()
        fallback_prompt = f"What They Say: {script}\nWhat happens: {desc}"
        if scene_context:
            fallback_prompt += f"\nContext: {scene_context}"
        base_prompt = scene_data.get("prompt") or fallback_prompt
        if refining:
            # The scene prompt is not sent again: the refined take was made from its own prompt.
            base_prompt = refined_take.get("scenePrompt") or base_prompt
        
        # Inject video-wide project context (idea + authenticity guidelines) into every scene prompt
        context_parts = build_global_context(project_data)
        
        if context_parts:
            prompt = "\n".join(context_parts) + "\n\nScene Detail:\n" + base_prompt
        else:
            prompt = base_prompt

        local_output_video = os.path.join(temp_dir, f"scene_{scene_index}_generated.mp4")
        scene_audio = project_scene_audio(project_data)

        # Called every few seconds while the video renders: also the place to say "still alive".
        last_beat = [time.monotonic()]

        def check_cancel() -> bool:
            if is_take_cancelled(job_ref):
                return True
            if time.monotonic() - last_beat[0] >= HEARTBEAT_SECONDS:
                last_beat[0] = time.monotonic()
                try:
                    scene_ref.update({"heartbeatAt": firestore.SERVER_TIMESTAMP})
                except Exception as beat_err:
                    logger.warning("Heartbeat for take %s of scene %s failed: %s", attempt, scene_index, beat_err)
            return False

        _, interaction_id, sent_prompt = generate_scene_video(
            prompt=prompt,
            image_path=starting_image_path,
            output_path=local_output_video,
            aspect_ratio=config.get("aspect_ratio", "9:16"),
            duration_seconds=duration_seconds,
            resolution=config.get("resolution", "1080p"),
            video_model=video_model,
            edit_prompt=edit_prompt if refining else None,
            previous_interaction_id=previous_interaction_id,
            reference_images=[] if extend_interaction_id else reference_images,
            scene_audio=scene_audio,
            end_image_path=end_image_path,
            extend_interaction_id=extend_interaction_id,
            # Saved so POST .../cancel can stop the request at Google while it runs.
            on_started=lambda interaction_id: job_ref.update({"interactionId": interaction_id}),
            should_cancel=check_cancel,
        )

        if is_take_cancelled(job_ref):
            raise GenerationCancelled()

        # A continued shot comes back with the earlier scene(s) at the front: keep only this scene's part.
        chain_seconds = probe_media(local_output_video)["duration"]
        prefix_seconds = 0.0
        if extend_interaction_id:
            prefix_seconds = max(0.0, round(chain_seconds - duration_seconds, 3))
        elif refining:
            prefix_seconds = float(refined_take.get("prefixSeconds") or 0)
        if prefix_seconds >= 0.5 and chain_seconds - prefix_seconds >= 1.0:
            own_part = os.path.join(temp_dir, f"scene_{scene_index}_own_part.mp4")
            trim_video_start(local_output_video, own_part, prefix_seconds)
            local_output_video = own_part
        else:
            prefix_seconds = 0.0

        # 6. Upload generated video to Firebase Storage
        video_storage_path = f"users/{uid}/projects/{project_id}/scenes/{scene_index}/video_v{attempt}.mp4"
        upload_file(local_output_video, video_storage_path, content_type="video/mp4")
        video_url = get_download_url(video_storage_path)

        # 7. Update scene doc & job doc: videoStatus='completed'
        if refining:
            # A refined take starts where the take it refines started, with the same context pictures.
            take_start = {
                "imageSource": refined_take.get("imageSource") or image_source,
                "startingImageRef": refined_take.get("startingImageRef"),
                "referenceImages": refined_take.get("referenceImages") or [],
                "endImageRef": refined_take.get("endImageRef"),
                "extended": bool(refined_take.get("extended")),
                "videoContext": refined_take.get("videoContext"),
                "assetBible": refined_take.get("assetBible"),
            }
        else:
            take_start = {
                "imageSource": image_source,
                "startingImageRef": (scene_ref.get().to_dict() or {}).get("startingImageRef"),
                "referenceImages": [
                    {"scope": s["scope"], "url": s["url"], "description": s["description"]}
                    for s in reference_specs
                ] if reference_images and not extend_interaction_id else [],
                "endImageRef": end_ref if end_image_path else None,
                "extended": bool(extend_interaction_id),
                "startNote": start_note,
                # The video context this take was made with, so editing it marks the take as outdated.
                "videoContext": str((project_data.get("settings") or {}).get("videoContext") or "").strip(),
                "assetBible": asset_bible_snapshot(project_data),
            }

        attempt_record = {
            "attempt": attempt,
            "videoUrl": video_url,
            "storageRef": video_storage_path,
            "interactionId": interaction_id,
            "videoModel": video_model,
            "prompt": sent_prompt,
            "scenePrompt": base_prompt,
            "editPrompt": edit_prompt if refining else None,
            "refinedFrom": refined_take.get("attempt") if refining else None,
            "sourceSceneAttempt": source_scene_attempt,
            # Length of the video the model holds for this take, and how much of it (earlier scenes
            # of a continued shot) was cut off the front of the saved file.
            "chainSeconds": chain_seconds,
            "prefixSeconds": prefix_seconds,
            **take_start,
            # Voice only, or audio picked by the video model (may contain its own music).
            "sceneAudio": scene_audio,
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

        committed = commit_unless_cancelled(db, job_ref, [
            (scene_ref, {
                "videoStatus": "completed",
                "storageRef": video_storage_path,
                "videoUrl": video_url,
                "interactionId": interaction_id,
                "activeAttempt": attempt,
                "history": firestore.ArrayUnion([attempt_record]),
                "errorMessage": None,
                "failedAttempt": None,
                "updatedAt": firestore.SERVER_TIMESTAMP,
            }),
            (job_ref, {
                "status": "completed",
                "storageRef": video_storage_path,
                "videoUrl": video_url,
                "completedAt": firestore.SERVER_TIMESTAMP,
            }),
        ])
        if not committed:
            raise GenerationCancelled()
        logger.info(f"Scene {scene_index} in project {project_id} generated successfully.")

        # Keep at most MAX_SAVED_TAKES takes. A failure here must not fail the take that just succeeded.
        try:
            removed = prune_old_takes(db, scene_ref, f"users/{uid}/projects/{project_id}/scenes/{scene_index}/")
            if removed:
                logger.info(f"Scene {scene_index} in project {project_id}: removed old take(s) {removed}.")
        except Exception as prune_err:
            logger.warning(f"Could not remove old takes of scene {scene_index} in project {project_id}: {prune_err}")

        # Automatic check of the new take. The take is already saved and usable; this only adds a
        # note to it (scene.takeChecks.<take>), so a failure here changes nothing.
        if os.environ.get("TAKE_CHECKS", "on").lower() not in ("off", "0", "false"):
            try:
                result = check_take(
                    local_output_video,
                    script=str(scene_data.get("script") or ""),
                    asset_lines=asset_bible_lines((project_data.get("settings") or {}).get("assetBible")),
                    picture_descriptions=[spec["description"] for spec in reference_specs],
                    voice_only=scene_audio == SCENE_AUDIO_VOICE_ONLY,
                )
                result["checkedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
                scene_ref.update({f"takeChecks.{attempt}": result})
            except Exception as check_err:
                logger.warning(f"Could not check take {attempt} of scene {scene_index} in project {project_id}: {check_err}")

    except GenerationCancelled:
        # The cancel endpoint already put the scene back; touching it now could undo a newer take.
        logger.info(f"Take {attempt} of scene {scene_index} in project {project_id} was cancelled.")

    except Exception as e:
        logger.exception(f"Error generating video for scene {scene_index} in project {project_id}: {e}")
        # 9. On error: update scene doc & job doc (skipped if the take was cancelled meanwhile)
        try:
            # A failed new attempt must not take away a video the scene already had:
            # keep it active so stitching and the following scenes are not blocked.
            had_video = bool(scene_data.get("storageRef")) and bool(scene_data.get("history"))
            commit_unless_cancelled(db, job_ref, [
                (scene_ref, {
                    "videoStatus": "completed" if had_video else "failed",
                    "errorMessage": str(e),
                    "failedAttempt": attempt,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                }),
                (job_ref, {
                    "status": "failed",
                    "errorMessage": str(e),
                    "failedAt": firestore.SERVER_TIMESTAMP,
                }),
            ])
        except Exception as update_err:
            logger.error(f"Failed to record failure in Firestore: {update_err}")

    finally:
        # Cleanup temporary files
        shutil.rmtree(temp_dir, ignore_errors=True)


async def run_stitch_job(
    uid: str,
    project_id: str,
    scene_count: Optional[int] = None,
    config: Optional[Dict[str, Any]] = None,
) -> None:
    """Runs the (blocking) stitch job in a worker thread so the API stays responsive."""
    await asyncio.to_thread(_run_stitch_job_sync, uid, project_id, scene_count, config)


def _run_stitch_job_sync(
    uid: str,
    project_id: str,
    scene_count: Optional[int] = None,
    config: Optional[Dict[str, Any]] = None,
) -> None:
    """
    Background job to stitch all scene videos of a project together:
    1. Download all scene videos from Storage to temp dir
    2. Join them: the picture is stream-copied; the audio is leveled, mixed with the music track
       (if one is chosen) and normalized
    3. Upload final video to Storage
    4. Update project status to 'completed' in Firestore
    """
    db = firestore.client()
    project_ref = db.collection("projects").document(project_id)
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_stitch_{project_id}_")
    project_data: Dict[str, Any] = {}

    try:
        project_snap = project_ref.get()
        project_data = (project_snap.to_dict() or {}) if project_snap.exists else {}

        # 1. Update project status to 'stitching'
        project_ref.update({
            "status": "stitching",
            "errorMessage": None,
            "stitchError": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })

        # Scenes in video order (skipped ones, including the unused alternatives of a spot, are left out)
        scenes_list = [(label, doc_id, data) for label, doc_id, data in ordered_scenes(project_ref) if not is_scene_skipped(data)]
        if not scenes_list:
            raise ValueError("Every scene is skipped. Switch at least one back on to stitch.")
        scene_numbers = [label for label, _, _ in scenes_list]

        # Download the active video of every scene
        local_video_paths = []
        used_scenes = []
        for idx, doc_id, data in scenes_list:
            storage_ref = data.get("storageRef") or f"users/{uid}/projects/{project_id}/scenes/{doc_id}/video.mp4"
            _assert_owned_path(uid, storage_ref, f"video of scene {idx}")
            local_path = os.path.join(temp_dir, f"scene_{doc_id}.mp4")
            download_file(storage_ref, local_path)
            local_video_paths.append(local_path)
            used_scenes.append({"sceneId": doc_id, "attempt": data.get("activeAttempt")})

        # 2. Join the scenes, with leveled audio and the project's music track (if any)
        music = project_music(project_data)
        music_local = None
        if music:
            _assert_owned_path(uid, music["storageRef"], "music track")
            ext = os.path.splitext(music["storageRef"])[1] or ".mp3"
            music_local = os.path.join(temp_dir, f"music{ext}")
            download_file(music["storageRef"], music_local)
        final_video_local = os.path.join(temp_dir, "final_video.mp4")
        # Finishing choices from the Export page. Unset = captions in the default style and tight cuts.
        settings = project_data.get("settings") or {}
        captions = caption_style((settings.get("captions") or {}).get("style") if isinstance(settings.get("captions"), dict) else None)
        tight_cuts = settings.get("tightCuts") is not False
        # Caption text per scene: what the user typed on the Finish step, otherwise the script.
        # An empty text means no caption on that scene.
        caption_settings = settings.get("captions") if isinstance(settings.get("captions"), dict) else {}
        own_texts = caption_settings.get("texts") if isinstance(caption_settings.get("texts"), dict) else {}
        caption_texts = {
            doc_id: own_texts[doc_id] if isinstance(own_texts.get(doc_id), str) else str(data.get("script") or "")
            for _, doc_id, data in scenes_list
        }
        stitch_videos(
            local_video_paths,
            final_video_local,
            music_path=music_local,
            music_volume=music["volume"] if music else "medium",
            labels=[f"Scene {number}" for number in scene_numbers],
            caption_texts=[caption_texts[doc_id] for _, doc_id, _ in scenes_list],
            caption_style=captions,
            tight_cuts=tight_cuts,
        )

        # 3. Every stitch is a new version, so earlier final videos stay available.
        history = [v for v in (project_data.get("finalVideos") or []) if isinstance(v, dict)]
        new_records: List[Dict[str, Any]] = []
        legacy_ref = project_data.get("finalVideoRef")
        if legacy_ref and not any(v.get("storageRef") == legacy_ref for v in history):
            # Stitched before versioning existed: keep that video in the history too.
            legacy_record = {
                "version": max((v.get("version") or 0 for v in history), default=0) + 1,
                "storageRef": legacy_ref,
                "videoUrl": project_data.get("finalVideoUrl"),
                "createdAt": _iso(project_data.get("updatedAt")),
                "sceneCount": None,
                "scenes": [],
            }
            history.append(legacy_record)
            new_records.append(legacy_record)

        version = max((v.get("version") or 0 for v in history), default=0) + 1
        final_storage_path = f"users/{uid}/projects/{project_id}/final_video_v{version}.mp4"
        upload_file(final_video_local, final_storage_path, content_type="video/mp4")
        final_url = get_download_url(final_storage_path)
        new_records.append({
            "version": version,
            "storageRef": final_storage_path,
            "videoUrl": final_url,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "sceneCount": len(used_scenes),
            "scenes": used_scenes,
            # The music this version was mixed with, so changing it marks the version as outdated.
            "music": {"storageRef": music["storageRef"], "volume": music["volume"]} if music else None,
            # Same for the captions and the tightened cuts.
            "captions": captions or "none",
            "captionTexts": caption_texts if captions else {},
            "tightCuts": tight_cuts,
        })

        # 4. Update project status to 'completed'
        project_ref.update({
            "status": "completed",
            "finalVideoRef": final_storage_path,
            "finalVideoUrl": final_url,
            "finalVideoVersion": version,
            "finalVideos": firestore.ArrayUnion(new_records),
            "errorMessage": None,
            "stitchError": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        logger.info(f"Project {project_id} stitched successfully (version {version}).")

    except Exception as e:
        logger.exception(f"Error stitching project {project_id}: {e}")
        try:
            # A failed re-stitch must not hide the final video the project already had.
            had_final = bool(project_data.get("finalVideoRef") or project_data.get("finalVideos"))
            project_ref.update({
                "status": "completed" if had_final else "failed",
                "errorMessage": str(e),
                "stitchError": str(e),
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
        except Exception as update_err:
            logger.error(f"Failed to record stitch failure in Firestore: {update_err}")

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


# ── Generate all scenes ──────────────────────────────────────────────────────────────────────────
# One background chain makes a take for every scene that has no video yet, in order (a scene that
# continues from the previous one needs that one finished first), and can stitch at the end.
# Progress lives in project.generateAll: {status, stitch, current, currentNumber, error, ...}.

GENERATE_ALL_QUIET_SECONDS = 2 * 60


def scene_order(project_ref) -> List[tuple]:
    """Every scene as (label shown to the user, doc id, data), in video order."""
    return ordered_scenes(project_ref)


def scenes_needing_video(project_ref) -> List[tuple]:
    """The scenes a "generate all" run would make: in the video and without a video yet."""
    return [
        item for item in scene_order(project_ref)
        if not is_scene_skipped(item[2]) and not item[2].get("storageRef")
    ]


def is_generate_all_alive(project_data: Dict[str, Any], scenes: List[tuple]) -> bool:
    """A run marked 'running' is alive while a scene is generating or it was heard from recently."""
    state = project_data.get("generateAll") or {}
    if state.get("status") not in ("running", "stitching"):
        return False
    if any(data.get("videoStatus") in ("queued", "generating") and not is_stale_job(data) for _, _, data in scenes):
        return True
    if project_data.get("status") == "stitching":
        started = _seconds(project_data.get("stitchStartedAt"))
        if started and datetime.datetime.now(datetime.timezone.utc).timestamp() - started < 10 * 60:
            return True
    heard = _seconds(state.get("updatedAt"))
    return bool(heard) and (datetime.datetime.now(datetime.timezone.utc).timestamp() - heard) < GENERATE_ALL_QUIET_SECONDS


def starting_source_for(scene_data: Dict[str, Any], is_first: bool) -> str:
    """The starting picture a scene uses (same rule as effectiveImageSource in the frontend)."""
    source = scene_data.get("imageSource")
    has_custom = bool(scene_data.get("customStartImageRef"))
    if source not in VALID_IMAGE_SOURCES:
        return "uploaded" if has_custom else ("creator" if is_first else "last_frame")
    if is_first and source in FROM_PREVIOUS_SOURCES:
        return "uploaded" if has_custom else "creator"
    return source


async def run_generate_all(uid: str, project_id: str, stitch: bool = False) -> None:
    await asyncio.to_thread(_run_generate_all_sync, uid, project_id, stitch)


def _run_generate_all_sync(uid: str, project_id: str, stitch: bool) -> None:
    db = firestore.client()
    project_ref = db.collection("projects").document(project_id)

    def set_state(**fields) -> None:
        update = {f"generateAll.{key}": value for key, value in fields.items()}
        update["generateAll.updatedAt"] = firestore.SERVER_TIMESTAMP
        try:
            project_ref.update(update)
        except Exception as e:  # e.g. the project was deleted meanwhile
            logger.warning("Could not record generate-all progress for project %s: %s", project_id, e)

    def cancelled() -> bool:
        snap = project_ref.get()
        return (not snap.exists) or bool(((snap.to_dict() or {}).get("generateAll") or {}).get("cancelRequested"))

    try:
        for number, scene_id, _ in scene_order(project_ref):
            if cancelled():
                set_state(status="cancelled", current=None, currentNumber=None)
                return

            project_data = project_ref.get().to_dict() or {}
            scene_ref = project_ref.collection("scenes").document(scene_id)
            scene_snap = scene_ref.get()
            if not scene_snap.exists:
                continue
            scene_data = scene_snap.to_dict() or {}
            if is_scene_skipped(scene_data) or scene_data.get("storageRef"):
                continue
            if scene_data.get("videoStatus") in ("queued", "generating") and not is_stale_job(scene_data):
                raise ValueError(f"Scene {number} is already making a take. Wait for it, then start again.")
            if not str(scene_data.get("prompt") or scene_data.get("script") or "").strip():
                raise ValueError(f"Scene {number} has no script or video prompt yet. Write it on the Script step.")

            prev_id, prev_data = find_previous_scene(project_ref, int(scene_id))
            source = starting_source_for(scene_data, is_first=prev_id is None)
            if source == "creator" and not project_data.get("startingImageRef"):
                raise ValueError(f"Scene {number} starts from the creator photo, but there is none. Add one in Step 1.")
            if source == "uploaded" and not (scene_data.get("customStartImageRef") or project_data.get("startingImageRef")):
                raise ValueError(f"Scene {number} has no starting picture. Upload one, or add a creator photo in Step 1.")
            if source in FROM_PREVIOUS_SOURCES and not (prev_data or {}).get("storageRef"):
                raise ValueError(f"Scene {number} continues from the scene before it, which has no video.")

            settings = project_data.get("settings") or {}
            model = get_video_model(settings.get("videoModel"))
            picture_count = sum(
                1 for item in (project_data.get("globalImages") or []) + (scene_data.get("sceneImages") or [])
                if isinstance(item, dict) and item.get("storageRef")
            )
            picture_limit = int(model.get("max_reference_images") or 0)
            if picture_count > picture_limit:
                raise ValueError(
                    f"Scene {number} uses {picture_count} context pictures and the limit is {picture_limit}. "
                    "Remove some on the Script step."
                )

            attempt = int(scene_data.get("attempt") or 0) + 1
            job_id = f"{project_id}_{scene_id}_{attempt}"
            db.collection("jobs").document(job_id).set({
                "jobId": job_id,
                "projectId": project_id,
                "sceneIndex": int(scene_id),
                "attempt": attempt,
                "userId": uid,
                "imageSource": source,
                "status": "queued",
                "createdAt": firestore.SERVER_TIMESTAMP,
            })
            scene_ref.update({
                "attempt": attempt,
                "videoStatus": "queued",
                "jobId": job_id,
                "errorMessage": None,
                "failedAttempt": None,
                "imageSource": source,
                "updatedAt": firestore.SERVER_TIMESTAMP,
                "heartbeatAt": firestore.SERVER_TIMESTAMP,
            })
            set_state(current=scene_id, currentNumber=number)

            _run_video_generation_job_sync(
                uid, project_id, int(scene_id), source, None,
                {
                    "duration_seconds": settings.get("duration", 8),
                    "aspect_ratio": settings.get("aspectRatio", "9:16"),
                    "resolution": settings.get("resolution", "1080p"),
                    "video_model": model["id"],
                    "edit_prompt": None,
                },
                attempt,
            )

            after = scene_ref.get().to_dict() or {}
            if not after.get("storageRef"):
                if cancelled():
                    set_state(status="cancelled", current=None, currentNumber=None)
                    return
                if after.get("videoStatus") != "failed":
                    # The take itself was cancelled on the scene: stop the run, the user took over.
                    set_state(status="cancelled", current=None, currentNumber=None)
                    return
                raise ValueError(f"Scene {number} failed: {after.get('errorMessage') or 'no video came back'}")

        if stitch and not cancelled():
            included = [item for item in scene_order(project_ref) if not is_scene_skipped(item[2])]
            if included and all(data.get("storageRef") for _, _, data in included):
                set_state(status="stitching", current=None, currentNumber=None)
                project_ref.update({
                    "status": "stitching",
                    "stitchStartedAt": firestore.SERVER_TIMESTAMP,
                    "errorMessage": None,
                    "stitchError": None,
                    "updatedAt": firestore.SERVER_TIMESTAMP,
                })
                _run_stitch_job_sync(uid, project_id, len(included), {})

        set_state(status="done", current=None, currentNumber=None, error=None)
        logger.info("Generate-all finished for project %s.", project_id)

    except Exception as e:
        logger.exception("Generate-all stopped for project %s: %s", project_id, e)
        set_state(status="failed", error=str(e), current=None, currentNumber=None)
