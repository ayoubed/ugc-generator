"""
Voices for "one voice for the whole video": the list to choose from, and a preview that re-voices
every scene ahead of the stitch so the editor can play the chosen voice. The re-voiced audio is the
same file the stitch uses, so the preview costs nothing extra.
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

from app import elevenlabs
from app.auth import get_current_user
from app.errors import user_message
from app.jobs import _assert_owned_path, is_scene_skipped, ordered_scenes, spawn_background
from app.pipeline import probe_media
from app.storage import download_file, get_download_url
from app.voiceover import project_voice, revoiced_audio

logger = logging.getLogger(__name__)
router = APIRouter()

STALE_PREVIEW_SECONDS = 10 * 60


@router.get("/voices")
def list_voices_endpoint(current_user: Dict[str, Any] = Depends(get_current_user)):
    """
    The voices one video can be re-voiced to. `available` is false when the voice service is not
    set up, and the Video step then does not offer the choice.

    A plain `def` on purpose: the request to the voice service blocks.
    """
    if not elevenlabs.is_configured():
        return {"available": False, "voices": []}
    try:
        return {"available": True, "voices": elevenlabs.list_voices()}
    except elevenlabs.VoiceServiceError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))


def _run_voice_preview_sync(uid: str, project_id: str, voice_id: str) -> None:
    """Re-voices every scene in the video to `voice_id` and records where each result can be played."""
    project_ref = firestore.client().collection("projects").document(project_id)
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_voice_{project_id}_")
    try:
        scenes = [(label, doc_id, data) for label, doc_id, data in ordered_scenes(project_ref)
                  if not is_scene_skipped(data) and data.get("storageRef")]
        done: Dict[str, Any] = {}
        for label, doc_id, data in scenes:
            _assert_owned_path(uid, data["storageRef"], f"video of scene {label}")
            local_video = os.path.join(temp_dir, f"scene_{doc_id}.mp4")
            download_file(data["storageRef"], local_video)
            if not probe_media(local_video).get("has_audio"):
                continue
            _, cache_ref = revoiced_audio(uid, project_id, doc_id, data.get("activeAttempt"), local_video, voice_id, temp_dir)
            done[doc_id] = {"attempt": data.get("activeAttempt"), "url": get_download_url(cache_ref)}
            # Written scene by scene, so the editor can play the first ones while the rest are made.
            project_ref.update({f"voicePreview.scenes.{doc_id}": done[doc_id], "voicePreview.updatedAt": firestore.SERVER_TIMESTAMP})

        current = project_voice(project_ref.get().to_dict() or {})
        if not current or current["id"] != voice_id:
            return   # another voice was chosen meanwhile; its own run records the result
        project_ref.update({"voicePreview.status": "ready", "voicePreview.error": None})
        logger.info("Voice preview ready for project %s (%s scenes).", project_id, len(done))
    except Exception as e:
        logger.exception("Voice preview failed for project %s: %s", project_id, e)
        try:
            project_ref.update({"voicePreview.status": "failed", "voicePreview.error": user_message(e, "Preparing the voice")})
        except Exception as update_err:
            logger.error("Failed to record the voice preview failure: %s", update_err)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


async def run_voice_preview(**kwargs) -> None:
    await asyncio.to_thread(_run_voice_preview_sync, **kwargs)


def _preview_running(project_data: Dict[str, Any], voice_id: str) -> bool:
    preview = project_data.get("voicePreview") if isinstance(project_data.get("voicePreview"), dict) else {}
    started = preview.get("startedAt")
    if preview.get("status") != "building" or preview.get("voiceId") != voice_id or not hasattr(started, "timestamp"):
        return False
    return (datetime.datetime.now(datetime.timezone.utc).timestamp() - started.timestamp()) < STALE_PREVIEW_SECONDS


@router.post("/projects/{pid}/voice/preview", status_code=status.HTTP_202_ACCEPTED)
async def voice_preview_endpoint(pid: str, current_user: Dict[str, Any] = Depends(get_current_user)):
    """
    Re-voices the project's scenes to the voice chosen for it, in the background, so the editor can
    play it before the stitch. Progress and the playable files are in voicePreview on the project.
    """
    uid = current_user["uid"]
    project_ref = firestore.client().collection("projects").document(pid)
    snap = project_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    project_data = snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")
    voice = project_voice(project_data)
    if not voice:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Choose a voice for the video first.")
    if not elevenlabs.is_configured():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The voice service is not set up on the server.")
    if _preview_running(project_data, voice["id"]):
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content={"project_id": pid, "status": "building"})

    project_ref.update({"voicePreview": {
        "voiceId": voice["id"], "status": "building", "error": None, "scenes": {},
        "startedAt": firestore.SERVER_TIMESTAMP,
    }})
    try:
        spawn_background(run_voice_preview(uid=uid, project_id=pid, voice_id=voice["id"]))
    except Exception:
        project_ref.update({"voicePreview.status": "failed", "voicePreview.error": "Could not start. Try again."})
        raise
    return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content={"project_id": pid, "status": "building"})
