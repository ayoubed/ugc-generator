"""
The Storyboard step: frames of a scene made with the image model before any video is made.
See app/storyboard.py for what a frame is and how an accepted one becomes the scene's start.
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, status
from firebase_admin import firestore
from pydantic import BaseModel, Field

from app import storyboard
from app.auth import get_current_user
from app.errors import user_message

logger = logging.getLogger(__name__)
router = APIRouter()


class NewFrameRequest(BaseModel):
    # What the frame shows. Left out, the scene's own description is used.
    description: Optional[str] = Field(None, max_length=600)
    # A picture the user uploaded, used as the frame as it is (nothing is drawn).
    storage_ref: Optional[str] = Field(None, max_length=1024)


class RemakeFrameRequest(BaseModel):
    description: Optional[str] = Field(None, max_length=600)
    # A change to the picture the frame has ("make the watch smaller"). Without it, a new picture is drawn.
    instruction: Optional[str] = Field(None, max_length=400)


class EditFrameRequest(BaseModel):
    accepted: Optional[bool] = None
    look: Optional[bool] = None
    description: Optional[str] = Field(None, max_length=600)


class OrderRequest(BaseModel):
    ids: List[str] = Field(..., max_length=storyboard.MAX_FRAMES_PER_SCENE)


def _load(pid: str, n: int, uid: str) -> Tuple[Any, Any, Dict[str, Any], Dict[str, Any]]:
    """(project ref, scene ref, project data, scene data) of a scene the user owns."""
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
    return project_ref, scene_ref, project_data, scene_snap.to_dict() or {}


def _all_scenes(project_ref) -> List[tuple]:
    scenes = [(snap.id, snap.to_dict() or {}) for snap in project_ref.collection("scenes").stream()]
    return sorted(scenes, key=lambda item: int(item[0]) if str(item[0]).isdigit() else 0)


def _frame(frames: List[Dict[str, Any]], fid: str) -> Dict[str, Any]:
    frame = next((f for f in frames if f["id"] == fid), None)
    if frame is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This frame no longer exists.")
    return frame


def _save(scene_ref, frames: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Writes the frames (read fresh, so another frame finished meanwhile is not lost) and returns the storyboard."""
    scene_data = scene_ref.get().to_dict() or {}
    update = storyboard.scene_update_for(scene_data, frames)
    update["updatedAt"] = firestore.SERVER_TIMESTAMP
    scene_ref.update(update)
    return {"storyboard": update["storyboard"]}


def _merge(scene_ref, changed: Dict[str, Any], add: bool = False) -> List[Dict[str, Any]]:
    """The scene's frames as they are now, with `changed` put in place (or added at the end)."""
    frames = storyboard.frames_in_order(scene_ref.get().to_dict() or {})
    if any(f["id"] == changed["id"] for f in frames):
        return [changed if f["id"] == changed["id"] else f for f in frames]
    if not add:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This frame was removed while its picture was being made.")
    return frames + [changed]


