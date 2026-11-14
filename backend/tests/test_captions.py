"""Caption timing and the subtitle file (app/captions.py)."""
from app import captions


def test_caption_style_defaults_and_off():
    assert captions.caption_style(None) == "highlight"
    assert captions.caption_style("unknown") == "highlight"
    assert captions.caption_style("pop") == "pop"
    assert captions.caption_style("none") is None


def test_words_stay_inside_the_spoken_parts_and_in_order():
    words = captions.word_timings("One two three four.", [(0.5, 1.5), (2.5, 3.5)], 4.0)
    assert [w[0] for w in words] == ["One", "two", "three", "four."]
    assert words[0][1] == 0.5
    assert words[-1][2] <= 3.5
    for (_, start, end), (_, next_start, _) in zip(words, words[1:]):
        assert start < end <= next_start + 1e-6
    # Nothing is timed inside the pause between the two stretches of speech.
    assert not any(1.5 < start < 2.5 for _, start, _ in words)


def test_silent_clip_spreads_words_over_the_whole_clip():
    words = captions.word_timings("Hello there", [], 2.0)
    assert words[0][1] == 0.0
    assert words[-1][2] == 2.0


def test_no_words_or_no_duration_gives_nothing():
    assert captions.word_timings("", [(0, 1)], 2.0) == []
    assert captions.word_timings("Hello", [(0, 1)], 0) == []


def test_lines_break_at_sentence_ends_pauses_and_length():
    words = [("Hi.", 0.0, 0.3), ("This", 0.3, 0.5), ("is", 0.5, 0.6), ("nice", 1.2, 1.5), ("and", 1.5, 1.6), ("long", 1.6, 1.8), ("too", 1.8, 2.0)]
    chunks = captions.chunk_words(words, max_words=3, max_chars=16)
    assert [[w[0] for w in chunk] for chunk in chunks] == [["Hi."], ["This", "is"], ["nice", "and", "long"], ["too"]]


def test_highlight_style_colours_one_word_per_event():
    ass = captions.build_ass([[("Buy", 0.0, 0.4), ("it", 0.4, 0.6), ("now.", 0.6, 1.0)]], "highlight", 720, 1280)
    events = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
    assert len(events) == 3
    assert all(line.count(captions.YELLOW) == 1 for line in events)
    assert "PlayResX: 720" in ass and "PlayResY: 1280" in ass
    assert "now." not in ass  # the punchy styles drop the full stop


def test_pop_style_is_uppercase_and_minimal_keeps_punctuation():
    words = [[("Buy", 0.0, 0.4), ("now.", 0.4, 1.0)]]
    assert "BUY NOW" in captions.build_ass(words, "pop", 720, 1280)
    assert "Buy now." in captions.build_ass(words, "minimal", 720, 1280)


def test_text_cannot_break_the_subtitle_format():
    ass = captions.build_ass([[("{\\b1}hi", 0.0, 0.5)]], "minimal", 720, 1280)
    assert "(b1)hi" in ass


def test_clock_format():
    assert captions._clock(0) == "0:00:00.00"
    assert captions._clock(75.5) == "0:01:15.50"
    assert captions._clock(-1) == "0:00:00.00"


def test_a_typed_caption_is_used_only_while_the_script_is_the_one_it_replaced():
    from app.jobs import scene_caption_text

    settings = {"captions": {
        "texts": {"0": "Mine.", "1": "Old words.", "2": "From before.", "3": ""},
        "textFor": {"0": "Hi  there.", "1": "An older line.", "3": "Quiet."},
    }}
    assert scene_caption_text(settings, "0", {"script": "Hi there. "}) == "Mine."
    assert scene_caption_text(settings, "1", {"script": "A new line."}) == "A new line."
    # Typed before the script was kept with it: used as it is.
    assert scene_caption_text(settings, "2", {"script": "Anything."}) == "From before."
    # An empty typed caption still means "no caption" while the script is unchanged.
    assert scene_caption_text(settings, "3", {"script": "Quiet."}) == ""
    assert scene_caption_text(settings, "4", {"script": "Just the script."}) == "Just the script."
    assert scene_caption_text({}, "0", {}) == ""


def test_a_line_never_stays_up_into_the_next_group_of_words():
    first, second = [("Hello", 0.0, 1.0)], [("there", 1.1, 2.0)]
    ass = captions.build_ass([first, [], second], "minimal", 1080, 1920)
    events = [line for line in ass.splitlines() if line.startswith("Dialogue:")]
    assert len(events) == 2
    assert events[0].split(",")[2] == "0:00:01.10"                                    # not 1.25: the next one starts at 1.1
    assert events[1].split(",")[2] == "0:00:02.25"                                    # the last one keeps its short hold


def test_words_can_be_spread_over_a_stretch_of_time():
    words = captions.block_words("Looks far more expensive.", 2.0, 1.5)
    assert [w[0] for w in words] == ["Looks", "far", "more", "expensive."]
    assert words[0][1] == 2.0 and abs(words[-1][2] - 3.5) < 0.01
    assert captions.block_words("  ", 0, 1) == []

