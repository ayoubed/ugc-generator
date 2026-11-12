import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, status

from app.auth import get_current_user, grant_access_claim
from app.models import HealthResponse

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint. No authentication required."""
    return {"status": "healthy"}


@router.get("/me")
def me(current_user: Dict[str, Any] = Depends(get_current_user)):
    """
    The app calls this right after sign-in. An account that is not on the allowlist gets 403 (from
    get_current_user) and the app shows it has no access. An allowlisted account gets the access
    mark on its sign-in token, which the database and file rules require; `refresh_token` tells the
    app to fetch a new token so the mark takes effect.
    """
    newly_marked = not current_user.get("has_access_claim")
    if newly_marked:
        try:
            grant_access_claim(current_user["uid"])
        except Exception as e:
            logger.exception("Could not mark uid=%s as allowed: %s", current_user["uid"], e)
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Could not set up your access. Try again.")
    return {"email": current_user.get("email", ""), "allowed": True, "refresh_token": newly_marked}
