"""The prompt files (app/prompts) and the try-out runner (evals)."""
import json
import re

import pytest

from app import pipeline, prompts
from evals import checks, run as evals_run


# --- the prompt files -----------------------------------------------------------------------------

def test_every_prompt_file_can_be_read_and_has_a_note_for_people():
    names = prompts.names()
    assert {"script_writer", "take_check", "reference_breakdown", "asset_bible", "video.realism"} <= set(names)
    for name in names:
        raw = (prompts.FOLDER / f"{name}.md").read_text(encoding="utf-8")
        assert raw.startswith("#! "), f"{name} has no note saying what it is for"
        assert prompts.text(name).strip(), f"{name} is empty"
        assert "#!" not in prompts.text(name)                      # notes are never sent to a model


def test_no_prompt_has_a_blank_written_the_old_way():
    # A single {name} would be sent to the model as it is: blanks are {{name}}.
    for name in prompts.names():
        leftovers = re.findall(r"(?<!\{)\{[a-z_]+\}(?!\})", prompts.text(name))
        assert not leftovers, f"{name}: {leftovers}"


def test_rendering_fills_every_blank():
    assert prompts.render("product_name.given", name="Luma") == (
        'PRODUCT NAME: "Luma". Whenever the product or its brand is named, use exactly this name, '
        "spelled this way. Never invent another product or brand name."
    )
    assert prompts.blanks("script_writer.hook_named") == ["hook_style", "hook_frameworks"]


def test_a_missing_or_unknown_blank_fails_loudly():
    with pytest.raises(prompts.PromptError, match="no value for \\['name'\\]"):
        prompts.render("product_name.given")
    with pytest.raises(prompts.PromptError, match="no blank for"):
        prompts.render("product_name.given", name="Luma", colour="red")
    with pytest.raises(prompts.PromptError, match="no prompt named"):
        prompts.text("does_not_exist")


def test_a_variant_replaces_a_prompt_only_inside_its_block():
    live = prompts.text("video.realism")
    with prompts.override("video.realism", "#! a note\nKeep it real."):
        assert prompts.text("video.realism") == "Keep it real."
        assert "Keep it real." in pipeline.build_omni_extend_prompt("She turns it.") or pipeline.REALISM_INSTRUCTION == live
    assert prompts.text("video.realism") == live
    with pytest.raises(prompts.PromptError):
        with prompts.override("nope", "x"):
            pass


def test_the_code_uses_the_files():
    assert pipeline.REALISM_INSTRUCTION == prompts.text("video.realism")
    assert pipeline.scene_speech_rule("") == prompts.text("video.silent_scene")
    assert pipeline.scene_speech_rule("Hi.") == prompts.text("video.spoken_words")
    assert pipeline.product_name_rule(None) == prompts.text("product_name.missing")
    assert prompts.text("storyboard.frame.product_led") in pipeline.build_storyboard_frame_prompt("x", [], product_led=True)


# --- the automatic checks -------------------------------------------------------------------------

def scene(script, description="She holds the watch.", context="Close-up."):
    return {"script": script, "description": description, "context": context,
            "prompt": f"What They Say: {script}\nWhat happens: {description}\nContext: {context}"}


GOOD = {"video_context": "A bright room.", "scenes": [scene("This watch looks far more expensive than it is."), scene("And it goes with everything you own, every day.")]}
INPUT = {"idea": "Ad for a watch", "num_scenes": 2, "target_words_per_scene": 9}


def failed(results):
    return [name for name, ok, _ in results if not ok]


def test_a_sound_script_passes_every_check():
    assert failed(checks.check_script(INPUT, GOOD, {})) == []


def test_the_checks_catch_what_went_wrong_before():
    made_up = {"scenes": [scene("Meet the Aura watch, a new kind of luxury for you."), scene("It goes with everything you own, every single day.")]}
    assert failed(checks.check_script(INPUT, made_up, {})) == ["no made-up names in the spoken text"]
    assert failed(checks.check_script({**INPUT, "product_name": "Aura"}, made_up, {})) == []          # the user's own name is fine
    assert failed(checks.check_script({**INPUT, "product_name": "Luma"}, GOOD, {})) == ["uses the product name as written"]

    directed = {"scenes": [scene("[smiling] This watch looks far more expensive than it is."), scene("And it goes with everything you own, every day.")]}
    assert "no stage directions in the spoken text" in failed(checks.check_script(INPUT, directed, {}))

    assert "scene count" in failed(checks.check_script({**INPUT, "num_scenes": 3}, GOOD, {}))
    assert "words per scene" in failed(checks.check_script({**INPUT, "target_words_per_scene": 30}, GOOD, {}))
    broken = {"scenes": [{**scene("This watch looks far more expensive than it is."), "prompt": "just text"}, GOOD["scenes"][1]]}
    assert "video prompt has its three lines" in failed(checks.check_script(INPUT, broken, {}))


def test_a_product_led_script_may_not_show_a_face():
    faced = {"scenes": [scene("This watch looks far more expensive than it is.", description="She smiles and looks at the camera."), GOOD["scenes"][1]]}
    assert failed(checks.check_script({**INPUT, "video_type": "product"}, faced, {})) == ["no face or presenter in a product-led video"]
    assert failed(checks.check_script(INPUT, faced, {})) == []                                      # fine for a creator video


