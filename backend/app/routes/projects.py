"""
Whole-project actions: generate every missing scene in one go, duplicate a project, delete a project.
"""
import logging
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from firebase_admin import firestore
from pydantic import BaseModel, Field

from app.auth import get_current_user
from app.jobs import (
    is_generate_all_alive,
    is_stale_job,
    run_generate_all,
    scene_order,
    scenes_needing_video,
    spawn_background,
    scenes_to_remake,
)
from app.storage import copy_file, delete_prefix

logger = logging.getLogger(__name__)
router = APIRouter()


def _owned_project(pid: str, uid: str):
    db = firestore.client()
    project_ref = db.collection("projects").document(pid)
    snap = project_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    data = snap.to_dict() or {}
    if data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to modify this project.")
    return db, project_ref, data


class GenerateAllRequest(BaseModel):
    stitch: bool = False
    # Make one more take of a scene when the automatic check flags its first take.
    retake: bool = False
    # Scenes (ids) to make a NEW take of although they have a video, e.g. after the script changed.
    remake: List[str] = Field(default_factory=list, max_length=50)


@router.post("/projects/{pid}/generate-all", status_code=status.HTTP_202_ACCEPTED)
def generate_all_endpoint(
    pid: str,
    request: Optional[GenerateAllRequest] = None,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Makes a take for every scene that has no video yet, one after another, in the background.
    Scenes listed in `remake` get a new take although they have a video (their takes are kept).
    With stitch=true the final video is stitched when the last scene is done. With retake=true a
    scene whose first take is flagged by the automatic check gets one more take. Progress is in
    project.generateAll; the run stops at the first scene that fails.
    """
    uid = current_user["uid"]
    stitch = bool(request and request.stitch)
    retake = bool(request and request.retake)
    _, project_ref, project_data = _owned_project(pid, uid)

    scenes = scene_order(project_ref)
    if is_generate_all_alive(project_data, scenes):
        return JSONResponse(
            status_code=status.HTTP_202_ACCEPTED,
            content={"project_id": pid, "status": "running", "message": "The scenes are already being generated."},
        )
    busy = [number for number, _, data in scenes if data.get("videoStatus") in ("queued", "generating") and not is_stale_job(data)]
    if busy:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Scene {busy[0]} is making a take. Wait for it to finish or cancel it, then generate the rest.",
        )
    remake = scenes_to_remake(scenes, request.remake if request else [])
    todo = scenes_needing_video(project_ref)
    if not todo and not remake:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Every scene in the video already has a video.")

    project_ref.update({
        "generateAll": {
            "status": "running",
            "stitch": stitch,
            "retake": retake,
            "retaking": False,
            "total": len(todo) + len(remake),
            "remake": remake,
            "current": None,
            "currentNumber": None,
            "error": None,
            "cancelRequested": False,
            "startedAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        },
    })
    try:
        spawn_background(run_generate_all(uid=uid, project_id=pid, stitch=stitch, retake=retake, remake=remake))
    except Exception:
        # Never leave the project marked as running when nothing is running.
        project_ref.update({"generateAll.status": "failed", "generateAll.error": "Could not start. Try again."})
        raise
    return JSONResponse(
        status_code=status.HTTP_202_ACCEPTED,
        content={"project_id": pid, "status": "running", "scenes": len(todo) + len(remake), "message": "Generating the scenes."},
    )


@router.post("/projects/{pid}/generate-all/cancel")
async def cancel_generate_all_endpoint(
    pid: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Stops a generate-all run: the take being made is cancelled and no further scene is started."""
    uid = current_user["uid"]
    _, project_ref, project_data = _owned_project(pid, uid)
    state = project_data.get("generateAll") or {}
    if state.get("status") not in ("running", "stitching"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Nothing is being generated right now.")

    project_ref.update({
        "generateAll.cancelRequested": True,
        "generateAll.status": "cancelled",
        "generateAll.current": None,
        "generateAll.currentNumber": None,
        "generateAll.updatedAt": firestore.SERVER_TIMESTAMP,
    })

    current = state.get("current")
    if current is not None:
        from app.routes.generate import cancel_scene_generation
        try:
            await cancel_scene_generation(pid, int(current), current_user)
        except HTTPException as e:
            if e.status_code != status.HTTP_409_CONFLICT:  # 409 = that scene isn't generating any more
                raise
    return {"project_id": pid, "status": "cancelled"}


@router.post("/projects/{pid}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_project_endpoint(
    pid: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Copies a project: idea, creator photo, context pictures, consistent details, style settings, music
    and the script (every scene's text, pictures and starting-picture choice). Takes and final videos
    are not copied. Files are copied, so the two projects can be edited and deleted independently.
    """
    uid = current_user["uid"]
    db, source_ref, source = _owned_project(pid, uid)
    new_ref = db.collection("projects").document()
    old_prefix = f"users/{uid}/projects/{pid}/"
    new_prefix = f"users/{uid}/projects/{new_ref.id}/"

    def copy(path: Any) -> Tuple[Optional[str], Optional[str]]:
        """(new path, new url), or (None, None) when the file can't be copied."""
        if not path or not str(path).startswith(old_prefix):
            return None, None
        target = new_prefix + str(path)[len(old_prefix):]
        try:
            return target, copy_file(str(path), target)
        except Exception as e:
            logger.warning("Could not copy %s while duplicating project %s: %s", path, pid, e)
            return None, None

    starting_ref, _ = copy(source.get("startingImageRef"))

    pictures: List[Dict[str, Any]] = []
    for item in source.get("globalImages") or []:
        if not isinstance(item, dict):
            continue
        new_path, new_url = copy(item.get("storageRef"))
        if new_path:
            pictures.append({**item, "storageRef": new_path, "url": new_url})

    settings = dict(source.get("settings") or {})
    end_card = settings.get("endCard")
    if isinstance(end_card, dict) and end_card.get("imageRef"):
        card_path, card_url = copy(end_card["imageRef"])
        if card_path:
            settings["endCard"] = {**end_card, "imageRef": card_path, "imageUrl": card_url}
        else:
            settings.pop("endCard", None)
    # The reference video's breakdown is kept; the video itself is copied when possible.
    reference = settings.get("reference")
    if isinstance(reference, dict):
        ref_path, ref_url = copy(reference.get("storageRef"))
        if ref_path:
            settings["reference"] = {**reference, "storageRef": ref_path, "url": ref_url}
        else:
            settings.pop("reference", None)
    music = settings.get("music")
    if isinstance(music, dict) and music.get("storageRef"):
        new_path, new_url = copy(music["storageRef"])
        if new_path:
            settings["music"] = {**music, "storageRef": new_path, "url": new_url}
        else:
            settings.pop("music", None)
    # Sound effects sit on moments of takes, and takes are not copied.
    settings.pop("sounds", None)

    # The script: scene texts and pictures, without takes.
    scene_docs: List[Tuple[str, Dict[str, Any]]] = []
    for snap in source_ref.collection("scenes").stream():
        scene = snap.to_dict() or {}
        scene_pictures = []
        for item in scene.get("sceneImages") or []:
            if not isinstance(item, dict):
                continue
            new_path, new_url = copy(item.get("storageRef"))
            if new_path:
                scene_pictures.append({**item, "storageRef": new_path, "url": new_url})
        custom_ref, custom_url = copy(scene.get("customStartImageRef"))
        end_ref, end_url = copy(scene.get("endImageRef"))
        image_source = scene.get("imageSource")
        if image_source == "uploaded" and not custom_ref:
            image_source = None  # the custom picture could not be copied: fall back to the default start
        copied = {
            "index": scene.get("index", scene.get("sceneIndex")),
            "sceneIndex": scene.get("sceneIndex", scene.get("index")),
            "description": scene.get("description") or "",
            "script": scene.get("script") or "",
            "context": scene.get("context") or "",
            "prompt": scene.get("prompt") or "",
            "skipped": bool(scene.get("skipped")),
            "sceneImages": scene_pictures,
            "customStartImageRef": custom_ref,
            "customStartImageUrl": custom_url,
            "endImageRef": end_ref,
            "endImageUrl": end_url,
            "videoStatus": "pending",
            "attempt": 0,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        if image_source:
            copied["imageSource"] = image_source
        if scene.get("variantOf") is not None:
            copied["variantOf"] = scene.get("variantOf")
        scene_docs.append((snap.id, copied))

    title = str(source.get("title") or "Untitled UGC Project")
    batch = db.batch()
    for scene_id, copied in scene_docs:
        batch.set(new_ref.collection("scenes").document(scene_id), copied)
    batch.set(new_ref, {
        "userId": uid,
        "status": "scripted" if scene_docs else "draft",
        "title": f"Copy of {title}"[:80],
        "idea": source.get("idea") or "",
        "settings": settings,
        "startingImageRef": starting_ref or "",
        "globalImages": pictures,
        "copiedFrom": pid,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "updatedAt": firestore.SERVER_TIMESTAMP,
    })
    batch.commit()
    return {"project_id": new_ref.id, "scenes": len(scene_docs)}


@router.delete("/projects/{pid}")
def delete_project_endpoint(
    pid: str,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """Deletes a project with its scenes and every file it owns, and stops the takes it is making."""
    uid = current_user["uid"]
    db, project_ref, _ = _owned_project(pid, uid)

    # Running jobs check this flag before every write, so they stop without recreating anything.
    try:
        project_ref.update({"generateAll.cancelRequested": True})
    except Exception:
        pass
    batch = db.batch()
    for snap in project_ref.collection("scenes").stream():
        data = snap.to_dict() or {}
        if data.get("videoStatus") in ("queued", "generating"):
            job_id = data.get("jobId") or f"{pid}_{snap.id}_{data.get('attempt', 0)}"
            batch.set(db.collection("jobs").document(job_id), {
                "cancelRequested": True,
                "status": "cancelled",
                "cancelledAt": firestore.SERVER_TIMESTAMP,
            }, merge=True)
        batch.delete(snap.reference)
    batch.delete(project_ref)
    batch.commit()

    removed = 0
    try:
        removed = delete_prefix(f"users/{uid}/projects/{pid}/")
    except Exception as e:
        logger.warning("Project %s was deleted but some of its files could not be removed: %s", pid, e)
    return {"project_id": pid, "status": "deleted", "files_removed": removed}
