/**
 * Style guideline tags for the Idea page.
 *
 * Each category is sent to the script writer and added to every scene's video prompt, so tags are
 * phrased as short, concrete instructions a video model can act on. Suggestions are grouped by
 * look so users can mix styles (phone UGC, polished creator, studio, cinematic) instead of being
 * nudged towards one.
 *
 * The keys match the project settings fields (cameraTags, lightingTags, ...) and the backend.
 */

export const GUIDELINE_CATEGORIES = [
  {
    key: 'camera',
    settingsKey: 'cameraTags',
    label: 'Camera',
    hint: 'Device, framing and how the camera moves.',
  },
  {
    key: 'lighting',
    settingsKey: 'lightingTags',
    label: 'Lighting',
    hint: 'Light source, time of day and color treatment.',
  },
  {
    key: 'action',
    settingsKey: 'actionTags',
    label: 'Action & performance',
    hint: 'What the person does on camera and how they come across.',
  },
  {
    key: 'scriptTone',
    settingsKey: 'scriptToneTags',
    label: 'Script tone',
    hint: 'How the words sound: voice, energy and selling style.',
  },
  {
    key: 'visual',
    settingsKey: 'visualTags',
    label: 'Visual style',
    hint: 'Setting, background, pacing and continuity between scenes.',
  },
  {
    key: 'audio',
    settingsKey: 'audioTags',
    label: 'Audio & delivery',
    hint: 'Voice quality, room sound and background audio.',
  },
];

/** Suggestions per category, grouped by look. */
export const GUIDELINE_SUGGESTIONS = {
  camera: [
    {
      group: 'Phone / UGC',
      tags: [
        'Shot on a phone front camera',
        'Shot on a phone rear camera',
        'Handheld with natural micro-shake',
        'Selfie arm-length framing',
        'Phone propped on a desk',
        'Vertical phone video look',
        'Mirror selfie shot',
      ],
    },
    {
      group: 'Creator setup',
      tags: [
        'Tripod, locked-off shot',
        'Ring light reflection in the eyes',
        'Medium close-up, chest up',
        'Eye-level, looking straight into the lens',
        'Slight push-in on key lines',
      ],
    },
    {
      group: 'Professional',
      tags: [
        'Mirrorless camera, shallow depth of field',
        'Smooth gimbal movement',
        'Slow dolly-in',
        '35mm lens look',
        'Macro close-ups of the product',
        'Over-the-shoulder shot',
      ],
    },
    {
      group: 'Dynamic',
      tags: [
        'POV first-person shot',
        'Walking and talking, camera follows',
        'Dashcam-style shot from the driver seat',
        'Low angle hero shot',
        'Top-down flat-lay shot',
      ],
    },
  ],
  lighting: [
    {
      group: 'Natural',
      tags: [
        'Soft window light',
        'Overcast daylight',
        'Golden hour sunlight',
        'Bright midday sun',
        'Blue hour, just after sunset',
      ],
    },
    {
      group: 'Indoor / everyday',
      tags: [
        'Warm indoor lamp light',
        'Overhead kitchen lighting',
        'Office fluorescent lighting',
        'Screen glow on the face',
        'Car interior, daylight through the windshield',
      ],
    },
    {
      group: 'Creator / studio',
      tags: [
        'Ring light, even and flattering',
        'Soft key light with gentle shadows',
        'Clean, bright, high-key lighting',
        'Dramatic low-key lighting',
        'Colored LED accent lights in the background',
      ],
    },
    {
      group: 'Color & finish',
      tags: [
        'Unfiltered, true-to-life colors',
        'No cinematic color grading',
        'Warm, cozy color tone',
        'Cool, crisp color tone',
        'Polished commercial color grade',
        'Moody, desaturated look',
      ],
    },
  ],
  action: [
    {
      group: 'Everyday & unscripted',
      tags: [
        'Talking casually to the camera',
        'Doing a small task while talking',
        'Spontaneous vlog feel, not staged',
        'Natural pauses and small gestures',
        'Reacting genuinely to the product',
      ],
    },
    {
      group: 'Product focused',
      tags: [
        'Holding the product up to the lens',
        'Unboxing the product',
        'Showing the product in use',
        'Before-and-after demonstration',
        'Pointing at details on the product',
      ],
    },
    {
      group: 'Performance',
      tags: [
        'Confident presenter, direct to camera',
        'Energetic and animated',
        'Calm and composed',
        'Expert explaining a topic',
        'Storytelling, leaning in to the camera',
      ],
    },
    {
      group: 'Situations',
      tags: [
        'Walking down the street',
        'Sitting in a parked car',
        'Getting ready in the morning',
        'Cooking in the kitchen',
        'Working at a laptop',
        'At the gym between sets',
      ],
    },
  ],
  scriptTone: [
    {
      group: 'Authentic',
      tags: [
        'Genuine recommendation, not salesy',
        'Like texting a friend',
        'Honest, includes a small downside',
        'Personal story first, product second',
        'Casual, everyday language',
      ],
    },
    {
      group: 'Persuasive',
      tags: [
        'Clear problem, then solution',
        'Strong call to action at the end',
        'Social proof and results',
        'Urgency without being pushy',
        'Benefit-led, not feature-led',
      ],
    },
    {
      group: 'Professional',
      tags: [
        'Polished and articulate',
        'Expert, educational tone',
        'Concise and to the point',
        'Premium, aspirational brand voice',
      ],
    },
    {
      group: 'Energy & mood',
      tags: [
        'Excited and upbeat',
        'Calm and reassuring',
        'Funny, light humor',
        'Bold, controversial take',
        'Emotional and heartfelt',
      ],
    },
  ],
  visual: [
    {
      group: 'Setting',
      tags: [
        'Lived-in bedroom background',
        'Clean, minimal home interior',
        'Busy kitchen counter',
        'Plain studio backdrop',
        'Modern office',
        'Outdoors in a city street',
        'Outdoors in nature',
      ],
    },
    {
      group: 'Continuity',
      tags: [
        'Same outfit and location in every scene',
        'Keep the background still and consistent',
        'Same framing in every scene',
        'Change location each scene',
      ],
    },
    {
      group: 'Pacing',
      tags: [
        'Minimal movement, simple scenes',
        'Fast-paced, lots of energy',
        'Jump cuts between lines',
        'Slow, lingering shots',
      ],
    },
    {
      group: 'Look',
      tags: [
        'Realistic, not overproduced',
        'Clean and polished',
        'Cinematic, film-like',
        'Bright and colorful',
        'Product always clearly visible',
      ],
    },
  ],
  audio: [
    {
      group: 'Voice',
      tags: [
        'Consistent volume and tone across scenes',
        'Clear, close-mic voice',
        'Phone-mic sound, slightly roomy',
        'Lavalier mic, crisp and clean',
        'Speaks quickly, high energy',
        'Speaks slowly and clearly',
        'Soft, ASMR-style voice',
      ],
    },
    {
      group: 'Background',
      tags: [
        'Quiet room, no background noise',
        'Natural room ambience',
        'Light street ambience',
        'Café background chatter',
      ],
    },
  ],
};

