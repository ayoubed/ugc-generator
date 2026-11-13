"""
Try a prompt on the saved cases and see what it produces.

    cd backend
    ../venv/bin/python -m evals.run --list
    ../venv/bin/python -m evals.run script_writer --dry-run            # show the prompts, call no model
    ../venv/bin/python -m evals.run script_writer                      # run the live prompt on every case
    ../venv/bin/python -m evals.run script_writer --variant new.md     # the live prompt against your new wording
    ../venv/bin/python -m evals.run asset_bible --case watch-no-name

A target is one model call the app makes (see TARGETS). Its cases are the JSON files in
evals/cases/<target>/. Each run saves every output to evals/runs/<time>_<target>/ so two wordings
can be read side by side, and prints which automatic checks passed (evals/checks.py).

--variant FILE replaces one prompt file for the run: by default the prompt named like the target,
or the one given with --prompt (e.g. --prompt script_writer.product_led).
Real runs call the model and cost a little; --dry-run costs nothing.
"""
import argparse
import datetime
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from app import pipeline, prompts
from app.model_registry import get_script_model
from evals import checks

HERE = Path(__file__).parent
Check = Tuple[str, bool, str]


def _script(case_input: Dict[str, Any], model: Optional[str]) -> Dict[str, Any]:
    return pipeline.generate_script_and_scenes(llm_model=get_script_model(model)["id"], **case_input)


def _details(case_input: Dict[str, Any], model: Optional[str]) -> Dict[str, Any]:
    return pipeline.extract_asset_bible(
        idea=case_input["idea"], llm_model=get_script_model(model)["id"],
        product_name=case_input.get("product_name"), video_type=case_input.get("video_type"),
    )


# target -> (what it does, the model call, the checks on its output)
TARGETS: Dict[str, Tuple[str, Callable, Callable]] = {
    "script_writer": ("Writes the video context and the scenes from an idea.", _script, checks.check_script),
    "asset_bible": ("Writes the consistent details from an idea (text only; pictures are not in the cases).", _details, checks.check_details),
}


def load_cases(target: str, only: Optional[str] = None) -> List[Dict[str, Any]]:
    folder = HERE / "cases" / target
    cases = []
    for path in sorted(folder.glob("*.json")):
        case = json.loads(path.read_text(encoding="utf-8"))
        case.setdefault("name", path.stem)
        if not only or case["name"] == only:
            cases.append(case)
    return cases


class _Recorder:
    """Stands in for the model client in a dry run: keeps the prompt and answers with nothing."""

    def __init__(self) -> None:
        self.prompts: List[str] = []
        self.models = self

    def generate_content(self, model: str, contents: Any, config: Any) -> Any:
        self.prompts.append(contents if isinstance(contents, str) else contents[-1])
        return type("Answer", (), {"text": '{"video_context": "", "scenes": []}'})()


def run_case(target: str, case: Dict[str, Any], model: Optional[str] = None, dry_run: bool = False) -> Dict[str, Any]:
    """One case through one target: {"output", "checks": [(name, passed, detail)], "prompt" (dry run), "error"}."""
    _, call, check = TARGETS[target]
    if dry_run:
        recorder, real = _Recorder(), pipeline.get_client
        pipeline.get_client = lambda: recorder
        try:
            call(dict(case.get("input") or {}), model)
        finally:
            pipeline.get_client = real
        return {"prompt": recorder.prompts[-1] if recorder.prompts else "", "output": None, "checks": []}
    try:
        output = call(dict(case.get("input") or {}), model)
    except Exception as e:  # one failing case must not hide the others
        return {"output": None, "checks": [("ran without an error", False, str(e)[:300])], "error": str(e)}
    return {"output": output, "checks": check(case.get("input") or {}, output, case.get("expect") or {})}


