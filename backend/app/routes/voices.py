from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, status

from app import elevenlabs
from app.auth import get_current_user

router = APIRouter()


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
