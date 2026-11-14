#! Storyboard check: looks at a frame the image model made and lists clear problems
#! (pipeline.check_storyboard_frame). Picture 1 is the frame; the other pictures are the product
#! pictures it was made from. Blanks: moment, details, face_rule (storyboard.check.no_face or empty).
Picture 1 is a frame made by an image model for a video ad. The other pictures, if any, show the real product. Look at picture 1.

What it was supposed to show: {{moment}}

What must stay consistent:
{{details}}

List only problems a viewer would clearly notice:
- scale: a product clearly too large or too small next to the hand, wrist, face or object beside it (for example a wristwatch wider than the wrist it is on).
- product: the product clearly differs from its pictures or description (shape, colour, count, label text).
- hands_or_face: deformed, extra or merging fingers or hands; a distorted face.
- on_screen_text: garbled text on a label or screen, a caption, an overlay or a border.
{{face_rule}}
Be strict about what counts: when unsure, do not report it. An empty list is the normal result.