def run(target: str, labels: Dict[str, Optional[Tuple[str, str]]], cases: List[Dict[str, Any]],
        model: Optional[str] = None, dry_run: bool = False, out_dir: Optional[Path] = None) -> Dict[str, Dict[str, Any]]:
    """
    Runs every case once per label. `labels` maps a label ("live", "variant") to None (the prompt
    files as they are) or (prompt name, replacement text). Returns {case name: {label: result}}.
    """
    results: Dict[str, Dict[str, Any]] = {}
    for case in cases:
        results[case["name"]] = {}
        for label, replacement in labels.items():
            if replacement:
                with prompts.override(replacement[0], replacement[1]):
                    result = run_case(target, case, model, dry_run)
            else:
                result = run_case(target, case, model, dry_run)
            results[case["name"]][label] = result
            if out_dir:
                out_dir.mkdir(parents=True, exist_ok=True)
                saved = {"case": case, "label": label, **{k: v for k, v in result.items() if k != "checks"},
                         "checks": [{"check": n, "passed": ok, "detail": d} for n, ok, d in result["checks"]]}
                (out_dir / f"{case['name']}.{label}.json").write_text(json.dumps(saved, indent=2, ensure_ascii=False), encoding="utf-8")
    return results


def summary(results: Dict[str, Dict[str, Any]]) -> str:
    """A plain-text report: per case and label, how many checks passed and which failed."""
    lines: List[str] = []
    totals: Dict[str, List[int]] = {}
    for case_name, by_label in results.items():
        lines.append(case_name)
        for label, result in by_label.items():
            passed = sum(1 for _, ok, _ in result["checks"] if ok)
            totals.setdefault(label, [0, 0])
            totals[label][0] += passed
            totals[label][1] += len(result["checks"])
            lines.append(f"  {label}: {passed}/{len(result['checks'])} checks passed")
            lines += [f"    FAILED {name}: {detail}" for name, ok, detail in result["checks"] if not ok]
    lines.append("")
    lines += [f"{label}: {passed}/{total} checks passed over {len(results)} cases" for label, (passed, total) in totals.items()]
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Try a prompt on the saved cases.")
    parser.add_argument("target", nargs="?", help="what to run (see --list)")
    parser.add_argument("--list", action="store_true", help="show the targets, their cases and every prompt file")
    parser.add_argument("--case", help="run only this case")
    parser.add_argument("--variant", help="a text file with a new wording to compare against the live prompt")
    parser.add_argument("--prompt", help="which prompt file --variant replaces (default: the one named like the target)")
    parser.add_argument("--model", help="script model to use (default: the app's default)")
    parser.add_argument("--dry-run", action="store_true", help="print the prompts that would be sent; call no model")
    args = parser.parse_args(argv)

    if args.list or not args.target:
        for name, (about, _, _) in TARGETS.items():
            print(f"{name}: {about}")
            for case in load_cases(name):
                print(f"    {case['name']}: {case.get('about', '')}")
        print("\nPrompt files:", ", ".join(prompts.names()))
        return 0
    if args.target not in TARGETS:
        print(f"Unknown target '{args.target}'. Choose one of: {', '.join(TARGETS)}.", file=sys.stderr)
        return 2
    cases = load_cases(args.target, args.case)
    if not cases:
        print("No such case.", file=sys.stderr)
        return 2

    labels: Dict[str, Optional[Tuple[str, str]]] = {"live": None}
    if args.variant:
        labels["variant"] = (args.prompt or args.target, Path(args.variant).read_text(encoding="utf-8"))

    if args.dry_run:
        for case_name, by_label in run(args.target, labels, cases, args.model, dry_run=True).items():
            for label, result in by_label.items():
                print(f"===== {case_name} ({label}) =====\n{result['prompt']}\n")
        return 0

    if not os.environ.get("GEMINI_API_KEY") and os.environ.get("API_PROVIDER", "AI_STUDIO") == "AI_STUDIO":
        from dotenv import load_dotenv
        load_dotenv(HERE.parent / ".env")
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = HERE / "runs" / f"{stamp}_{args.target}"
    results = run(args.target, labels, cases, args.model, out_dir=out_dir)
    print(summary(results))
    print(f"\nEvery output is saved in {out_dir} to read side by side.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
