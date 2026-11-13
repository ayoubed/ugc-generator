"""
Export a project for another editor: a zip with the scene clips, the music, the end card picture,
a timeline file (Final Cut Pro 7 XML, read by Premiere Pro and DaVinci Resolve) and the captions
as SRT. Built in the background; progress is in packageStatus on the project.
"""
import asyncio
import datetime
import logging
import os
import shutil
import tempfile
import zipfile
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from firebase_admin import firestore

from app.auth import get_current_user
from app.captions import caption_style
from app.errors import user_message
from app.interchange import build_readme, build_srt, build_xmeml, caption_cues, kept_range, slug
from app.jobs import _assert_owned_path, is_scene_skipped, ordered_scenes, project_music, scene_edits, spawn_background
from app.pipeline import probe_media
from app.storage import download_file, get_download_url, upload_file
from app.voiceover import saved_alignment

logger = logging.getLogger(__name__)
router = APIRouter()

STALE_PACKAGE_SECONDS = 10 * 60


def current_version(project_data: Dict[str, Any]) -> Dict[str, Any]:
    """The final video the project shows now (for the automatic cuts it recorded), or {}."""
    versions = [v for v in (project_data.get("finalVideos") or []) if isinstance(v, dict)]
    wanted = project_data.get("finalVideoVersion")
    return next((v for v in versions if v.get("version") == wanted), versions[-1] if versions else {})


def _is_running(project_data: Dict[str, Any]) -> bool:
    started = project_data.get("packageStartedAt")
    if project_data.get("packageStatus") != "building" or not hasattr(started, "timestamp"):
        return False
    return (datetime.datetime.now(datetime.timezone.utc).timestamp() - started.timestamp()) < STALE_PACKAGE_SECONDS


