"""
Background music for the final video. One track runs under the whole video and is mixed in when
stitching (see pipeline.stitch_videos), so the music never changes from scene to scene.
"""
import asyncio
import datetime
import logging
import os
import shutil
import tempfile
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from firebase_admin import firestore
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.errors import user_message
from app.jobs import spawn_background
from app.model_registry import get_music_model
from app.pipeline import generate_music, MUSIC_VOLUMES
from app.storage import upload_file, get_download_url

logger = logging.getLogger(__name__)
router = APIRouter()

# A 'generating' music track that started this long ago is treated as abandoned (e.g. a restart).
STALE_MUSIC_SECONDS = 10 * 60

_EXTENSIONS = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/mp4": ".m4a"}


class GenerateMusicRequest(BaseModel):
    prompt: str = Field("", max_length=1000)
    model: Optional[str] = None
    volume: Optional[str] = None


def _is_running(project_data: Dict[str, Any]) -> bool:
    if project_data.get("musicStatus") != "generating":
        return False
    started = project_data.get("musicStartedAt")
    if not started or not hasattr(started, "timestamp"):
        return False
    return (datetime.datetime.now(datetime.timezone.utc).timestamp() - started.timestamp()) < STALE_MUSIC_SECONDS


def _run_music_job_sync(uid: str, project_id: str, prompt: str, model_id: str, volume: str, version: int) -> None:
    db = firestore.client()
    project_ref = db.collection("projects").document(project_id)
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_music_{project_id}_")
    try:
        local_raw = os.path.join(temp_dir, "music_raw")
        _, mime_type = generate_music(prompt, local_raw, model_id)
        ext = _EXTENSIONS.get((mime_type or "").split(";")[0].strip().lower(), ".mp3")
        local_path = local_raw + ext
        os.replace(local_raw, local_path)

        storage_path = f"users/{uid}/projects/{project_id}/music/music_v{version}{ext}"
        upload_file(local_path, storage_path, content_type=mime_type)
        url = get_download_url(storage_path)

        # Only this field is written, so other settings edited meanwhile are kept.
        project_ref.update({
            "settings.music": {
                "source": "generated",
                "storageRef": storage_path,
                "url": url,
                "name": f"AI music v{version}",
                "prompt": prompt,
                "model": model_id,
                "volume": volume,
            },
            "musicStatus": "ready",
            "musicError": None,
            "musicVersion": version,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        logger.info("Music v%s generated for project %s.", version, project_id)
    except Exception as e:
        logger.exception("Music generation failed for project %s: %s", project_id, e)
        try:
            project_ref.update({
                "musicStatus": "failed",
                "musicError": user_message(e, "Making the music"),
                "updatedAt": firestore.SERVER_TIMESTAMP,
            })
        except Exception as update_err:
            logger.error("Failed to record music failure: %s", update_err)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


async def run_music_job(**kwargs) -> None:
    await asyncio.to_thread(_run_music_job_sync, **kwargs)


@router.post("/projects/{pid}/music/generate", status_code=status.HTTP_202_ACCEPTED)
async def generate_music_endpoint(
    pid: str,
    request: GenerateMusicRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Makes an instrumental track for the whole video in the background (musicStatus on the project)."""
    uid = current_user["uid"]
    db = firestore.client()
    project_ref = db.collection("projects").document(pid)
    snap = project_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    project_data = snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")

    if _is_running(project_data):
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content={"project_id": pid, "status": "generating", "message": "A music track is already being made."},
        )

    model_id = get_music_model(request.model)["id"]
    current = (project_data.get("settings") or {}).get("music") or {}
    volume = request.volume if request.volume in MUSIC_VOLUMES else (current.get("volume") if current.get("volume") in MUSIC_VOLUMES else "medium")
    version = int(project_data.get("musicVersion") or 0) + 1
    prompt = request.prompt.strip()

    project_ref.update({
        "musicStatus": "generating",
        "musicStartedAt": firestore.SERVER_TIMESTAMP,
        "musicError": None,
        "musicPrompt": prompt,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })
    spawn_background(run_music_job(uid=uid, project_id=pid, prompt=prompt, model_id=model_id, volume=volume, version=version))

    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"project_id": pid, "status": "generating", "message": "Making the music track."},
    )
