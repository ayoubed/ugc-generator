"""
The end card: a picture shown after the last scene. The user uploads it (saved by the app in
settings.endCard) and can change it here with a short instruction to the image model.
"""
import asyncio
import logging
import os
import shutil
import tempfile
import uuid
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, status
from firebase_admin import firestore
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.errors import user_message
from app.jobs import _assert_owned_path, collect_reference_specs
from app.pipeline import detect_image_mime, edit_end_card_picture
from app.storage import download_file, get_download_url, upload_file

logger = logging.getLogger(__name__)
router = APIRouter()

# Product pictures sent along, so the product stays exact.
MAX_END_CARD_PICTURES = 4


class EditEndCardRequest(BaseModel):
    instruction: str = Field(..., min_length=2, max_length=400)


def _edit_sync(uid: str, project_id: str, project_data: Dict[str, Any], instruction: str) -> Dict[str, str]:
    settings = project_data.get("settings") or {}
    card = settings.get("endCard") or {}
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_card_{project_id}_")
    try:
        current = os.path.join(temp_dir, "current" + (os.path.splitext(card["imageRef"])[1].lower() or ".jpg"))
        try:
            download_file(card["imageRef"], current)
        except Exception as e:
            raise ValueError("Could not load the end card picture. Upload it again.") from e
        pictures = []
        for i, spec in enumerate(collect_reference_specs(project_data, {}, uid)[:MAX_END_CARD_PICTURES]):
            local = os.path.join(temp_dir, f"product_{i}" + (os.path.splitext(spec["storageRef"])[1].lower() or ".jpg"))
            try:
                download_file(spec["storageRef"], local)
            except Exception as e:   # the card can still be changed without it
                logger.warning("Could not load a product picture for the end card of project %s: %s", project_id, e)
                continue
            pictures.append({"path": local, "description": spec["description"]})

        made = edit_end_card_picture(
            current, os.path.join(temp_dir, "made.png"), instruction,
            aspect_ratio=settings.get("aspectRatio", "9:16"), reference_images=pictures,
            image_model=settings.get("imageModel"),
        )
        ext = ".jpg" if detect_image_mime(made) == "image/jpeg" else ".png"
        storage_path = f"users/{uid}/projects/{project_id}/end_card_{uuid.uuid4().hex[:10]}{ext}"
        upload_file(made, storage_path, content_type=detect_image_mime(made))
        return {"imageRef": storage_path, "imageUrl": get_download_url(storage_path)}
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@router.post("/projects/{pid}/end-card/edit")
async def edit_end_card_endpoint(
    pid: str, request: EditEndCardRequest, current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Changes the end card picture as asked and makes the result the end card. The picture it
    replaces is kept in settings.endCard.previous, so one change can be taken back.
    """
    uid = current_user["uid"]
    project_ref = firestore.client().collection("projects").document(pid)
    snap = project_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    project_data = snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")
    card = (project_data.get("settings") or {}).get("endCard")
    if not isinstance(card, dict) or not card.get("imageRef"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Add a picture to the end card first.")
    _assert_owned_path(uid, card["imageRef"], "end card picture")

    instruction = " ".join(request.instruction.split())
    try:
        made = await asyncio.to_thread(_edit_sync, uid, pid, project_data, instruction)
    except Exception as e:
        logger.exception("Changing the end card failed for project %s: %s", pid, e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=user_message(e, "Changing the end card"))

    project_ref.update({
        "settings.endCard.imageRef": made["imageRef"],
        "settings.endCard.imageUrl": made["imageUrl"],
        "settings.endCard.previous": {"imageRef": card["imageRef"], "imageUrl": card.get("imageUrl")},
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })
    return made
