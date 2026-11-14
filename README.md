# Eleviat (UGC Studio)

Turns an idea, a photo of a person and product pictures into a short video ad: it writes the
script, generates each scene with a video model, and stitches the scenes with captions, music
and an optional end card. Live at https://app.eleviat.com.

## Layout

| Path | What it is |
| --- | --- |
| `backend/` | FastAPI service (`app/`), deployed to Cloud Run as `ugc-api`. Tests in `tests/`. |
| `frontend/` | React + Vite app, deployed to Firebase Hosting (site `flowmint-94e87`). |
| `firestore.rules`, `storage.rules` | Security rules. They also carry the Eleviat landing page's form rule, because deploying replaces the whole ruleset. |

## Run it locally

Backend (needs `backend/.env` and `backend/service-account.json`, neither is in git):

```bash
cd backend && ../venv/bin/python -m uvicorn app.main:app --port 8080
```

Frontend (needs `frontend/.env`, see `frontend/.env.example`):

```bash
cd frontend && npm install && npm run dev
```

### Trying it without a Google sign-in

Start the backend in test mode, then run `await __devSignIn()` in the browser console on the
local page. It signs in as a test account that owns only its own projects. The route behind it
exists only when `MOCK_AUTH` is on, and the frontend hook only in development builds.

```bash
cd backend && MOCK_AUTH=true MOCK_AUTH_UID=local_test_run ../venv/bin/python -m uvicorn app.main:app --port 8080
```

Never set `MOCK_AUTH` on a deployed server: it switches sign-in checks off.

## Tests

```bash
cd backend && pip install -r requirements-dev.txt && python -m pytest
```

```bash
cd frontend && npm run lint && npm test
```

Backend tests use an in-memory database and never call Firebase or a model. GitHub Actions runs
both suites, lint and the build on every push to `main` and on pull requests.

## Who can use it

`ALLOWED_EMAILS` on the backend lists the Google accounts that may use the app. After sign-in the
app calls `GET /api/me`: an account on the list gets an `allowed` mark on its sign-in token, which
the database and file rules require; any other account sees a no-access screen.

## Prompts: where they are and how to try a change

Every instruction the app sends to a model is a text file in `backend/app/prompts/`, one per
prompt (`script_writer.md`, `take_check.md`, `video.realism.md`...). Lines starting with `#!` are
notes for people; `{{name}}` is a blank the code fills in. Changing a prompt is editing its file.

Before changing one, see what it does on the saved cases in `backend/evals/cases/`:

```bash
cd backend
../venv/bin/python -m evals.run --list                              # targets, cases, prompt files
../venv/bin/python -m evals.run script_writer --dry-run             # the exact prompts, no model call
../venv/bin/python -m evals.run script_writer                       # run the live prompt on every case
../venv/bin/python -m evals.run script_writer --variant new.md      # live wording against yours
../venv/bin/python -m evals.run script_writer --variant new.md --prompt script_writer.product_led
```

A run prints which automatic checks passed for each case (scene count, script length, no made-up
names, no face in a product-led script...) and saves every output to `backend/evals/runs/`, so two
wordings can be read side by side. The checks only catch mistakes a rule can catch; read the
outputs too. A new failure worth remembering becomes a new case file. Real runs call the model.

## Storyboard (optional step)

Between Script and Generate, each scene can get a picture made with the image model before any
video is made. A still is quick to look at and remake, so the product's size and the look of the
scene are settled there. The image model is chosen on that step (`settings.imageModel`, Nano Banana
Pro by default; the list is `IMAGE_MODELS` in `backend/app/model_registry.py`). The picture is checked automatically (size, product likeness, hands) and
drawn once more when the check finds a problem. A picture is used by default (a checkbox on its card switches that off): it becomes the scene's starting
picture (`customStartImageRef`, `imageSource: "uploaded"`), so Generate needs no other change; the
first picture in use in a video is also sent along when the other frames are drawn, so they match.
Code: `backend/app/storyboard.py`, `backend/app/routes/storyboard.py`, the `storyboard.*` prompt
files, `frontend/src/pages/StoryboardPage.jsx`.

## One voice and exact captions (ElevenLabs, optional)

Set `ELEVENLABS_API_KEY` on the backend (in `backend/.env` locally, as an environment variable on
Cloud Run) to switch on two things at stitch time:

- **One voice for the whole video.** The Video step gets a Voice card. With a voice picked, every
  scene's speech is re-voiced to it (voice changer). The re-voiced audio is kept next to the take,
  so stitching again does not pay for it again.
- **Exact caption timing.** Each caption word is placed where it is spoken (forced alignment)
  instead of being estimated. The word times are kept on the scene.

- **Sound effects in the editor.** "Add sound" makes a sound from a short description and puts it
  at the playhead; it is dragged along the Sounds track and mixed in when stitching. A sound is
  pinned to a moment of a scene's clip (`settings.sounds.<id> = {sceneId, at, volume, ...}`), so it
  stays on the same frame when other scenes are trimmed. Code: `backend/app/routes/sounds.py`,
  `pipeline.place_sounds`, `frontend/src/utils/sounds.js`.

- **Narration.** In the editor a scene can get a voice made from text, in the voice chosen for the
  video, in place of the sound of its take. The text is the narration's own (the script and the
  caption stay as they are) and `[pause]` or `[pause 1.5]` adds a silence. The voice is a block on
  the Voice track: dragged to slide it against the picture, trimmed in its panel, which also says
  whether it fits the scene. The stitch puts it on the scene first, so captions are timed on it.
  Data: `scene.narration` (made by the server) and `settings.narration.<id> = {at, trimStart,
  trimEnd, on}`. Code: `backend/app/routes/narration.py`, `voiceover.scene_narration`,
  `frontend/src/utils/narration.js`.

- **Captions placed by hand.** In the editor a scene's caption can be cut into short captions on
  the Captions track: each is dragged to move it, trimmed by its right edge, reworded or removed,
  and "Add caption" puts a new one at the playhead. Such a scene shows exactly these when stitched
  (no key needed). Data: `settings.captions.manual.<scene id>` and `settings.captions.blocks.<id> =
  {sceneId, at, length, text}`. Code: `jobs.scene_caption_blocks`, `captions.block_words`,
  `frontend/src/utils/captionBlocks.js`.

Without the key the app behaves as before: no Voice card, no sound effects, estimated caption timing. Code:
`backend/app/elevenlabs.py` (the client) and `backend/app/voiceover.py` (what the stitch does).

## Deploy

Order matters when a change touches more than one part: backend first, then frontend, then rules.
A backend deploy restarts the server and stops any take being generated.

```bash
gcloud run deploy ugc-api --source backend --region us-central1 --project flowmint-94e87 --quiet
```

```bash
cd frontend && npm run build && cd .. && npx firebase-tools deploy --only hosting:flowmint-94e87 --project flowmint-94e87
```

```bash
npx firebase-tools deploy --only firestore:rules,storage --project flowmint-94e87
```

Always pass `--only hosting:flowmint-94e87`: the same Firebase project also hosts the landing
page on another site.