def test_a_case_can_ask_for_or_forbid_words():
    assert failed(checks.check_script(INPUT, GOOD, {"must_contain": ["Rolex"]})) == ["contains what the case asks for"]
    assert failed(checks.check_script(INPUT, GOOD, {"must_not_contain": ["expensive"]})) == ["avoids what the case forbids"]


def test_the_scene_count_follows_a_reference_structure():
    structure = {"scenes": [{"purpose": "Hook"}, {"purpose": "Offer"}]}
    assert "scene count" not in failed(checks.check_script({"idea": "x", "num_scenes": 9, "target_words_per_scene": 9, "structure": structure}, GOOD, {}))


def test_the_details_checks():
    details = {"character": "A woman's hands, neutral nails.", "hero_props": "A silver watch.", "setting": "A dark surface.", "voice": "Calm narrator."}
    assert failed(checks.check_details({"idea": "Ad for a watch", "video_type": "product"}, details, {})) == []
    faced = {**details, "character": "A woman with long blonde hair."}
    assert failed(checks.check_details({"idea": "x", "video_type": "product"}, faced, {})) == ["no face described for a product-led video"]
    branded = {**details, "hero_props": "A silver watch with the name Poedagar on the dial."}
    assert failed(checks.check_details({"idea": "Ad for a watch"}, branded, {})) == ["no made-up brand on the product"]
    assert "fields are filled in" in failed(checks.check_details({"idea": "x"}, {**details, "voice": ""}, {}))


# --- the runner -----------------------------------------------------------------------------------

def test_every_saved_case_is_valid_and_belongs_to_a_target():
    folders = {path.name for path in (evals_run.HERE / "cases").iterdir() if path.is_dir()}
    assert folders == set(evals_run.TARGETS)
    for target in evals_run.TARGETS:
        cases = evals_run.load_cases(target)
        assert cases, f"{target} has no cases"
        for case in cases:
            assert case.get("about") and isinstance(case.get("input"), dict) and case["input"].get("idea"), case["name"]


def test_a_dry_run_shows_the_prompt_and_calls_no_model(monkeypatch):
    monkeypatch.setattr(pipeline, "get_client", lambda: pytest.fail("a dry run must not reach the model"))
    case = evals_run.load_cases("script_writer", "watch-product-led")[0]
    result = evals_run.run_case("script_writer", case, dry_run=True)
    assert "PRODUCT-LED" in result["prompt"] and 'PRODUCT NAME: "Carré Royale"' in result["prompt"]
    assert result["checks"] == []


def test_a_run_compares_the_live_prompt_with_a_variant_and_saves_both(tmp_path, monkeypatch):
    seen = []

    def fake_script(case_input, model):
        seen.append(prompts.text("script_writer.product_led"))
        named = "Aura" if "NEW WORDING" not in seen[-1] else "this watch"
        return {"scenes": [scene(f"Meet {named}, which looks far more expensive than it is."), GOOD["scenes"][1]]}

    monkeypatch.setitem(evals_run.TARGETS, "script_writer", ("x", fake_script, checks.check_script))
    cases = [{"name": "demo", "input": INPUT, "expect": {}}]
    labels = {"live": None, "variant": ("script_writer.product_led", "#! note\nNEW WORDING")}
    results = evals_run.run("script_writer", labels, cases, out_dir=tmp_path)

    assert seen[0] == prompts.text("script_writer.product_led") and seen[1] == "NEW WORDING"
    assert failed(results["demo"]["live"]["checks"]) == ["no made-up names in the spoken text"]
    assert failed(results["demo"]["variant"]["checks"]) == []
    report = evals_run.summary(results)
    assert "live: 4/5 checks passed over 1 cases" in report and "variant: 5/5 checks passed over 1 cases" in report
    assert "FAILED no made-up names in the spoken text: found: ['Aura']" in report
    saved = json.loads((tmp_path / "demo.variant.json").read_text())
    assert saved["label"] == "variant" and saved["output"]["scenes"] and saved["checks"][0]["check"] == "scene count"


def test_a_case_that_errors_is_reported_and_the_run_goes_on(monkeypatch):
    def broken(case_input, model):
        raise RuntimeError("The model account has run out of credit.")

    monkeypatch.setitem(evals_run.TARGETS, "script_writer", ("x", broken, checks.check_script))
    results = evals_run.run("script_writer", {"live": None}, [{"name": "a", "input": INPUT}, {"name": "b", "input": INPUT}])
    assert set(results) == {"a", "b"}
    assert results["a"]["live"]["checks"] == [("ran without an error", False, "The model account has run out of credit.")]


def test_the_command_lists_and_refuses_what_it_does_not_know(capsys):
    assert evals_run.main(["--list"]) == 0
    listed = capsys.readouterr().out
    assert "script_writer:" in listed and "watch-no-name" in listed and "Prompt files:" in listed
    assert evals_run.main(["nope"]) == 2
    assert evals_run.main(["script_writer", "--case", "nope"]) == 2