def _run_package_job_sync(uid: str, project_id: str) -> None:
    db = firestore.client()
    project_ref = db.collection("projects").document(project_id)
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_package_{project_id}_")
    try:
        project_data = project_ref.get().to_dict() or {}
        settings = project_data.get("settings") or {}
        scenes = [(label, doc_id, data) for label, doc_id, data in ordered_scenes(project_ref) if not is_scene_skipped(data)]
        if not scenes or not all(data.get("storageRef") for _, _, data in scenes):
            raise ValueError("Every scene in the video needs a video before the project can be exported.")

        name = str(project_data.get("title") or "Video").strip() or "Video"
        folder = slug(name)
        media_dir = os.path.join(temp_dir, "media")
        os.makedirs(media_dir)
        version = current_version(project_data)
        edits = scene_edits(project_data, scenes)
        captions_on = caption_style((settings.get("captions") or {}).get("style") if isinstance(settings.get("captions"), dict) else None)
        own_texts = (settings.get("captions") or {}).get("texts") if isinstance(settings.get("captions"), dict) else {}
        own_texts = own_texts if isinstance(own_texts, dict) else {}

        clips: List[Dict[str, Any]] = []
        at = 0.0
        size: Dict[str, Any] = {}
        for position, (label, doc_id, data) in enumerate(scenes):
            _assert_owned_path(uid, data["storageRef"], f"video of scene {label}")
            file_name = f"scene_{position + 1:02d}.mp4"
            local = os.path.join(media_dir, file_name)
            download_file(data["storageRef"], local)
            info = probe_media(local)
            size = size or {k: info.get(k) for k in ("width", "height", "fps")}
            cut = (version.get("cuts") or {}).get(doc_id) or {}
            cut = cut if cut.get("attempt") == data.get("activeAttempt") else {}
            edit = edits[position] or {}
            start, end = kept_range(float(info["duration"]), edit, cut, (version.get("edits") or {}).get(doc_id))
            text = own_texts[doc_id] if isinstance(own_texts.get(doc_id), str) else str(data.get("script") or "")
            clips.append({
                "name": f"Scene {label}", "file": f"media/{file_name}", "duration": float(info["duration"]),
                "start": start, "end": end, "at": at, "has_audio": bool(info.get("has_audio")), "muted": bool(edit.get("muted")),
                "text": text if captions_on else "", "words": saved_alignment(data, data.get("activeAttempt"), text.strip()),
            })
            at += end - start

        music_entry = None
        music = project_music(project_data)
        if music:
            _assert_owned_path(uid, music["storageRef"], "music track")
            file_name = "music" + (os.path.splitext(music["storageRef"])[1].lower() or ".mp3")
            download_file(music["storageRef"], os.path.join(media_dir, file_name))
            music_entry = {"file": f"media/{file_name}", "duration": float(probe_media(os.path.join(media_dir, file_name))["duration"])}

        card_entry = None
        card = settings.get("endCard") if isinstance(settings.get("endCard"), dict) else {}
        if card.get("enabled") and card.get("imageRef"):
            _assert_owned_path(uid, card["imageRef"], "end card picture")
            file_name = "end_card" + (os.path.splitext(card["imageRef"])[1].lower() or ".jpg")
            download_file(card["imageRef"], os.path.join(media_dir, file_name))
            seconds = card.get("seconds") if isinstance(card.get("seconds"), (int, float)) else 2.5
            card_entry = {"file": f"media/{file_name}", "seconds": float(seconds)}

        cues = caption_cues(clips)
        files = {
            "timeline.xml": build_xmeml({
                "name": name, "fps": size.get("fps") or 24, "width": size.get("width") or 720, "height": size.get("height") or 1280,
                "clips": clips, "end_card": card_entry, "music": music_entry,
            }),
            "captions.srt": build_srt(cues),
            "README.txt": build_readme(name, bool(cues), bool(music_entry), bool(card_entry)),
        }
        zip_path = os.path.join(temp_dir, f"{folder}.zip")
        # Stored, not compressed: video and audio are compressed already.
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as archive:
            for file_name, content in files.items():
                archive.writestr(f"{folder}/{file_name}", content)
            for file_name in sorted(os.listdir(media_dir)):
                archive.write(os.path.join(media_dir, file_name), f"{folder}/media/{file_name}")

        number = int(project_data.get("packageVersion") or 0) + 1
        storage_path = f"users/{uid}/projects/{project_id}/package/{folder}_v{number}.zip"
        upload_file(zip_path, storage_path, content_type="application/zip")
        project_ref.update({
            "packageStatus": "ready",
            "packageUrl": get_download_url(storage_path),
            "packageName": f"{folder}.zip",
            "packageVersion": number,
            "packageError": None,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        logger.info("Package v%s built for project %s (%s scenes).", number, project_id, len(clips))
    except Exception as e:
        logger.exception("Building the package failed for project %s: %s", project_id, e)
        try:
            project_ref.update({"packageStatus": "failed", "packageError": user_message(e, "Exporting the project")})
        except Exception as update_err:
            logger.error("Failed to record the package failure: %s", update_err)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


async def run_package_job(**kwargs) -> None:
    await asyncio.to_thread(_run_package_job_sync, **kwargs)


@router.post("/projects/{pid}/package", status_code=status.HTTP_202_ACCEPTED)
async def build_package_endpoint(pid: str, current_user: Dict[str, Any] = Depends(get_current_user)):
    """Builds the export package in the background. Watch packageStatus / packageUrl on the project."""
    uid = current_user["uid"]
    project_ref = firestore.client().collection("projects").document(pid)
    snap = project_ref.get()
    if not snap.exists:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{pid}' not found.")
    project_data = snap.to_dict() or {}
    if project_data.get("userId") != uid:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to export this project.")
    if _is_running(project_data):
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content={"project_id": pid, "status": "building"})

    project_ref.update({
        "packageStatus": "building",
        "packageStartedAt": firestore.SERVER_TIMESTAMP,
        "packageError": None,
    })
    try:
        spawn_background(run_package_job(uid=uid, project_id=pid))
    except Exception:
        project_ref.update({"packageStatus": "failed", "packageError": "Could not start. Try again."})
        raise
    return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content={"project_id": pid, "status": "building"})
