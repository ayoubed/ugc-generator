"""
Burned-in captions for the final video.

The words come from each scene's script. Their timing is estimated from where speech is heard in
the scene's audio (no transcription service): the words are spread over the spoken parts in
proportion to their length, so pauses are respected. That is accurate enough for short phrases
shown a few words at a time; `word_timings` is the one function to replace if exact alignment is
added later.

Everything here is pure (no ffmpeg, no network), so it is easy to test.
"""
import re
from typing import Dict, List, Optional, Tuple

Word = Tuple[str, float, float]          # (text, start, end) in seconds
Segment = Tuple[float, float]            # (start, end) of a stretch of speech, in seconds

CAPTION_STYLES: Dict[str, Dict[str, str]] = {
    "highlight": {
        "label": "Word highlight",
        "description": "A few words at a time, the spoken word lights up.",
    },
    "pop": {
        "label": "Bold pop",
        "description": "One or two big uppercase words that pop in.",
    },
    "minimal": {
        "label": "Minimal",
        "description": "A quiet line of text on a soft dark bar.",
    },
}
DEFAULT_CAPTION_STYLE = "highlight"


def caption_style(value: Optional[str]) -> Optional[str]:
    """The style to burn in, or None for no captions. Unset means the default style."""
    if value == "none":
        return None
    return value if value in CAPTION_STYLES else DEFAULT_CAPTION_STYLE


def split_words(text: str) -> List[str]:
    return [w for w in re.split(r"\s+", (text or "").strip()) if w]


def _weight(word: str) -> float:
    """Rough speaking time of a word: its letters, plus a breath after punctuation."""
    letters = len(re.sub(r"[^\w]", "", word)) or 1
    pause = 3.0 if re.search(r"[.!?…]$", word) else 1.5 if re.search(r"[,;:—-]$", word) else 0.0
    return letters + 2.0 + pause


def word_timings(text: str, segments: List[Segment], duration: float) -> List[Word]:
    """
    Spreads the script's words over the spoken parts of a clip. `segments` are the stretches where
    speech is heard; with none (silent or unknown audio) the whole clip is used.
    """
    words = split_words(text)
    if not words or duration <= 0:
        return []
    spans = [(max(0.0, a), min(duration, b)) for a, b in segments if b - a > 0.05 and a < duration]
    if not spans:
        spans = [(0.0, duration)]

    spoken = sum(b - a for a, b in spans)
    weights = [_weight(w) for w in words]
    total = sum(weights)

    def to_clock(position: float) -> float:
        """Maps a position in spoken time to clip time, skipping the pauses between segments."""
        left = position
        for a, b in spans:
            if left <= (b - a) + 1e-9:
                return a + max(0.0, left)
            left -= b - a
        return spans[-1][1]

    timed: List[Word] = []
    cursor = 0.0
    for word, weight in zip(words, weights):
        length = spoken * weight / total
        start = to_clock(cursor)
        end = to_clock(cursor + length)
        if end <= start:
            end = min(duration, start + 0.08)
        timed.append((word, round(start, 3), round(end, 3)))
        cursor += length
    return timed


def fit_words_to_clip(words: List[Word], trim_start: float, duration: float) -> List[Word]:
    """
    Word times measured on a whole clip, moved to the part of it that is kept (from `trim_start`,
    `duration` long). Words outside that part are dropped; ones on its edge are cut to fit.
    """
    fitted: List[Word] = []
    for text, start, end in words:
        a, b = start - trim_start, end - trim_start
        if b <= 0 or a >= duration:
            continue
        a, b = max(0.0, a), min(duration, b)
        if b - a < 0.04:
            b = min(duration, a + 0.08)
        fitted.append((text, round(a, 3), round(b, 3)))
    return close_small_gaps(fitted)


# A silence between two words up to this long is breathing, not a pause: the word stays lit through it.
# (chunk_words starts a new line at a longer pause.)
MAX_GAP_INSIDE_PHRASE = 0.3


def close_small_gaps(words: List[Word]) -> List[Word]:
    """
    Measured word times leave short silences between words (and can make a word like "I" a
    millisecond long). Each word is held until the next one starts, unless a real pause follows,
    so the highlight moves from word to word without flickering off in between.
    """
    closed: List[Word] = []
    for i, (text, start, end) in enumerate(words):
        if i + 1 < len(words):
            next_start = words[i + 1][1]
            if 0 < next_start - end <= MAX_GAP_INSIDE_PHRASE:
                end = next_start
        closed.append((text, start, end))
    return closed