/**
 * settings.sceneAudio. Voice only keeps music out of the scenes (each scene would otherwise get
 * different music); one music track is added over the whole video on the Final Video page.
 */
export const SCENE_AUDIO_VOICE_ONLY = 'voice_only';
export const SCENE_AUDIO_OPTIONS = [
  {
    value: SCENE_AUDIO_VOICE_ONLY,
    title: 'Voice only',
    sub: 'Recommended. Music is added over the whole video when you stitch.',
  },
  {
    value: 'model',
    title: 'Let the video model choose',
    sub: 'The model may add its own music, which can change from scene to scene.',
  },
];

/** The project's scene audio mode (voice only unless the user picked otherwise). */
export function projectSceneAudio(settings) {
  return SCENE_AUDIO_OPTIONS.some((o) => o.value === settings?.sceneAudio)
    ? settings.sceneAudio
    : SCENE_AUDIO_VOICE_ONLY;
}

/** Accents offered for the speaker. An empty value means the script writer is not told any accent. */
export const ACCENTS = [
  { value: '', label: 'Not specified' },
  { value: 'General American', label: 'General American' },
  { value: 'Southern US', label: 'Southern US' },
  { value: 'New York', label: 'New York' },
  { value: 'Californian', label: 'Californian' },
  { value: 'British (RP)', label: 'British (RP)' },
  { value: 'London', label: 'London' },
  { value: 'Scottish', label: 'Scottish' },
  { value: 'Irish', label: 'Irish' },
  { value: 'Australian', label: 'Australian' },
  { value: 'Canadian', label: 'Canadian' },
  { value: 'Indian English', label: 'Indian English' },
  { value: 'South African', label: 'South African' },
  { value: 'Neutral / international', label: 'Neutral / international' },
];

/**
 * One-click starting points. Applying a preset replaces all six categories; the user can then
 * edit any tag. New projects start empty so nothing is applied unless the user picks it.
 */
