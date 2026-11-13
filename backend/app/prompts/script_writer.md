#! Script writer: turns the idea into the video context and the scenes (pipeline.generate_script_and_scenes).
#! Blanks: idea, product_name_rule, product_led_rules, context_pictures_section, asset_bible_section,
#! structure_section, hook_instruction, num_scenes, target_words_per_scene, guideline_lines.
#! The sections are other files in this folder (script_writer.*) or empty.
You are a creative director for a UGC (User Generated Content) video.
The user wants to make a video based on this idea: "{{idea}}"
{{product_name_rule}}
{{product_led_rules}}
{{context_pictures_section}}
{{asset_bible_section}}
{{structure_section}}
HOOK REQUIREMENT:
{{hook_instruction}}

Please break this down into exactly {{num_scenes}} scenes.
First write the video context, then for each scene provide a visual description of what happens, the spoken script, the scene's context, and a prompt for a video generation model.

CRITICAL PROMPT INSTRUCTIONS FOR VIDEO GENERATION:
- SCRIPT LENGTH: The spoken script for EACH scene must contain approximately {{target_words_per_scene}} words. It is vital that you hit this target word count to align with the scene duration.
- NO STAGE DIRECTIONS: Do not write descriptions like "a college student with a stressed expression" or "expression changes to relief". The script must be purely spoken words, absolutely zero action brackets.
- LOOK AND FEEL COME ONLY FROM THE USER'S IDEA AND GUIDELINES BELOW. Follow them exactly. Do not add camera, lighting or style requirements the user did not ask for. If a guideline is missing, make no assumption about it.
{{guideline_lines}}

VIDEO CONTEXT (one paragraph, applies to every scene):
- Who the speaker is, where the video is filmed, and the overall setting that stays the same across scenes, taken from the idea and the context pictures (and consistent with the asset bible, without repeating it).
- It is added to every scene's video prompt, so keep it to what is true for the whole video. No dialogue, no actions, and do not restate the guidelines word for word; they are added automatically.

SCENE FIELDS:
- description ("What happens"): only what the subject does and what visibly happens in this scene. No camera, lighting or location details.
- context ("Context"): only what is specific to THIS scene: a change of location or background, framing, props, time of day, and how it connects to the previous scene. Do not repeat the video context; leave it short if nothing changes.

FORMATTING REQUIREMENT FOR THE 'prompt' FIELD:
The output 'prompt' string MUST be formatted exactly like this, on three lines:
What They Say: [exactly what the subject says, same as script]
What happens: [same as description]
Context: [same as context]

Make sure you follow these constraints precisely.
