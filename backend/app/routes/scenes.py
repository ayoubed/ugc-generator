import logging
import os
import shutil
import tempfile
from typing import Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException, status
import firebase_admin
from firebase_admin import firestore
from app.auth import get_current_user
from app.errors import user_message
from app.models import (
    GenerateScenesRequest,
    GenerateScenesResponse,
    Scene,
    ExtractAssetsRequest,
    ExtractAssetsResponse,
    AssetBible,
)
from app.pipeline import generate_script_and_scenes, extract_asset_bible
from app.model_registry import get_script_model
from app.jobs import is_stale_job
from app.storage import delete_prefix, download_file

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/extract-assets", response_model=ExtractAssetsResponse)
def extract_assets_endpoint(
    request: ExtractAssetsRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Drafts the Asset Bible (speaker, products and props, setting) from a video idea.
    Nothing is saved: the Idea page shows the draft for the user to edit, then saves it.

    A plain `def` on purpose: the LLM call blocks, so FastAPI runs this in a worker thread and the
    API keeps answering other requests meanwhile.
    """
    idea = request.idea.strip()
    if not idea:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Write your video idea first.")

    temp_dir = tempfile.mkdtemp(prefix="ugc_details_")
    try:
        pictures = _project_pictures(current_user["uid"], request.project_id, temp_dir)
        data = extract_asset_bible(
            idea=idea,
            llm_model=get_script_model(request.llm_model)["id"],
            pictures=pictures,
            product_name=request.product_name,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Asset Bible extraction failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=user_message(e, "Writing the details"),
        )
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
    return ExtractAssetsResponse(asset_bible=AssetBible(**data))


def project_picture_specs(uid: str, project_data: Dict[str, Any]) -> List[Dict[str, str]]:
    """
    The pictures the consistent details are written from: the creator photo first, then the
    video-wide pictures. Only files in the user's own storage area are used.
    """
    specs: List[Dict[str, str]] = []
    creator = project_data.get("startingImageRef") or ""
    if creator:
        specs.append({"storageRef": creator, "role": "speaker", "description": ""})
    for item in project_data.get("globalImages") or []:
        if isinstance(item, dict) and item.get("storageRef"):
            specs.append({
                "storageRef": item["storageRef"],
                "role": "reference",
                "description": str(item.get("description") or "").strip(),
            })
    return [s for s in specs if s["storageRef"].startswith(f"users/{uid}/") and ".." not in s["storageRef"]]


def _project_pictures(uid: str, project_id: Any, temp_dir: str) -> List[Dict[str, str]]:
    """Downloads the project's pictures. A picture that cannot be loaded is left out, not fatal."""
    if not project_id:
        return []
    snap = firestore.client().collection("projects").document(str(project_id)).get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{project_id}' not found.")
    project_data = snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to read this project.")

    pictures = []
    for number, spec in enumerate(project_picture_specs(uid, project_data)):
        ext = os.path.splitext(spec["storageRef"])[1].lower() or ".jpg"
        local_path = os.path.join(temp_dir, f"picture_{number}{ext}")
        try:
            download_file(spec["storageRef"], local_path)
        except Exception as e:
            logger.warning("Could not load a picture for the consistent details (%s): %s", spec["storageRef"], e)
            continue
        pictures.append({"path": local_path, "role": spec["role"], "description": spec["description"]})
    return pictures


@router.post("/generate-scenes", response_model=GenerateScenesResponse)
def generate_scenes_endpoint(
    request: GenerateScenesRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
):
    """
    Writes the script (~10-60s) and saves it as the project's scenes.

    Writing a script again replaces the scene texts. A scene that stays keeps its takes, pictures and
    take counter (its takes then show as "edited since"); scenes beyond the new count are deleted
    together with their files. Refused while a scene is making a take.

    A plain `def` on purpose: the LLM call blocks, so FastAPI runs this in a worker thread and the
    API keeps answering other requests meanwhile.
    """
    uid = current_user["uid"]
    project_id = request.project_id.strip()

    if not project_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="project_id cannot be empty.",
        )

    db = firestore.client()
    project_ref = db.collection("projects").document(project_id)
    project_snap = project_ref.get()

    if project_snap.exists:
        project_data = project_snap.to_dict() or {}
        # Enforce project ownership
        if project_data.get("userId") and project_data.get("userId") != uid:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have permission to access this project.",
            )
    else:
        # Create project if not exists yet
        project_ref.set({
            "projectId": project_id,
            "userId": uid,
            "title": request.idea[:40] if request.idea else "Untitled Project",
            "idea": request.idea,
            "status": "draft",
            "numScenes": request.num_scenes,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })

    # Prepare guidelines
    g = request.guidelines
    camera_specifics = g.camera_specifics if g else None
    lighting_restraints = g.lighting_restraints if g else None
    relatable_action = g.relatable_action if g else None
    script_tone = g.script_tone if g else None
    visual_consistency = g.visual_consistency if g else None
    audio_consistency = g.audio_consistency if g else None
    accent = g.accent if g else None

    # Descriptions of the video-wide context pictures, so the script can feature them
    project_data_now = (project_ref.get().to_dict() or {})
    context_image_descriptions = [
        (img.get("description") or "").strip()
        for img in (project_data_now.get("globalImages") or [])
        if isinstance(img, dict) and img.get("storageRef")
    ]
    context_image_descriptions = [d for d in context_image_descriptions if d]

    # The Idea page saves the Asset Bible on the project before calling this endpoint.
    asset_bible_dict = request.asset_bible.model_dump() if request.asset_bible else None

    try:
        result = generate_script_and_scenes(
            idea=request.idea,
            num_scenes=request.num_scenes,
            camera_specifics=camera_specifics,
            lighting_restraints=lighting_restraints,
            relatable_action=relatable_action,
            script_tone=script_tone,
            visual_consistency=visual_consistency,
            audio_consistency=audio_consistency,
            accent=accent,
            llm_model=get_script_model(request.llm_model)["id"],
            hook_style=request.hook_style,
            custom_hook_desc=request.custom_hook_desc or "",
            target_words_per_scene=request.target_words_per_scene,
            context_image_descriptions=context_image_descriptions,
            asset_bible=asset_bible_dict,
            structure=request.structure.model_dump() if request.structure else None,
            product_name=request.product_name,
        )
    except Exception as e:
        logger.exception(f"Failed to generate scenes with Gemini: {e}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=user_message(e, "Writing the script"),
        )

    raw_scenes = result.get("scenes", [])
    video_context = result.get("video_context", "")

    parsed_scenes = []
    for item in raw_scenes:
        if isinstance(item, dict):
            parsed_scenes.append(Scene(**item))
        elif isinstance(item, Scene):
            parsed_scenes.append(item)
        else:
            parsed_scenes.append(Scene.model_validate(item))

    # Save the scenes as documents "0".."n-1". Existing documents are read again here, after the slow
    # LLM call, so a take started meanwhile is not overwritten.
    scenes_col = project_ref.collection("scenes")
    existing = {snap.id: (snap.to_dict() or {}) for snap in scenes_col.stream()}
    busy = [sid for sid, data in existing.items() if data.get("videoStatus") in ("queued", "generating") and not is_stale_job(data)]
    if busy:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A scene is making a take right now. Wait for it to finish or cancel it, then write the script again.",
        )

    batch = db.batch()
    new_ids = set()
    for n, sc in enumerate(parsed_scenes):
        scene_id = str(n)
        new_ids.add(scene_id)
        content = {
            "index": n,
            "sceneIndex": n,
            "description": sc.description,
            "script": sc.script,
            "context": sc.context or "",
            "prompt": sc.prompt,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        if scene_id in existing:
            # Keeps takes, the take counter, pictures and the starting-picture choice.
            if existing[scene_id].get("variantOf") is not None:
                # It was an alternative of another scene; in the new script it is a scene of its own.
                content["variantOf"] = firestore.DELETE_FIELD
                content["skipped"] = False
            batch.set(scenes_col.document(scene_id), content, merge=True)
        else:
            batch.set(scenes_col.document(scene_id), {
                **content,
                "imageSource": "creator" if n == 0 else "last_frame",
                "videoStatus": "pending",
                "attempt": 0,
                "createdAt": firestore.SERVER_TIMESTAMP,
            })

    # Scenes the new script no longer has (a shorter script, or ids left over from deleted scenes).
    removed_ids = [sid for sid in existing if sid not in new_ids]
    for sid in removed_ids:
        batch.delete(scenes_col.document(sid))

    batch.update(
        project_ref,
        {
            "status": "scripted",
            "idea": request.idea,
            "numScenes": len(parsed_scenes),
            # The script writer writes the video context; the user edits it on the Scenes page.
            "settings.videoContext": video_context,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        },
    )
    batch.commit()

    for sid in removed_ids:
        try:
            delete_prefix(f"users/{uid}/projects/{project_id}/scenes/{sid}/")
        except Exception as e:
            logger.warning("Could not delete the files of removed scene %s in project %s: %s", sid, project_id, e)

    return GenerateScenesResponse(project_id=project_id, video_context=video_context, scenes=parsed_scenes)
