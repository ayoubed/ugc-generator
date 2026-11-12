"""Messages shown to the user when something fails (app/errors.py)."""
import json

import pytest
from google.genai import errors as genai_errors

from app.errors import MAX_LENGTH, user_message
from app.models import ReferenceBreakdown


def api_error(code, message):
    return genai_errors.APIError(code, {"error": {"code": code, "message": message, "status": "X"}})


@pytest.mark.parametrize("error,expected", [
    (api_error(429, "Resource has been exhausted (e.g. check quota)."), "usage limit"),
    (api_error(400, "The prompt was blocked by safety filters."), "content rules"),
    (api_error(400, "Invalid argument: duration"), "did not accept"),
    (api_error(403, "API key not valid."), "rejected the app's key"),
    (api_error(404, "models/x is not found"), "not available"),
    (api_error(503, "The service is currently unavailable."), "had a problem"),
])
def test_model_service_errors_become_plain_sentences(error, expected):
    message = user_message(error, "Making the take")
    assert expected in message
    assert "{" not in message and "error" not in message.lower().replace("problem", "")


def test_the_apps_own_messages_pass_through():
    own = "The scenes don't all have the same picture size: Scene 1 (720x1280), Scene 2 (1080x1920)."
    assert user_message(ValueError(own)) == own


def test_timeouts_and_unreadable_answers():
    assert user_message(TimeoutError(), "Making the take") == "Making the take took too long and was stopped. Try again."
    assert "could not read" in user_message(json.JSONDecodeError("bad", "{", 0))
    with pytest.raises(Exception) as caught:
        ReferenceBreakdown.model_validate({})
    assert "could not read" in user_message(caught.value)


def test_network_problems():
    assert "could not reach" in user_message(ConnectionResetError("peer reset"))


def test_a_quota_error_wrapped_in_another_exception_is_still_recognised():
    assert "usage limit" in user_message(RuntimeError("429 RESOURCE_EXHAUSTED: quota exceeded for model"))


def test_long_technical_errors_are_cut_to_one_short_line():
    message = user_message(RuntimeError("ffmpeg failed\n" + "x" * 5000))
    assert message == "ffmpeg failed"
    assert len(user_message(RuntimeError("y" * 5000))) == MAX_LENGTH


def test_an_empty_error_still_says_what_failed():
    assert user_message(RuntimeError(""), "Stitching the video") == "Stitching the video failed. Try again."
