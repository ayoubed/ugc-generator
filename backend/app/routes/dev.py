"""
Local development only. This router is added to the app only when MOCK_AUTH is on (see main.py),
which already disables sign-in checks and must never be set on a deployed server.

It lets the app be tried in a browser without a Google sign-in:

    1. Backend:  MOCK_AUTH=true MOCK_AUTH_UID=local_test_run uvicorn app.main:app --port 8080
    2. Frontend: npm run dev
    3. In the browser console on the local page:  await __devSignIn()

The test account carries the access mark the database and file rules require and owns only its
own projects (users/<MOCK_AUTH_UID>/...).
"""
from typing import Any, Dict

from fastapi import APIRouter, Depends
from firebase_admin import auth

from app.auth import ACCESS_CLAIM, get_current_user

router = APIRouter()


@router.get("/dev/token")
def dev_token(current_user: Dict[str, Any] = Depends(get_current_user)):
    """A sign-in token for the local test account."""
    token = auth.create_custom_token(current_user["uid"], {ACCESS_CLAIM: True})
    return {"token": token.decode() if isinstance(token, bytes) else token}
