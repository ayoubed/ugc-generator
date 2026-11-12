"""
Start a project from a video that works (e.g. a competitor's ad). The video is watched once and
broken down into its structure: hook, parts, pacing, music mood, call to action. The user corrects
the breakdown on the Idea page, and the script writer follows it for the user's own product.

Only the structure is reused. The reference's words are shown but never sent to the script writer,
and its frames are never used as pictures.
"""
import asyncio
import datetime
import logging
import os
import shutil
import tempfile
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from firebase_admin import firestore

from app.auth import get_current_user
from app.jobs import spawn_background
from app.models import AnalyseReferenceRequest
from app.pipeline import analyse_reference_video
from app.storage import download_file

logger = logging.getLogger(__name__)
router = APIRouter()

# An analysis that started this long ago is treated as abandoned (e.g. a restart).
STALE_REFERENCE_SECONDS = 10 * 60

_MIME_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/mp4"}


def _is_running(project_data: Dict[str, Any]) -> bool:
    if project_data.get("referenceStatus") != "analysing":
        return False
    started = project_data.get("referenceStartedAt")
    if not started or not hasattr(started, "timestamp"):
        return False
    return (datetime.datetime.now(datetime.timezone.utc).timestamp() - started.timestamp()) < STALE_REFERENCE_SECONDS


def _run_reference_job_sync(project_id: str, storage_ref: str) -> None:
    db = firestore.client()
    project_ref = db.collection("projects").document(project_id)
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_reference_{project_id}_")
    try:
        ext = os.path.splitext(storage_ref)[1].lower()
        local_path = os.path.join(temp_dir, f"reference{ext if ext in _MIME_TYPES else '.mp4'}")
        download_file(storage_ref, local_path)
        breakdown = analyse_reference_video(local_path, _MIME_TYPES.get(ext, "video/mp4"))
        if not breakdown.get("scenes"):
            raise RuntimeError("No parts were found in the video. Try a different video.")

        snap = project_ref.get()
        current = ((snap.to_dict() or {}).get("settings") or {}).get("reference") or {}
        if not snap.exists or current.get("storageRef") != storage_ref:
            return  # the video was removed or replaced meanwhile
        # Only these fields are written, so other settings edited meanwhile are kept.
        project_ref.update({
            "settings.reference.breakdown": breakdown,
            "referenceStatus": "ready",
            "referenceError": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        logger.info("Reference video analysed for project %s: %s parts.", project_id, len(breakdown["scenes"]))
    except Exception as e:
        logger.exception("Reference analysis failed for project %s: %s", project_id, e)
        try:
            project_ref.update({
                "referenceStatus": "failed",
                "referenceError": str(e)[:500],
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
        except Exception as update_err:
            logger.error("Failed to record the reference analysis failure: %s", update_err)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


async def run_reference_job(**kwargs) -> None:
    await asyncio.to_thread(_run_reference_job_sync, **kwargs)


@router.post("/projects/{pid}/reference/analyse", status_code=status.HTTP_202_ACCEPTED)
async def analyse_reference_endpoint(
    pid: str,
    request: AnalyseReferenceRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Breaks down an uploaded reference video in the background. Progress is in referenceStatus on the
    project; the result lands in settings.reference.breakdown.
    """
    uid = current_user["uid"]
    db = firestore.client()
    project_ref = db.collection("projects").document(pid)
    snap = project_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    project_data = snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")

    storage_ref = request.storage_ref.strip()
    if not storage_ref.startswith(f"users/{uid}/projects/{pid}/reference/") or ".." in storage_ref:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="That video does not belong to this project.")

    if _is_running(project_data):
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content={"project_id": pid, "status": "analysing", "message": "The video is already being analysed."},
        )

    project_ref.update({
        "referenceStatus": "analysing",
        "referenceStartedAt": firestore.SERVER_TIMESTAMP,
        "referenceError": None,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })
    try:
        spawn_background(run_reference_job(project_id=pid, storage_ref=storage_ref))
    except Exception:
        project_ref.update({"referenceStatus": "failed", "referenceError": "Could not start. Try again."})
        raise
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"project_id": pid, "status": "analysing", "message": "Watching the video."},
    )
