import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Form, File, UploadFile
from fastapi.responses import JSONResponse
import firebase_admin
from firebase_admin import firestore
from app.auth import get_current_user
from app.models import JobStatus, ImageSourceEnum, SelectAttemptRequest
from app.jobs import missing_start_picture_message, start_picture_ref, FROM_PREVIOUS_SOURCES, run_video_generation_job, spawn_background, find_previous_scene, active_take_record, is_scene_skipped, is_stale_job
from app.model_registry import get_video_model, max_reference_images, refine_model_for_take

logger = logging.getLogger(__name__)
router = APIRouter()

@router.post("/projects/{pid}/scenes/{n}/generate", response_model=JobStatus, status_code=status.HTTP_202_ACCEPTED)
async def generate_scene_video_endpoint(
    pid: str,
    n: int,
    image_source: str = Form(..., description="Source of the starting image: 'uploaded', 'creator', 'last_frame', 'ai_cut' or 'extend'"),
    image: Optional[UploadFile] = File(None, description="Optional starting image for scene 0 or custom upload"),
    duration_seconds: Optional[int] = Form(8),
    aspect_ratio: Optional[str] = Form("9:16"),
    resolution: Optional[str] = Form("1080p"),
    edit_prompt: Optional[str] = Form(None, description="Optional prompt to edit the previous video generation"),
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Enqueues an asynchronous video generation job for scene {n} of project {pid}.
    Validates ownership, guarantees idempotency using deterministic doc ID {pid}_{sceneIndex}_{attempt},
    and returns 202 Accepted.
    """
    uid = current_user["uid"]

    # Validate image_source
    allowed_sources = [s.value for s in ImageSourceEnum]
    if image_source not in allowed_sources:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid image_source: '{image_source}'. Must be one of: {', '.join(allowed_sources)}.",
        )

    db = firestore.client()
    project_ref = db.collection("projects").document(pid)
    project_snap = project_ref.get()

    if not project_snap.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Project '{pid}' not found.",
        )

    project_data = project_snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to modify this project.",
        )

    scene_ref = project_ref.collection("scenes").document(str(n))
    scene_snap = scene_ref.get()
    if not scene_snap.exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Scene '{n}' not found in project '{pid}'.",
        )

    scene_data = scene_snap.to_dict() or {}
    current_attempt = scene_data.get("attempt", 0)

    if is_scene_skipped(scene_data):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This scene is skipped. Switch it back on to make a take.",
        )

    # Idempotency: while an attempt is in flight, return it instead of starting a duplicate
    # (a double click would otherwise run two jobs that write the same attempt).
    if scene_data.get("videoStatus") in ("queued", "generating") and not is_stale_job(scene_data):
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content={
                "job_id": scene_data.get("jobId") or f"{pid}_{n}_{current_attempt}",
                "status": scene_data.get("videoStatus"),
                "project_id": pid,
                "scene_index": n,
                "attempt": current_attempt,
                "message": "This scene is already generating. Wait for it to finish.",
            },
        )

    # A refinement continues the take in use through its Gemini Omni interaction, so that take must have one.
    # It reuses that take's starting frame and pictures, so the checks on starting pictures below are skipped.
    edit_prompt = (edit_prompt or "").strip() or None
    refining = bool(edit_prompt)
    if refining and not (scene_data.get("interactionId") and scene_data.get("storageRef")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only takes made with Gemini Omni can be refined. Make a new take instead.",
        )

    attempt = current_attempt + 1
    # Deterministic job doc ID: {pid}_{sceneIndex}_{attempt}
    job_id = f"{pid}_{n}_{attempt}"
    job_ref = db.collection("jobs").document(job_id)

    # Read uploaded image bytes if present
    image_bytes = None
    if image is not None:
        image_bytes = await image.read()

    # Fail fast if the chosen starting picture does not exist (instead of failing inside the background job).
    if not image_bytes and not refining:
        if image_source == "creator" and not start_picture_ref(project_data):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=missing_start_picture_message(project_data),
            )
        if image_source == "uploaded" and not (
            scene_data.get("customStartImageRef") or start_picture_ref(project_data)
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No starting picture found. Upload a custom picture for this scene or a creator photo in Step 1.",
            )

    # A scene that starts from the previous scene's last frame needs that video to exist and be settled.
    # The previous scene is the closest earlier one (deleting a scene leaves a gap in the indexes).
    if image_source in FROM_PREVIOUS_SOURCES and not refining:
        prev_id, prev_data = find_previous_scene(project_ref, n)
        if prev_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="There's no scene before this one in the video. Start it from the creator photo or a custom picture.",
            )
        if prev_data.get("videoStatus") in ("queued", "generating") and not is_stale_job(prev_data):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The previous scene is still generating. Wait for it to finish so this scene starts from the right frame.",
            )
        if not prev_data.get("storageRef"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The previous scene has no video yet. Generate it first, or choose another starting picture for this scene.",
            )

    # Pull configuration from Firestore project settings, fallback to form inputs/defaults.
    # The saved model is checked against the offered list; retired ones (e.g. Veo) fall back to the default.
    settings = project_data.get("settings", {})
    model_for_take = get_video_model(settings.get("videoModel"))["id"]

    # A refinement runs on the model its take was made with.
    if refining:
        refine_model = refine_model_for_take(active_take_record(scene_data).get("videoModel"))
        if not refine_model:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This take was made with a model that can't refine takes. Make a new take instead.",
            )
        model_for_take = refine_model

    # Fail fast on the picture budget.
    # Must run BEFORE the queued writes below so a rejected request never leaves the scene stuck in 'queued'.
    if not refining:
        picture_limit = max_reference_images(model_for_take)
        picture_count = sum(
            1
            for item in (project_data.get("globalImages") or []) + (scene_data.get("sceneImages") or [])
            if isinstance(item, dict) and item.get("storageRef")
        )
        if picture_count > picture_limit:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"This scene uses {picture_count} context pictures (video-wide + scene). "
                    f"The limit is {picture_limit}. Remove {picture_count - picture_limit} and try again."
                ),
            )

    # Record job doc and update scene doc
    job_data = {
        "jobId": job_id,
        "projectId": pid,
        "sceneIndex": n,
        "attempt": attempt,
        "userId": uid,
        "imageSource": image_source,
        "status": "queued",
        "createdAt": firestore.SERVER_TIMESTAMP,
    }
    job_ref.set(job_data)

    scene_update = {
        "attempt": attempt,
        "videoStatus": "queued",
        "jobId": job_id,
        "errorMessage": None,
        "failedAttempt": None,
        "updatedAt": firestore.SERVER_TIMESTAMP,
        "heartbeatAt": firestore.SERVER_TIMESTAMP,
    }
    if not refining:
        # A refinement keeps the start of the take it refines, so the user's choice for new takes stays as it is.
        scene_update["imageSource"] = image_source
    scene_ref.update(scene_update)

    config = {
        "duration_seconds": settings.get("duration", duration_seconds),
        "aspect_ratio": settings.get("aspectRatio", aspect_ratio),
        "resolution": settings.get("resolution", resolution),
        "video_model": model_for_take,
        "edit_prompt": edit_prompt,
    }

    # Enqueue background task (kept referenced until done; the job runs in a worker thread)
    spawn_background(
        run_video_generation_job(
            uid=uid,
            project_id=pid,
            scene_index=n,
            image_source=image_source,
            image_bytes=image_bytes,
            config=config,
            attempt=attempt,
        )
    )

    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "job_id": job_id,
            "status": "queued",
            "project_id": pid,
            "scene_index": n,
            "attempt": attempt,
            "message": "Video generation job enqueued successfully.",
        },
    )


@router.post("/projects/{pid}/scenes/{n}/cancel")
async def cancel_scene_generation(
    pid: str,
    n: int,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Cancels the take scene {n} is making. The scene is unlocked right away: it goes back to the take it
    was using (or to "no video yet"). The video request is stopped at Google when it already started;
    the job notices the flag and exits without writing anything.
    """
    uid = current_user["uid"]
    db = firestore.client()
    project_ref = db.collection("projects").document(pid)
    project_snap = project_ref.get()
    if not project_snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    if (project_snap.to_dict() or {}).get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")

    scene_ref = project_ref.collection("scenes").document(str(n))

    @firestore.transactional
    def flag_and_restore(txn) -> Optional[Dict[str, Any]]:
        """Returns the cancelled job's data, or None if the scene has nothing running."""
        scene_snap = scene_ref.get(transaction=txn)
        if not scene_snap.exists:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Scene '{n}' not found in project '{pid}'.")
        scene_data = scene_snap.to_dict() or {}
        if scene_data.get("videoStatus") not in ("queued", "generating"):
            return None
        job_id = scene_data.get("jobId") or f"{pid}_{n}_{scene_data.get('attempt', 0)}"
        job_ref = db.collection("jobs").document(job_id)
        job_snap = job_ref.get(transaction=txn)  # Read so the job's own commit can't interleave with this one.
        job_data = job_snap.to_dict() or {}

        had_video = bool(scene_data.get("storageRef")) and bool(scene_data.get("history"))
        txn.update(scene_ref, {
            "videoStatus": "completed" if had_video else "pending",
            "errorMessage": None,
            "failedAttempt": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        txn.set(job_ref, {
            "cancelRequested": True,
            "status": "cancelled",
            "cancelledAt": firestore.SERVER_TIMESTAMP,
        }, merge=True)
        return {"job_id": job_id, **job_data}

    cancelled_job = flag_and_restore(db.transaction())
    if cancelled_job is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This scene isn't making a take right now.")

    # Stop the request at Google so it isn't finished for nothing. If it hasn't started yet, the job sees the
    # flag before starting it; if this fails, the job cancels it on its next check (within a few seconds).
    interaction_id = cancelled_job.get("interactionId")
    if interaction_id:
        try:
            from app.pipeline import get_client
            await asyncio.to_thread(lambda: get_client().interactions.cancel(id=interaction_id))
        except Exception as e:
            logger.info(f"Could not cancel interaction {interaction_id} right away (the job will retry): {e}")

    logger.info(f"Cancelled take {cancelled_job.get('attempt')} of scene {n} in project {pid}.")
    return {"project_id": pid, "scene_index": n, "job_id": cancelled_job["job_id"], "status": "cancelled"}


@router.post("/projects/{pid}/scenes/{n}/select-attempt")
async def select_scene_attempt(
    pid: str,
    n: int,
    body: SelectAttemptRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Makes a past attempt the scene's active video. The active video is the one used for stitching,
    for the next scene's last-frame start, and as the base for Omni refinement edits.
    Other scenes are not touched.
    """
    uid = current_user["uid"]
    db = firestore.client()
    project_ref = db.collection("projects").document(pid)
    project_snap = project_ref.get()
    if not project_snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    if (project_snap.to_dict() or {}).get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")

    scene_ref = project_ref.collection("scenes").document(str(n))
    scene_snap = scene_ref.get()
    if not scene_snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Scene '{n}' not found in project '{pid}'.")

    scene_data = scene_snap.to_dict() or {}
    if scene_data.get("videoStatus") in ("queued", "generating"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This scene is generating a new attempt. Wait for it to finish, then choose an attempt.",
        )

    record = next(
        (h for h in (scene_data.get("history") or []) if isinstance(h, dict) and h.get("attempt") == body.attempt),
        None,
    )
    if not record or not record.get("storageRef"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Attempt {body.attempt} not found for this scene.")
    if not str(record["storageRef"]).startswith(f"users/{uid}/"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This attempt's video is outside your storage area.")

    scene_ref.update({
        "videoStatus": "completed",
        "storageRef": record["storageRef"],
        "videoUrl": record.get("videoUrl"),
        "interactionId": record.get("interactionId"),
        "activeAttempt": body.attempt,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })
    logger.info(f"Scene {n} of project {pid} now uses attempt {body.attempt}.")

    return {"project_id": pid, "scene_index": n, "active_attempt": body.attempt, "status": "completed"}