def chunk_words(words: List[Word], max_words: int, max_chars: int) -> List[List[Word]]:
    """Groups words into short lines. A line ends at sentence punctuation or a pause."""
    chunks: List[List[Word]] = []
    current: List[Word] = []
    for i, word in enumerate(words):
        length = sum(len(w[0]) for w in current) + len(current) + len(word[0])
        if current and (len(current) >= max_words or length > max_chars):
            chunks.append(current)
            current = []
        current.append(word)
        last = i == len(words) - 1
        pause_after = (not last) and words[i + 1][1] - word[2] > 0.3
        if re.search(r"[.!?…]$", word[0]) or pause_after:
            chunks.append(current)
            current = []
    if current:
        chunks.append(current)
    return chunks


def _clock(seconds: float) -> str:
    cs = max(0, int(round(seconds * 100)))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _clean(word: str, strip_soft: bool) -> str:
    """Makes a word safe for ASS and drops commas/full stops in the punchy styles."""
    text = word.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")
    if strip_soft:
        text = re.sub(r"[.,;:]+$", "", text)
    return text


WHITE = "&H00FFFFFF"
BLACK = "&H00000000"
YELLOW = "&H0000E6FF"   # ASS colours are &HAABBGGRR
SOFT_BAR = "&H78000000"


def build_ass(scenes: List[List[Word]], style: str, width: int, height: int) -> str:
    """
    The subtitle file for the whole video. `scenes` holds each scene's words with times on the
    final video's clock. Text sits above the area the TikTok / Reels / Shorts interface covers.
    """
    portrait = height >= width
    unit = min(width, height) / 1080.0
    # Bottom 35% of a vertical video is covered by captions, buttons and the progress bar.
    margin_v = int(height * (0.36 if portrait else 0.12))
    margin_h = int(width * 0.08)

    def size(points: float) -> int:
        return max(12, int(round(points * unit)))

    font = "Montserrat"
    if style == "pop":
        style_line = (
            f"Style: Cap,{font},{size(104)},{WHITE},{WHITE},{BLACK},{BLACK},-1,0,0,0,100,100,0,0,1,"
            f"{size(6)},0,2,{margin_h},{margin_h},{margin_v},1"
        )
    elif style == "minimal":
        style_line = (
            f"Style: Cap,{font},{size(54)},{WHITE},{WHITE},{SOFT_BAR},{SOFT_BAR},0,0,0,0,100,100,0,0,3,"
            f"{size(14)},0,2,{margin_h},{margin_h},{margin_v},1"
        )
    else:
        style_line = (
            f"Style: Cap,{font},{size(80)},{WHITE},{WHITE},{BLACK},{BLACK},-1,0,0,0,100,100,0,0,1,"
            f"{size(5)},0,2,{margin_h},{margin_h},{margin_v},1"
        )

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, "
        "MarginV, Encoding",
        style_line,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    def event(start: float, end: float, text: str) -> None:
        if end - start >= 0.03 and text.strip():
            lines.append(f"Dialogue: 0,{_clock(start)},{_clock(end)},Cap,,0,0,0,,{text}")

    limits = {"pop": (2, 12), "minimal": (5, 28)}.get(style, (3, 16))
    for words in scenes:
        chunks = chunk_words(words, *limits)
        for c, chunk in enumerate(chunks):
            chunk_start = chunk[0][1]
            # A line stays up until the next one starts, but never lingers through a long pause.
            next_start = chunks[c + 1][0][1] if c + 1 < len(chunks) else None
            hold = chunk[-1][2] + 0.25
            chunk_end = min(hold, next_start) if next_start is not None else hold

            if style == "pop":
                text = " ".join(_clean(w[0], True) for w in chunk).upper()
                event(chunk_start, chunk_end, r"{\fscx72\fscy72\t(0,90,\fscx108\fscy108)\t(90,170,\fscx100\fscy100)}" + text)
            elif style == "minimal":
                event(chunk_start, chunk_end, " ".join(_clean(w[0], False) for w in chunk))
            else:
                # One event per spoken word: the whole line is shown, with that word coloured.
                for i, word in enumerate(chunk):
                    start = word[1]
                    end = chunk[i + 1][1] if i + 1 < len(chunk) else chunk_end
                    parts = []
                    for j, other in enumerate(chunk):
                        clean = _clean(other[0], True)
                        parts.append(f"{{\\c{YELLOW}&}}{clean}{{\\c{WHITE}&}}" if j == i else clean)
                    event(start, end, " ".join(parts))

    return "\n".join(lines) + "\n"