export const GUIDELINE_PRESETS = [
  {
    id: 'raw-ugc',
    label: 'Raw phone UGC',
    description: 'Selfie-style, unpolished, feels like a real customer.',
    tags: {
      camera: ['Shot on a phone front camera', 'Handheld with natural micro-shake', 'Selfie arm-length framing'],
      lighting: ['Soft window light', 'Unfiltered, true-to-life colors', 'No cinematic color grading'],
      action: ['Talking casually to the camera', 'Doing a small task while talking', 'Spontaneous vlog feel, not staged'],
      scriptTone: ['Genuine recommendation, not salesy', 'Like texting a friend', 'Casual, everyday language'],
      visual: ['Lived-in bedroom background', 'Same outfit and location in every scene', 'Realistic, not overproduced'],
      audio: ['Phone-mic sound, slightly roomy', 'Consistent volume and tone across scenes'],
    },
  },
  {
    id: 'polished-creator',
    label: 'Polished creator',
    description: 'Tripod and ring light, clean background, confident delivery.',
    tags: {
      camera: ['Tripod, locked-off shot', 'Medium close-up, chest up', 'Eye-level, looking straight into the lens'],
      lighting: ['Ring light, even and flattering', 'Warm, cozy color tone'],
      action: ['Confident presenter, direct to camera', 'Holding the product up to the lens'],
      scriptTone: ['Clear problem, then solution', 'Benefit-led, not feature-led', 'Strong call to action at the end'],
      visual: ['Clean, minimal home interior', 'Same framing in every scene', 'Jump cuts between lines'],
      audio: ['Clear, close-mic voice', 'Quiet room, no background noise'],
    },
  },
  {
    id: 'studio-demo',
    label: 'Studio product demo',
    description: 'Professional camera and lighting, product front and center.',
    tags: {
      camera: ['Mirrorless camera, shallow depth of field', 'Macro close-ups of the product', 'Slow dolly-in'],
      lighting: ['Clean, bright, high-key lighting', 'Soft key light with gentle shadows', 'Polished commercial color grade'],
      action: ['Showing the product in use', 'Pointing at details on the product', 'Calm and composed'],
      scriptTone: ['Polished and articulate', 'Concise and to the point'],
      visual: ['Plain studio backdrop', 'Clean and polished', 'Product always clearly visible'],
      audio: ['Lavalier mic, crisp and clean', 'Quiet room, no background noise'],
    },
  },
  {
    id: 'on-the-go',
    label: 'On the go',
    description: 'Walking, in the car or out and about. Lively and real.',
    tags: {
      camera: ['Walking and talking, camera follows', 'Shot on a phone rear camera', 'Handheld with natural micro-shake'],
      lighting: ['Bright midday sun', 'Unfiltered, true-to-life colors'],
      action: ['Walking down the street', 'Natural pauses and small gestures'],
      scriptTone: ['Excited and upbeat', 'Personal story first, product second'],
      visual: ['Outdoors in a city street', 'Change location each scene', 'Fast-paced, lots of energy'],
      audio: ['Light street ambience', 'Speaks quickly, high energy'],
    },
  },
  {
    id: 'expert-explainer',
    label: 'Expert explainer',
    description: 'Educational, trustworthy, calm authority.',
    tags: {
      camera: ['Tripod, locked-off shot', 'Medium close-up, chest up', 'Slight push-in on key lines'],
      lighting: ['Soft key light with gentle shadows', 'Cool, crisp color tone'],
      action: ['Expert explaining a topic', 'Calm and composed'],
      scriptTone: ['Expert, educational tone', 'Social proof and results', 'Concise and to the point'],
      visual: ['Modern office', 'Keep the background still and consistent'],
      audio: ['Lavalier mic, crisp and clean', 'Speaks slowly and clearly'],
    },
  },
  {
    id: 'cinematic-story',
    label: 'Cinematic story',
    description: 'Film-like, emotional, brand-film quality.',
    tags: {
      camera: ['Smooth gimbal movement', '35mm lens look', 'Mirrorless camera, shallow depth of field'],
      lighting: ['Golden hour sunlight', 'Moody, desaturated look'],
      action: ['Storytelling, leaning in to the camera', 'Reacting genuinely to the product'],
      scriptTone: ['Emotional and heartfelt', 'Premium, aspirational brand voice'],
      visual: ['Cinematic, film-like', 'Slow, lingering shots', 'Outdoors in nature'],
      audio: ['Clear, close-mic voice', 'Natural room ambience'],
    },
  },
];

/** New projects start with no guidelines; nothing is applied unless the user adds it. */
export const EMPTY_GUIDELINES = {
  camera: [],
  lighting: [],
  action: [],
  scriptTone: [],
  visual: [],
  audio: [],
};
