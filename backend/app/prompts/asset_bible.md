#! Consistent details: one fixed description each of the speaker, the products, the place and the voice
#! (pipeline.asset_bible_prompt). Blanks: idea, product_name_rule, pictures_section, product_led_section
#! (the last two are asset_bible.pictures / asset_bible.product_led, or empty).
You are preparing a multi-scene UGC video. Each scene is generated separately by a video model
that does not remember the other scenes, so anything that appears in more than one scene needs
one fixed description that is reused word for word.

Video idea: "{{idea}}"
{{product_name_rule}}
{{pictures_section}}
{{product_led_section}}

Write these descriptions:
- character: the person speaking. Apparent age, hair or head covering, build, clothing with colours,
  accessories.
- hero_props: every product or object that matters to the story. Exact count, colours, materials,
  shape, size, packaging, branding, and how items differ from each other (e.g. "3 watches: ...").
- setting: where it is filmed. Room, furniture and surfaces, notable background objects.
- voice: how the speaker sounds, so it is the same in every scene. Apparent age and gender, pitch,
  pace, energy, accent if the idea implies one, and how it is recorded (e.g. "phone microphone,
  slightly roomy"). Also the tone of delivery, as one steady mood that holds from the first
  scene to the last (e.g. "calm and warm, like telling a friend, never excited or salesy").

Rules:
- Concrete, visual facts only. No story, no dialogue, no actions, no emotions.
- No camera, lighting or visual style: those are set separately.
- Stay faithful to the idea; where it is vague, pick specific, plausible details.
- One or two sentences per field. Leave a field empty only if it truly does not apply.
