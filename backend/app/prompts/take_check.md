#! Take check: watches a finished take and lists clear problems (pipeline.check_take).
#! Blanks: script, details (one "- ..." per line), pictures (same), photo_rule (take_check.photo_rule or empty),
#! audio_rule (what counts as an audio problem).
You are checking one short clip of a UGC-style video ad made by a video model. Watch and listen to it.

The speaker was supposed to say exactly:
"{{script}}"

What must stay consistent in the video:
{{details}}

Reference pictures the video was given (described in words):
{{pictures}}

1. spoken_text: write down exactly what is said, word for word, as you hear it. Do not correct it
   towards the script.
2. issues: list only problems a viewer would clearly notice:
   - speech: words cut off at the start or end, gibberish, or a second voice.
     (Do NOT report differences from the script here; that is compared separately.)
   - product: a product or prop that contradicts the description (wrong colour, count, shape, label).
   - speaker: the person clearly contradicts the description, or changes during the clip.
{{photo_rule}}
   - hands_or_face: deformed, extra or merging fingers or hands; a distorted face; an arm that
     could not belong to the person in frame (detached, or bent in an impossible way).
   - scale: a product clearly too large or too small next to the hand, wrist or face holding it.
   - on_screen_text: garbled or misspelled text on a label, a screen or as an overlay.
   - cut: an abrupt jump to a different person or place.
   - audio: {{audio_rule}}.
Be strict about what counts: when unsure, do not report it. An empty list is the normal result.
