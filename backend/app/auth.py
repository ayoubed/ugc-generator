import os
from typing import Dict, Any
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import firebase_admin
from firebase_admin import auth

import logging

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)


def allowed_emails() -> set:
    """
    Accounts that may use the API, from ALLOWED_EMAILS (comma-separated). Every call costs money
    (video, music, script), so only listed accounts get in. Empty = anyone who can sign in.
    """
    raw = os.environ.get("ALLOWED_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> Dict[str, Any]:
    """
    FastAPI dependency to extract Bearer token from Authorization header,
    verify it using Firebase Admin Auth, and return the user profile dict.
    Raises HTTPException 401 if missing, malformed, expired, or invalid.
    """
    # Allow mock user for local unit testing when explicitly enabled
    if os.environ.get("MOCK_AUTH", "").lower() in ("1", "true"):
        return {
            "uid": os.environ.get("MOCK_AUTH_UID", "test_user_123"),
            "email": os.environ.get("MOCK_AUTH_EMAIL", "test@example.com"),
            "name": os.environ.get("MOCK_AUTH_NAME", "Test User"),
        }

    if not credentials or not credentials.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header or Bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = credentials.credentials

    try:
        # Verify Firebase ID token
        decoded_token = auth.verify_id_token(token)
        uid = decoded_token.get("uid")
        if not uid:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token does not contain a valid user ID.",
                headers={"WWW-Authenticate": "Bearer"},
            )

        email = decoded_token.get("email", "")
        allowed = allowed_emails()
        if allowed and email.lower() not in allowed:
            logger.warning("Access denied for user email '%s' (uid=%s). Allowed list: %s", email, uid, allowed)
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This account doesn't have access to UGC Studio yet.",
            )

        return {
            "uid": uid,
            "email": email,
            "name": decoded_token.get("name", ""),
        }
    except HTTPException:
        raise
    except auth.ExpiredIdTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token has expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except auth.RevokedIdTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token has been revoked.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except auth.CertificateFetchError as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch public certificates for token verification: {e}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid authentication token: {str(e)}",
            headers={"WWW-Authenticate": "Bearer"},
        )
