"""
Automatic checks on what a prompt produced. Each check returns (name, passed, detail); `detail`
says what was found when it fails. They catch the mistakes that are cheap to catch by rule, the
ones this app has actually made: a made-up brand name, a face in a product-led script, stage
directions in the spoken text. Whether a script is *good* still needs a person to read it.
"""
import re
from typing import Any, Dict, List, Tuple

Check = Tuple[str, bool, str]

FACE_WORDS = (
    "her face", "his face", "their face", "smiles", "smiling", "looks at the camera", "looking at the camera",
    "to the camera", "into the camera", "her eyes", "his eyes", "lips", "selfie", "talking head",
)
# Capitalised words that are not names.
_ORDINARY = {
    "I", "I'm", "I've", "I'll", "I'd", "OK", "Okay", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
    "Sunday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
    "November", "December", "Swiss", "Rolex", "TikTok", "Instagram",
}


def _words(text: str) -> List[str]:
    return re.findall(r"[A-Za-z0-9'’-]+", text or "")


def invented_names(spoken: List[str], known_text: str) -> List[str]:
    """
    Capitalised words inside a sentence that appear nowhere in what the user gave (idea, product
    name, picture descriptions, consistent details): likely a brand or product name the model made up.
    """
    known = {w.lower() for w in _words(known_text)}
    found: List[str] = []
    for line in spoken:
        for sentence in re.split(r"(?<=[.!?…])\s+", line or ""):
            tokens = _words(sentence)
            for token in tokens[1:]:                      # the first word of a sentence is capitalised anyway
                if token[:1].isupper() and len(token) > 2 and token not in _ORDINARY and token.lower() not in known and token not in found:
                    found.append(token)
    return found


def _contains(text: str, wanted: List[str], present: bool, label: str) -> List[Check]:
    lowered = text.lower()
    hits = [w for w in wanted if w.lower() in lowered]
    if present:
        missing = [w for w in wanted if w not in hits]
        return [(label, not missing, f"missing: {missing}" if missing else "")]
    return [(label, not hits, f"found: {hits}" if hits else "")]


def check_script(case_input: Dict[str, Any], output: Dict[str, Any], expect: Dict[str, Any]) -> List[Check]:
    """Checks for the script writer. `output` is {"video_context", "scenes": [{description, script, context, prompt}]}."""
    scenes = [s for s in (output.get("scenes") or []) if isinstance(s, dict)]
    scripts = [str(s.get("script") or "") for s in scenes]
    all_text = " ".join([str(output.get("video_context") or "")] + [" ".join(str(s.get(k) or "") for k in ("description", "script", "context", "prompt")) for s in scenes])
    checks: List[Check] = []

    structure = (case_input.get("structure") or {}).get("scenes") or []
    wanted = len(structure) or int(case_input.get("num_scenes") or 3)
    checks.append(("scene count", len(scenes) == wanted, f"{len(scenes)} scenes, wanted {wanted}"))

    target = int(case_input.get("target_words_per_scene") or 20)
    off = [f"scene {n}: {len(_words(text))} words" for n, text in enumerate(scripts, 1)
           if text.strip() and not (0.5 * target <= len(_words(text)) <= 1.6 * target)]
    checks.append(("words per scene", not off, "; ".join(off) + f" (target {target})" if off else ""))

    directed = [f"scene {n}" for n, text in enumerate(scripts, 1) if re.search(r"[\[\(\*]", text)]
    checks.append(("no stage directions in the spoken text", not directed, ", ".join(directed)))

    badly = [f"scene {n}" for n, s in enumerate(scenes, 1)
             if not all(part in str(s.get("prompt") or "") for part in ("What They Say:", "What happens:", "Context:"))]
    checks.append(("video prompt has its three lines", not badly, ", ".join(badly)))

    name = str(case_input.get("product_name") or "").strip()
    known = " ".join([
        str(case_input.get("idea") or ""), name, " ".join(case_input.get("context_image_descriptions") or []),
        " ".join(str(v) for v in (case_input.get("asset_bible") or {}).values()),
    ])
    made_up = invented_names(scripts, known)
    checks.append(("no made-up names in the spoken text", not made_up, f"found: {made_up}" if made_up else ""))
    if name:
        checks.append(("uses the product name as written", name in " ".join(scripts), f"'{name}' is never said"))

    if case_input.get("video_type") == "product":
        visual = " ".join(" ".join(str(s.get(k) or "") for k in ("description", "context")) for s in scenes) + " " + str(output.get("video_context") or "")
        checks += _contains(visual, list(FACE_WORDS), False, "no face or presenter in a product-led video")

    if expect.get("must_contain"):
        checks += _contains(all_text, expect["must_contain"], True, "contains what the case asks for")
    if expect.get("must_not_contain"):
        checks += _contains(all_text, expect["must_not_contain"], False, "avoids what the case forbids")
    return checks


def check_details(case_input: Dict[str, Any], output: Dict[str, Any], expect: Dict[str, Any]) -> List[Check]:
    """Checks for the consistent details. `output` is {character, hero_props, setting, voice}."""
    checks: List[Check] = []
    empty = [key for key in ("hero_props", "setting", "voice") if not str(output.get(key) or "").strip()]
    checks.append(("fields are filled in", not empty, f"empty: {empty}" if empty else ""))
    long = [key for key, value in output.items() if len(str(value or "")) > 600]
    checks.append(("each field is one or two sentences", not long, f"too long: {long}" if long else ""))
    if case_input.get("video_type") == "product":
        checks += _contains(str(output.get("character") or ""), ["hair", "face", "eyes", "makeup", "smile"], False, "no face described for a product-led video")
    all_text = " ".join(str(v or "") for v in output.values())
    name = str(case_input.get("product_name") or "").strip()
    if not name:
        made_up = invented_names([str(output.get("hero_props") or "")], str(case_input.get("idea") or ""))
        checks.append(("no made-up brand on the product", not made_up, f"found: {made_up}" if made_up else ""))
    if expect.get("must_contain"):
        checks += _contains(all_text, expect["must_contain"], True, "contains what the case asks for")
    if expect.get("must_not_contain"):
        checks += _contains(all_text, expect["must_not_contain"], False, "avoids what the case forbids")
    return checks