async def _draw(uid, pid, n, frame, project_data, scene_data, scenes, instruction=None) -> Dict[str, Any]:
    try:
        return await asyncio.to_thread(
            storyboard.draw_frame, uid, pid, str(n), frame, project_data, scene_data, scenes, instruction
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Drawing a storyboard frame failed for scene %s of project %s: %s", n, pid, e)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=user_message(e, "Making the frame"))


@router.post("/projects/{pid}/scenes/{n}/storyboard/frames")
async def add_frame_endpoint(
    pid: str, n: int, request: NewFrameRequest, current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Adds a frame to the scene: drawn by the image model, or a picture the user uploaded."""
    uid = current_user["uid"]
    project_ref, scene_ref, project_data, scene_data = _load(pid, n, uid)
    frames = storyboard.frames_in_order(scene_data)
    if len(frames) >= storyboard.MAX_FRAMES_PER_SCENE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"A scene can have {storyboard.MAX_FRAMES_PER_SCENE} frames at most. Remove one to add another.",
        )
    description = " ".join((request.description or "").split()) or storyboard.default_moment(scene_data)
    frame = {"id": storyboard.new_frame_id(), "description": description, "accepted": False, "look": False, "version": 0}

    if request.storage_ref:
        if not request.storage_ref.startswith(f"users/{uid}/projects/{pid}/"):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This picture is outside this project's files.")
        frame.update({
            "imageRef": request.storage_ref,
            "imageUrl": storyboard.get_download_url(request.storage_ref),
            "version": 1,
            "issues": [],
            "checked": False,
            "source": "upload",
            "updatedAt": storyboard.now_iso(),
        })
    else:
        if not description:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Describe what this frame shows first.")
        frame = await _draw(uid, pid, n, frame, project_data, scene_data, _all_scenes(project_ref))
    return _save(scene_ref, _merge(scene_ref, frame, add=True))


@router.post("/projects/{pid}/scenes/{n}/storyboard/frames/{fid}/remake")
async def remake_frame_endpoint(
    pid: str, n: int, fid: str, request: RemakeFrameRequest, current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    A new picture for a frame: drawn again from its description, or, with an instruction, the
    picture it has changed as asked. The new picture is not accepted until the user accepts it.
    """
    uid = current_user["uid"]
    project_ref, scene_ref, project_data, scene_data = _load(pid, n, uid)
    frame = dict(_frame(storyboard.frames_in_order(scene_data), fid))
    description = " ".join((request.description or "").split())
    if description:
        frame["description"] = description
    frame = await _draw(uid, pid, n, frame, project_data, scene_data, _all_scenes(project_ref), request.instruction)
    return _save(scene_ref, _merge(scene_ref, frame))


@router.patch("/projects/{pid}/scenes/{n}/storyboard/frames/{fid}")
async def edit_frame_endpoint(
    pid: str, n: int, fid: str, request: EditFrameRequest, current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Accepts a frame (the first accepted frame becomes the picture the scene's video starts on),
    takes that back, marks it as the look of the video, or changes its description.
    """
    uid = current_user["uid"]
    project_ref, scene_ref, _, scene_data = _load(pid, n, uid)
    frames = storyboard.frames_in_order(scene_data)
    frame = dict(_frame(frames, fid))

    if request.description is not None:
        frame["description"] = " ".join(request.description.split())
    if request.accepted is not None:
        if request.accepted and not frame.get("imageRef"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This frame has no picture yet.")
        frame["accepted"] = request.accepted
        if not request.accepted:
            frame["look"] = False
        elif request.look is None and not storyboard.has_look_frame(_all_scenes(project_ref)):
            # The first frame accepted in a video sets its look: later frames are drawn to match it.
            frame["look"] = True
    if request.look is not None:
        if request.look and not frame.get("accepted"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Accept this frame first.")
        frame["look"] = request.look
    return _save(scene_ref, [frame if f["id"] == fid else f for f in frames])


@router.delete("/projects/{pid}/scenes/{n}/storyboard/frames/{fid}")
async def remove_frame_endpoint(
    pid: str, n: int, fid: str, current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Removes a frame. If the scene started on it, the scene goes back to how it started before."""
    _, scene_ref, _, scene_data = _load(pid, n, current_user["uid"])
    frames = storyboard.frames_in_order(scene_data)
    _frame(frames, fid)
    return _save(scene_ref, [f for f in frames if f["id"] != fid])


@router.put("/projects/{pid}/scenes/{n}/storyboard/order")
async def order_frames_endpoint(
    pid: str, n: int, request: OrderRequest, current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Puts the scene's frames in the given order. Every frame must be named exactly once."""
    _, scene_ref, _, scene_data = _load(pid, n, current_user["uid"])
    frames = {f["id"]: f for f in storyboard.frames_in_order(scene_data)}
    if sorted(request.ids) != sorted(frames):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The frames changed meanwhile. Reload and try again.")
    return _save(scene_ref, [frames[fid] for fid in request.ids])
