"""
Narration: a scene's voice made from text with the voice service, instead of the voice the video
model gave it. The text is the narration's own (it starts as the scene's script and may differ:
"[pause]" and "[pause 1.5]" add silences). Where it sits in the scene and how it is trimmed is
set in the editor (settings.narration.<scene id>); the stitch puts it on the scene
(see voiceover.scene_narration).
"""
import asyncio
import logging
import os
import shutil
import tempfile
import uuid
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, status
from firebase_admin import firestore
from pydantic import BaseModel, Field

from app import elevenlabs
from app.auth import get_current_user
from app.errors import user_message
from app.pipeline import probe_media
from app.storage import get_download_url, upload_file
from app.voiceover import project_voice

logger = logging.getLogger(__name__)
router = APIRouter()


class NarrationRequest(BaseModel):
    # What is read aloud. Left out, the scene's script is read.
    text: Optional[str] = Field(None, max_length=elevenlabs.SPEECH_MAX_CHARACTERS)


def _load(pid: str, n: int, uid: str) -> Tuple[Any, Dict[str, Any], Dict[str, Any]]:
    project_ref = firestore.client().collection("projects").document(pid)
    project_snap = project_ref.get()
    if not project_snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    project_data = project_snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")
    scene_ref = project_ref.collection("scenes").document(str(n))
    scene_snap = scene_ref.get()
    if not scene_snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Scene '{n}' not found in project '{pid}'.")
    return scene_ref, project_data, scene_snap.to_dict() or {}


def _speak_sync(uid: str, project_id: str, scene_id: str, text: str, voice: Dict[str, str]) -> Dict[str, Any]:
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_narration_{project_id}_{scene_id}_")
    try:
        local = os.path.join(temp_dir, "narration.mp3")
        elevenlabs.speak(text, voice["id"], local)
        seconds = float(probe_media(local).get("duration") or 0)
        if seconds <= 0:
            raise elevenlabs.VoiceServiceError("The voice service returned no audio. Try again.")
        storage_path = f"users/{uid}/projects/{project_id}/scenes/{scene_id}/narration_{uuid.uuid4().hex[:10]}.mp3"
        upload_file(local, storage_path, content_type="audio/mpeg")
        return {
            "text": text,
            "voiceId": voice["id"],
            "voiceName": voice["name"],
            "storageRef": storage_path,
            "url": get_download_url(storage_path),
            "seconds": round(seconds, 2),
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@router.post("/projects/{pid}/scenes/{n}/narration")
async def make_narration_endpoint(
    pid: str, n: int, request: NarrationRequest, current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Reads the text aloud in the voice chosen for the video and makes it the scene's narration
    ({text, voiceId, voiceName, storageRef, url, seconds}). Making it again replaces it.
    """
    uid = current_user["uid"]
    scene_ref, project_data, scene_data = _load(pid, n, uid)
    if not elevenlabs.is_configured():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The voice service is not set up on the server.")
    voice = project_voice(project_data)
    if not voice:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Choose a voice for the video first, in the Voice card on the Video step.",
        )
    text = " ".join((request.text if request.text is not None else str(scene_data.get("script") or "")).split())
    if not elevenlabs.without_pauses(text):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Write what the voice should say first.")
    try:
        narration = await asyncio.to_thread(_speak_sync, uid, pid, str(n), text, voice)
    except Exception as e:
        logger.exception("Making the narration failed for scene %s of project %s: %s", n, pid, e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=user_message(e, "Making the voice"))
    scene_ref.update({"narration": narration, "updatedAt": firestore.SERVER_TIMESTAMP})
    return narration


@router.delete("/projects/{pid}/scenes/{n}/narration")
async def remove_narration_endpoint(pid: str, n: int, current_user: Dict[str, Any] = Depends(get_current_user)):
    """Removes the scene's narration: it goes back to the sound of its own take."""
    scene_ref, _, _ = _load(pid, n, current_user["uid"])
    scene_ref.update({"narration": None, "updatedAt": firestore.SERVER_TIMESTAMP})
    return {"removed": True}
