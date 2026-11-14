"""
The storyboard: pictures of a scene made with the image model before any video is made.

A still is cheap to look at and remake, so the product's size and the look of the scene are
settled here. The first frame the user accepts becomes the picture the scene's video starts on
(the scene's custom starting picture), so the Generate step and "generate all" need no other change.

A scene can also have an end frame (role "end"): the picture its video ends on. It is drawn with
the scene's start frame as a reference, so it is the same shot a few seconds later, and it becomes
the scene's end picture (endImageRef), which the Generate step already knows.

On a scene document:
    storyboard.frames.<id> = {id, role: "start" | "end", order, description, imageRef, imageUrl,
                              version, accepted, look, issues: [{kind, detail}],
                              source: "ai" | "upload", updatedAt}
    storyboard.start       = {frameId, ref, previous: {imageSource, customStartImageRef,
                              customStartImageUrl}}   # set while a frame is the scene's start
    storyboard.end         = {frameId, ref, previous: {endImageRef, endImageUrl}}   # same, for the end
`look` marks an accepted frame as a reference for every other frame of the video, so the person,
the product's size, the setting and the light stay the same from scene to scene.
"""
import datetime
import logging
import os
import shutil
import tempfile
import uuid
from typing import Any, Dict, List, Optional

from app.jobs import (
    VALID_IMAGE_SOURCES,
    _assert_owned_path,
    collect_reference_specs,
    is_product_led,
)
from app.model_registry import get_image_model
from app.pipeline import (
    asset_bible_lines,
    check_storyboard_frame,
    detect_image_mime,
    generate_storyboard_frame,
)
from app.storage import download_file, get_download_url, upload_file

logger = logging.getLogger(__name__)

MAX_FRAMES_PER_SCENE = 6
# Accepted frames sent along when another frame is drawn. Two is enough to carry the look.
MAX_LOOK_FRAMES = 2
# Pictures sent to the image model with one frame (product pictures, creator photo, look frames).
MAX_FRAME_PICTURES = 8

CREATOR_PICTURE_TEXT = (
    "The presenter of the video. Keep exactly this face, hair, skin and build."
)
START_FRAME_TEXT = (
    "The picture this same scene starts on. The frame to make is the end of the same shot a few "
    "seconds later: the same person, product, setting, light and camera position. Only the action "
    "has moved on."
)
ROLE_START, ROLE_END = "start", "end"


def role_of(frame: Optional[Dict[str, Any]]) -> str:
    return ROLE_END if (frame or {}).get("role") == ROLE_END else ROLE_START


LOOK_FRAME_TEXT = (
    "A frame of this same video that was approved. Match it: the same person, the same product at "
    "the same real-life size, the same setting and light, unless this frame is described differently."
)


