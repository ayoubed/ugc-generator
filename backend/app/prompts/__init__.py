"""
Every instruction the app sends to a model lives in this folder, one text file per prompt.

    from app import prompts
    prompts.text("video.realism")                       # a fixed instruction
    prompts.render("script_writer", idea="A mug", ...)   # a template with {{blanks}}

File format: plain text. Lines that start with `#!` are notes for people (what the prompt is for,
what its blanks are) and are not sent. A blank is written {{name}}; `render` must be given a value
for every blank in the file and nothing else, so a renamed or forgotten blank fails loudly instead
of sending a broken prompt.

To try a different wording without touching the live files (see backend/evals), use
`with prompts.override("script_writer", new_text): ...`.
"""
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterator, List

FOLDER = Path(__file__).parent
SUFFIX = ".md"
_BLANK = re.compile(r"\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}")
_cache: Dict[str, str] = {}
_overrides: Dict[str, str] = {}


class PromptError(ValueError):
    """A prompt file is missing, or was rendered with the wrong blanks."""


def _clean(raw: str) -> str:
    lines = [line for line in raw.splitlines() if not line.startswith("#!")]
    return "\n".join(lines).strip("\n")


def names() -> List[str]:
    """Every prompt in the folder, by name."""
    return sorted(path.name[: -len(SUFFIX)] for path in FOLDER.glob(f"*{SUFFIX}"))


def text(name: str) -> str:
    """The prompt as written in its file (notes removed), blanks not filled in."""
    if name in _overrides:
        return _overrides[name]
    if name not in _cache:
        path = FOLDER / f"{name}{SUFFIX}"
        if not path.is_file():
            raise PromptError(f"There is no prompt named '{name}' in {FOLDER}.")
        _cache[name] = _clean(path.read_text(encoding="utf-8"))
    return _cache[name]


def blanks(name: str) -> List[str]:
    """The blanks of a prompt, in the order they first appear."""
    seen: List[str] = []
    for blank in _BLANK.findall(text(name)):
        if blank not in seen:
            seen.append(blank)
    return seen


def render(name: str, /, **values: object) -> str:
    """The prompt with every {{blank}} filled in. Values are inserted as they are (no escaping)."""
    wanted = set(blanks(name))
    missing, extra = wanted - set(values), set(values) - wanted
    if missing or extra:
        problems = []
        if missing:
            problems.append(f"no value for {sorted(missing)}")
        if extra:
            problems.append(f"values it has no blank for: {sorted(extra)}")
        raise PromptError(f"Prompt '{name}': " + "; ".join(problems) + ".")
    return _BLANK.sub(lambda match: str(values[match.group(1)]), text(name))


@contextmanager
def override(name: str, new_text: str) -> Iterator[None]:
    """Uses `new_text` for the prompt `name` inside the `with` block (for trying a variant)."""
    text(name)  # the name must exist
    previous = _overrides.get(name)
    _overrides[name] = _clean(new_text)
    try:
        yield
    finally:
        if previous is None:
            _overrides.pop(name, None)
        else:
            _overrides[name] = previous
