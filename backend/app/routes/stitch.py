import asyncio
import logging
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
import firebase_admin
from firebase_admin import firestore
from app.auth import get_current_user
from app.models import StitchRequest, StitchResponse
from app.jobs import run_stitch_job, spawn_background, is_scene_skipped

logger = logging.getLogger(__name__)
router = APIRouter()

# A 'stitching' project whose stitch started this long ago is treated as abandoned
# (e.g. the server restarted mid-job), so the user can stitch again.
STALE_STITCH_SECONDS = 10 * 60


def _is_stale(ts: Any) -> bool:
    if not ts or not hasattr(ts, "timestamp"):
        return True
    return (datetime.now(timezone.utc).timestamp() - ts.timestamp()) > STALE_STITCH_SECONDS


@router.post("/projects/{pid}/stitch", response_model=StitchResponse, status_code=status.HTTP_202_ACCEPTED)
async def stitch_project_endpoint(
    pid: str,
    request: Optional[StitchRequest] = None,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Enqueues an asynchronous video stitch job for all scenes in project {pid}.
    Validates ownership and verifies that every scene has a video and none is making a new take.
    Returns 202 Accepted.
    """
    uid = current_user["uid"]

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

    # Verify all scenes exist and are completed
    scenes_stream = project_ref.collection("scenes").stream()
    scenes = list(scenes_stream)

    if not scenes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Project '{pid}' has no scenes to stitch.",
        )

    # Skipped scenes are left out of the final video, so they don't need a take.
    included = [s for s in scenes if not is_scene_skipped(s.to_dict())]
    if not included:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Every scene is skipped. Switch at least one scene back on to stitch.",
        )

    # A scene is ready when it has a video and is not making a new take. Older versions could leave a
    # scene that has a video marked 'pending' or 'failed'; its video (the take in use) is still stitched.
    incomplete_scenes = []
    for s in included:
        s_data = s.to_dict() or {}
        status_val = s_data.get("videoStatus")
        storage_ref = s_data.get("storageRef")
        if status_val in ("queued", "generating") or not storage_ref:
            incomplete_scenes.append(f"Scene {s.id} (status: {status_val})")

    if incomplete_scenes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot stitch: every scene in the video needs a finished video first. Not ready: {', '.join(incomplete_scenes)}",
        )

    if project_data.get("musicStatus") == "generating" and not _is_stale(project_data.get("musicStartedAt")):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The music track is still being made. Stitch once it's ready.",
        )

    # Idempotency: a second click while a stitch is running returns the running job
    # (two concurrent stitches would both claim the same version number).
    # stitchStartedAt is used rather than updatedAt, which any project edit refreshes.
    started_at = project_data.get("stitchStartedAt") or project_data.get("updatedAt")
    if project_data.get("status") == "stitching" and not _is_stale(started_at):
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content={
                "project_id": pid,
                "status": "stitching",
                "message": "The final video is already being stitched.",
            },
        )

    # Update project status to 'stitching'
    project_ref.update({
        "status": "stitching",
        "stitchStartedAt": firestore.SERVER_TIMESTAMP,
        "errorMessage": None,
        "stitchError": None,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })

    # The picture is copied as it is (no re-encode), so the final video keeps the scenes' aspect ratio.
    # The audio and music settings are read from the project by the job.
    config = {}

    # Enqueue background stitch job
    spawn_background(
        run_stitch_job(
            uid=uid,
            project_id=pid,
            scene_count=len(included),
            config=config,
        )
    )

    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={
            "project_id": pid,
            "status": "stitching",
            "message": "Video stitch job queued successfully.",
        },
    )