def frames_in_order(scene_data: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The scene's storyboard frames, first to last."""
    frames = ((scene_data or {}).get("storyboard") or {}).get("frames")
    items = [f for f in (frames or {}).values() if isinstance(f, dict) and f.get("id")] if isinstance(frames, dict) else []
    return sorted(items, key=lambda f: (f.get("order") or 0, str(f.get("id"))))


def start_frame(frames: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The frame the scene's video starts on: the first accepted start frame that has a picture."""
    return next((f for f in frames if role_of(f) == ROLE_START and f.get("accepted") and f.get("imageRef")), None)


def end_frame(frames: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The frame the scene's video ends on: the first accepted end frame that has a picture."""
    return next((f for f in frames if role_of(f) == ROLE_END and f.get("accepted") and f.get("imageRef")), None)


def default_moment(scene_data: Optional[Dict[str, Any]], role: str = ROLE_START) -> str:
    """What a scene's frame shows when the user has not described it: the scene's own text."""
    scene = scene_data or {}
    parts = [str(scene.get(key) or "").strip() for key in ("description", "context")]
    text = " ".join(part for part in parts if part)
    text = text or str(scene.get("prompt") or scene.get("script") or "").strip()
    if role == ROLE_END and text:
        return f"The last moment of this scene, when its action is finished: {text}"
    return text


def scene_update_for(scene_data: Dict[str, Any], frames: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    The scene fields to write after its frames changed: the frames themselves, and the scene's
    starting picture kept in step with them. Accepting a frame makes it the starting picture;
    with no accepted frame left the scene goes back to how it started before, unless the user
    has picked another custom picture in the meantime.
    """
    board = dict((scene_data.get("storyboard") or {}))
    link = board.get("start") if isinstance(board.get("start"), dict) else None
    ordered = [{**f, "order": i} for i, f in enumerate(frames)]
    board["frames"] = {f["id"]: f for f in ordered}
    update: Dict[str, Any] = {}

    start = start_frame(ordered)
    if start:
        previous = (link or {}).get("previous") or {
            "imageSource": scene_data.get("imageSource"),
            "customStartImageRef": scene_data.get("customStartImageRef"),
            "customStartImageUrl": scene_data.get("customStartImageUrl"),
        }
        board["start"] = {"frameId": start["id"], "ref": start["imageRef"], "previous": previous}
        update.update({
            "customStartImageRef": start["imageRef"],
            "customStartImageUrl": start.get("imageUrl"),
            "imageSource": "uploaded",
        })
    elif link:
        board["start"] = None
        if scene_data.get("customStartImageRef") == link.get("ref"):
            previous = link.get("previous") or {}
            source = previous.get("imageSource")
            update.update({
                "customStartImageRef": previous.get("customStartImageRef") or None,
                "customStartImageUrl": previous.get("customStartImageUrl") or None,
                "imageSource": source if source in VALID_IMAGE_SOURCES else None,
            })

    # The same for the picture the scene ends on.
    end_link = board.get("end") if isinstance(board.get("end"), dict) else None
    end = end_frame(ordered)
    if end:
        previous = (end_link or {}).get("previous") or {
            "endImageRef": scene_data.get("endImageRef"),
            "endImageUrl": scene_data.get("endImageUrl"),
        }
        board["end"] = {"frameId": end["id"], "ref": end["imageRef"], "previous": previous}
        update.update({"endImageRef": end["imageRef"], "endImageUrl": end.get("imageUrl")})
    elif end_link:
        board["end"] = None
        if scene_data.get("endImageRef") == end_link.get("ref"):
            previous = end_link.get("previous") or {}
            update.update({
                "endImageRef": previous.get("endImageRef") or None,
                "endImageUrl": previous.get("endImageUrl") or None,
            })
    update["storyboard"] = board
    return update


def look_frames(scenes: List[tuple], skip_frame_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    The accepted frames marked as the look of the video, in scene order. scenes: [(scene id, data)].
    """
    found = []
    for _, data in scenes:
        for frame in frames_in_order(data):
            if role_of(frame) == ROLE_END:
                continue   # the look is set by pictures scenes start on
            if frame.get("look") and frame.get("accepted") and frame.get("imageRef") and frame["id"] != skip_frame_id:
                found.append(frame)
    return found[:MAX_LOOK_FRAMES]


def has_look_frame(scenes: List[tuple], skip_frame_id: Optional[str] = None) -> bool:
    return bool(look_frames(scenes, skip_frame_id))


def with_default_look(frame: Dict[str, Any], scenes: List[tuple]) -> Dict[str, Any]:
    """
    The frame, marked as the look of the video when it is in use and no other frame is: the first
    picture used in a video sets its look, and later frames are drawn to match it. A frame that is
    not in use never is the look.
    """
    if not frame.get("accepted") or role_of(frame) == ROLE_END:
        return {**frame, "look": False}
    if frame.get("look") or has_look_frame(scenes, skip_frame_id=frame.get("id")):
        return frame
    return {**frame, "look": True}


def frame_picture_specs(
    project_data: Dict[str, Any],
    scene_data: Dict[str, Any],
    scenes: List[tuple],
    uid: Optional[str],
    skip_frame_id: Optional[str] = None,
    role: str = ROLE_START,
) -> List[Dict[str, Any]]:
    """
    The pictures a frame is drawn from: [{storageRef, description, kind}] with kind "product",
    "creator", "look" or "start". Product and scene pictures first (they decide what the product
    looks like), then the creator photo, then the approved frames. An end frame also gets the
    picture its own scene starts on, last: it is the same shot a few seconds later.
    """
    specs = [
        {"storageRef": s["storageRef"], "description": s["description"], "kind": "product"}
        for s in collect_reference_specs(project_data, scene_data, uid)
    ]
    creator = project_data.get("startingImageRef") or ""
    if creator and not is_product_led(project_data):
        _assert_owned_path(uid, creator, "creator photo")
        specs.append({"storageRef": creator, "description": CREATOR_PICTURE_TEXT, "kind": "creator"})
    for frame in look_frames(scenes, skip_frame_id):
        _assert_owned_path(uid, frame["imageRef"], "storyboard frame")
        specs.append({"storageRef": frame["imageRef"], "description": LOOK_FRAME_TEXT, "kind": "look"})
    if role == ROLE_END:
        own_start = next((f for f in frames_in_order(scene_data) if role_of(f) == ROLE_START and f.get("imageRef")), None)
        if own_start:
            _assert_owned_path(uid, own_start["imageRef"], "storyboard frame")
            # When the scene's own start is also the look of the video, it is sent once.
            specs = [s for s in specs if s["kind"] != "look" or s["storageRef"] != own_start["imageRef"]]
            specs.append({"storageRef": own_start["imageRef"], "description": START_FRAME_TEXT, "kind": "start"})
    if len(specs) > MAX_FRAME_PICTURES:
        # Too many: the approved frames and the creator photo matter more than the last product pictures.
        keep_last = [s for s in specs if s["kind"] != "product"]
        specs = [s for s in specs if s["kind"] == "product"][: MAX_FRAME_PICTURES - len(keep_last)] + keep_last
    return specs


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def new_frame_id() -> str:
    return uuid.uuid4().hex[:10]


def draw_frame(
    uid: str,
    project_id: str,
    scene_id: str,
    frame: Dict[str, Any],
    project_data: Dict[str, Any],
    scene_data: Dict[str, Any],
    scenes: List[tuple],
    instruction: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Draws (or, with an instruction, changes) a frame's picture, checks it, and draws it once more
    when the check finds a clear problem. Returns the frame with its new picture. A picture is
    used by default (`accepted`): the user switches off the ones they don't want, and a frame
    they switched off stays off when it is drawn again. Blocking: call it from a worker thread.
    """
    temp_dir = tempfile.mkdtemp(prefix=f"ugc_board_{project_id}_{scene_id}_")
    try:
        role = role_of(frame)
        specs = frame_picture_specs(project_data, scene_data, scenes, uid, skip_frame_id=frame["id"], role=role)
        pictures = []
        for i, spec in enumerate(specs):
            local = os.path.join(temp_dir, f"picture_{i}" + (os.path.splitext(spec["storageRef"])[1].lower() or ".jpg"))
            try:
                download_file(spec["storageRef"], local)
            except Exception as e:
                raise ValueError("Could not load one of the pictures this frame is drawn from. Check the pictures on the Idea step.") from e
            pictures.append({"path": local, "description": spec["description"], "kind": spec["kind"]})
        product_paths = [p["path"] for p in pictures if p["kind"] == "product"]

        settings = project_data.get("settings") or {}
        aspect_ratio = settings.get("aspectRatio", "9:16")
        asset_lines = asset_bible_lines(settings.get("assetBible"))
        product_led = is_product_led(project_data)
        moment = frame.get("description") or default_moment(scene_data, role)

        base_path = None
        instruction = " ".join((instruction or "").split()) or None
        if instruction and frame.get("imageRef"):
            _assert_owned_path(uid, frame["imageRef"], "storyboard frame")
            base_path = os.path.join(temp_dir, "current" + (os.path.splitext(frame["imageRef"])[1].lower() or ".png"))
            download_file(frame["imageRef"], base_path)

        def draw(path: str, feedback: Optional[List[str]] = None) -> str:
            return generate_storyboard_frame(
                path, moment, aspect_ratio=aspect_ratio, reference_images=pictures, asset_lines=asset_lines,
                product_led=product_led, base_image_path=base_path, instruction=instruction, feedback=feedback,
                image_model=settings.get("imageModel"), ends_scene=role == ROLE_END,
            )

        def check(path: str) -> Optional[List[Dict[str, str]]]:
            """Problems found, or None when the check itself could not run."""
            try:
                return check_storyboard_frame(path, moment, product_paths, asset_lines, product_led)
            except Exception as e:
                logger.warning("The frame check failed for scene %s of project %s: %s", scene_id, project_id, e)
                return None

        picture = draw(os.path.join(temp_dir, "frame_1.png"))
        issues = check(picture)
        if issues:
            # One more try, told what was wrong. Whatever comes out is shown with what is still wrong.
            try:
                second = draw(os.path.join(temp_dir, "frame_2.png"), feedback=[i["detail"] for i in issues])
                second_issues = check(second)
                if second_issues is not None and len(second_issues) <= len(issues):
                    picture, issues = second, second_issues
            except Exception as e:
                logger.warning("The second try of a frame failed for scene %s of project %s: %s", scene_id, project_id, e)

        version = int(frame.get("version") or 0) + 1
        ext = ".jpg" if detect_image_mime(picture) == "image/jpeg" else ".png"
        storage_path = f"users/{uid}/projects/{project_id}/scenes/{scene_id}/storyboard/{frame['id']}_v{version}{ext}"
        upload_file(picture, storage_path, content_type=detect_image_mime(picture))
        return {
            **frame,
            "role": role,
            "description": moment,
            "imageRef": storage_path,
            "imageUrl": get_download_url(storage_path),
            "version": version,
            "accepted": frame.get("accepted", True) is not False,
            "look": bool(frame.get("look")),
            "issues": issues or [],
            "checked": issues is not None,
            "source": "ai",
            "imageModel": get_image_model(settings.get("imageModel"))["id"],
            "updatedAt": now_iso(),
        }
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
