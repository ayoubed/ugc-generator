"""Who may use the app: the allowlist, the access mark and the sign-in checks (app/auth.py)."""
import asyncio

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from app import auth as access


@pytest.fixture
def claims_set(monkeypatch):
    """Records the access marks written to accounts."""
    written = []
    monkeypatch.setattr(access.auth, "set_custom_user_claims", lambda uid, claims: written.append((uid, claims)))
    return written


def sign_in(monkeypatch, token):
    monkeypatch.setattr(access.auth, "verify_id_token", lambda _: token)
    credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="token")
    return asyncio.run(access.get_current_user(credentials))


def test_allowlist_is_read_from_the_setting(monkeypatch):
    monkeypatch.setenv("ALLOWED_EMAILS", " Ana@Example.com, ,bo@example.com ")
    assert access.allowed_emails() == {"ana@example.com", "bo@example.com"}
    monkeypatch.delenv("ALLOWED_EMAILS")
    assert access.allowed_emails() == set()


def test_listed_account_gets_in_whatever_the_letter_case(monkeypatch, claims_set):
    monkeypatch.setenv("ALLOWED_EMAILS", "ana@example.com")
    user = sign_in(monkeypatch, {"uid": "u1", "email": "Ana@Example.com", "name": "Ana"})
    assert user == {"uid": "u1", "email": "Ana@Example.com", "name": "Ana", "has_access_claim": False}
    assert claims_set == []


def test_unlisted_account_is_refused(monkeypatch, claims_set):
    monkeypatch.setenv("ALLOWED_EMAILS", "ana@example.com")
    with pytest.raises(HTTPException) as error:
        sign_in(monkeypatch, {"uid": "u2", "email": "stranger@example.com"})
    assert error.value.status_code == 403
    assert claims_set == []


def test_account_removed_from_the_list_loses_its_access_mark(monkeypatch, claims_set):
    monkeypatch.setenv("ALLOWED_EMAILS", "ana@example.com")
    with pytest.raises(HTTPException) as error:
        sign_in(monkeypatch, {"uid": "u3", "email": "former@example.com", "allowed": True})
    assert error.value.status_code == 403
    assert claims_set == [("u3", {"allowed": False})]


def test_account_without_an_email_is_refused_when_there_is_a_list(monkeypatch, claims_set):
    monkeypatch.setenv("ALLOWED_EMAILS", "ana@example.com")
    with pytest.raises(HTTPException) as error:
        sign_in(monkeypatch, {"uid": "u4"})
    assert error.value.status_code == 403


def test_without_a_list_anyone_signed_in_gets_in(monkeypatch, claims_set):
    assert sign_in(monkeypatch, {"uid": "u5", "email": "anyone@example.com", "allowed": True})["has_access_claim"] is True


def test_missing_or_bad_token_is_401(monkeypatch):
    with pytest.raises(HTTPException) as error:
        asyncio.run(access.get_current_user(None))
    assert error.value.status_code == 401

    def reject(_):
        raise ValueError("bad signature")

    monkeypatch.setattr(access.auth, "verify_id_token", reject)
    with pytest.raises(HTTPException) as error:
        asyncio.run(access.get_current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials="x")))
    assert error.value.status_code == 401
