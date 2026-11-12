"""
Turns an exception into a message a person can act on. The full error always goes to the log; what
is saved on a scene or returned by the API is one plain sentence.

Messages raised by this app's own code (ValueError, RuntimeError, TimeoutError with a readable
text) are already written for the user and pass through.
"""
import json
from typing import Optional

MAX_LENGTH = 300

_CONTENT_WORDS = ("safety", "blocked", "prohibited", "policy", "harm", "sensitive")
_QUOTA_WORDS = ("quota", "rate limit", "resource_exhausted", "resource exhausted", "too many requests")


def _first_line(text: str) -> str:
    line = next((part.strip() for part in str(text or "").splitlines() if part.strip()), "")
    return line if len(line) <= MAX_LENGTH else line[: MAX_LENGTH - 1].rstrip() + "…"


def _model_error(code: Optional[int], text: str) -> Optional[str]:
    """Message for an error answered by the model service, or None when it is not recognised."""
    lowered = text.lower()
    if code == 429 or any(word in lowered for word in _QUOTA_WORDS):
        return "The model is busy or its usage limit was reached. Wait a minute and try again."
    if any(word in lowered for word in _CONTENT_WORDS):
        return "The model refused this because of its content rules. Reword it and try again."
    if code in (401, 403):
        return "The model service rejected the app's key. This has to be fixed on the server."
    if code == 404:
        return "The chosen model is not available. Pick another model on the Idea step."
    if code is not None and code >= 500:
        return "The model service had a problem. Try again in a moment."
    if code == 400:
        return "The model did not accept this request. Shorten or reword it and try again."
    return None


def user_message(error: BaseException, doing: str = "This") -> str:
    """One sentence for the user. `doing` names the action for the fallback, e.g. "Writing the script"."""
    text = str(error or "").strip()
    code = getattr(error, "code", None)
    code = code if isinstance(code, int) else None

    # Errors of the google-genai client carry an HTTP code.
    if type(error).__module__.startswith("google.genai"):
        return _model_error(code, text) or f"{doing} failed at the model service. Try again."

    if isinstance(error, TimeoutError):
        return _first_line(text) or f"{doing} took too long and was stopped. Try again."
    if isinstance(error, json.JSONDecodeError) or type(error).__name__ == "ValidationError":
        return "The model returned an answer the app could not read. Try again."
    if isinstance(error, (ConnectionError, OSError)) and not isinstance(error, FileNotFoundError):
        return "The server could not reach a service it needs. Try again in a moment."

    recognised = _model_error(None, text)
    if recognised:
        return recognised
    return _first_line(text) or f"{doing} failed. Try again."
