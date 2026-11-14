"""
Sound effects for the editor on the Video step. A sound is made from a short description and
stored with the project; the editor then places it on the timeline (settings.sounds.<id>) and the
stitch mixes it in (see jobs.project_sounds and pipeline.place_sounds).
"""
import asyncio
import logging
import os
import shutil
import tempfile
import uuid
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from firebase_admin import firestore
from pydantic import BaseModel, Field

from app import elevenlabs
from app.auth import get_current_user
from app.errors import user_message
from app.pipeline import probe_media
from app.storage import get_download_url, upload_file

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_SOUNDS_PER_PROJECT = 30


class MakeSoundRequest(BaseModel):
    prompt: str = Field(..., min_length=2, max_length=300)
    # Length in seconds; left out, the service picks one that suits the sound.
    seconds: Optional[float] = Field(None, ge=elevenlabs.SOUND_MIN_SECONDS, le=elevenlabs.SOUND_MAX_SECONDS)


def sound_name(prompt: str) -> str:
    """A short label for the timeline, from the description."""
    words = " ".join(prompt.split())
    label = words if len(words) <= 32 else words[:31].rstrip() + "…"
    return label[:1].upper() + label[1:]


def _make_sound_sync(uid: str, project_id: str, prompt: str, seconds: Optional[float]) -> Dict[str, Any]:
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_sound_{project_id}_")
    try:
        sound_id = uuid.uuid4().hex[:12]
        local = os.path.join(temp_dir, f"{sound_id}.mp3")
        elevenlabs.make_sound(prompt, local, seconds)
        length = float(probe_media(local).get("duration") or 0)
        if length <= 0:
            raise elevenlabs.VoiceServiceError("The sound service returned no audio. Try a different description.")
        storage_path = f"users/{uid}/projects/{project_id}/sounds/{sound_id}.mp3"
        upload_file(local, storage_path, content_type="audio/mpeg")
        return {
            "id": sound_id,
            "name": sound_name(prompt),
            "prompt": prompt,
            "storageRef": storage_path,
            "url": get_download_url(storage_path),
            "seconds": round(length, 2),
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@router.post("/projects/{pid}/sounds")
async def make_sound_endpoint(
    pid: str,
    request: MakeSoundRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Makes one sound effect and returns it ({id, name, prompt, storageRef, url, seconds}). It is not
    placed anywhere yet: the editor saves where it goes.
    """
    uid = current_user["uid"]
    snap = firestore.client().collection("projects").document(pid).get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    project_data = snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")
    if not elevenlabs.is_configured():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Sound effects are not set up on the server.")
    placed = (project_data.get("settings") or {}).get("sounds")
    if isinstance(placed, dict) and len(placed) >= MAX_SOUNDS_PER_PROJECT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"This video already has {MAX_SOUNDS_PER_PROJECT} sound effects. Remove one to add another.",
        )
    prompt = " ".join(request.prompt.split())
    try:
        return await asyncio.to_thread(_make_sound_sync, uid, pid, prompt, request.seconds)
    except Exception as e:
        logger.exception("Making a sound failed for project %s: %s", pid, e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=user_message(e, "Making the sound"))
