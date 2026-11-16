#!/usr/bin/env python3
"""Read-only deep inventory audit for the CIVIL AI repository.

This report separates implemented UI, automated source coverage, and missing
server-side integrations. It does not probe or modify the live production site.
"""
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
def read(path):
    p = ROOT / path
    return p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""

index = read("index.html")
guardian = read("guardian.html")
wrangler = read("wrangler.toml")
tests = {
    "brick_regression": read("tests/brick_calculator.test.cjs"),
    "calculator_regression": read("tests/calculator_regression.test.cjs"),
    "dom_xss_regression": read("tests/dom_xss_regression.test.cjs"),
}
workflows = {
    p.as_posix(): p.read_text(encoding="utf-8", errors="replace")
    for p in (ROOT / ".github/workflows").glob("*.yml")
} if (ROOT / ".github/workflows").is_dir() else {}

findings = []
coverage = {}
def finding(code, severity, area, title, detail, next_step):
    findings.append({
        "id": code, "severity": severity, "area": area, "title": title,
        "detail": detail, "recommended_action": next_step
    })

# Feature inventory: presence is not equivalent to verified correctness.
feature_patterns = {
    "concrete_calculator_ui": r'id="civil-concrete"',
    "steel_calculator_ui": r'id="steel-calculator"',
    "brick_calculator_ui": r'id="brick-calculator"',
    "ai_assistant_ui": r'id="ai-assistant"',
    "boq_generator_ui": r'id="boq-generator"',
    "project_reports_ui": r'Project Reports',
}
for name, pattern in feature_patterns.items():
    coverage[name] = bool(re.search(pattern, index, re.I))

# Calculators and test coverage.
coverage["concrete_calculator_function"] = "function ccCalculate" in index
coverage["steel_calculator_function"] = "function steelCalculate" in index
coverage["brick_calculator_function"] = "function brickCalculate" in index
coverage["boq_calculator_function"] = "function boqCalculate" in index
coverage["brick_regression_tests"] = bool(tests["brick_regression"])
coverage["dom_xss_regression_tests"] = bool(tests["dom_xss_regression"])
coverage["concrete_regression_tests"] = any("ccCalculate" in v for v in tests.values())
coverage["steel_regression_tests"] = any("steelCalculate" in v for v in tests.values())
coverage["boq_regression_tests"] = any("boqCalculate" in v for v in tests.values())

if coverage["concrete_calculator_function"] and not coverage["concrete_regression_tests"]:
    finding("QA-001", "high", "Testing", "Concrete calculator lacks automated regression tests",
            "A calculation function exists, but the repository has no dedicated automated tests for its inputs, units, mix ratios or output values.",
            "Add deterministic tests for metric/feet conversion, each supported ratio, invalid inputs and expected material quantities.")
if coverage["steel_calculator_function"] and not coverage["steel_regression_tests"]:
    finding("QA-002", "high", "Testing", "Steel calculator lacks automated regression tests",
            "The steel weight function exists, but no automated tests verify the formula, feet conversion, bar counts or invalid values.",
            "Add known-value tests and boundary tests before relying on the calculator.")
if coverage["boq_calculator_function"] and not coverage["boq_regression_tests"]:
    finding("QA-003", "high", "Testing", "BOQ generator lacks automated regression tests",
            "BOQ calculations, tax handling, add/remove row behavior and print flow have no dedicated automated regression suite.",
            "Add tests for subtotal, tax, grand total, invalid values, row operations and print validation.")

if "function boqPrint()" in index:
    print_fn = index.split("function boqPrint()", 1)[1].split("}", 1)[0]
    if "boqCalculate();" in print_fn and "window.print();" in print_fn:
        finding("BOQ-001", "medium", "BOQ", "Print flow may continue after invalid BOQ input",
                "boqPrint() calls boqCalculate() and then window.print(); boqCalculate() currently signals invalid GST/quantity/rate with alert and return, but does not return a success flag to stop printing.",
                "Make boqCalculate return true/false and call window.print() only when validation succeeds.")

coverage["brick_opening_overlap_disclosure"] = bool(re.search(
    r"Opening limitation:[\s\S]*non-overlapping[\s\S]*does not record opening positions",
    index, re.I
))
if "function brickCalculate()" in index:
    brick_fn = index.split("function brickCalculate()", 1)[1].split("</script>", 1)[0]
    if "doorCount * doorWidth" in brick_fn and "windowCount * windowWidth" in brick_fn and not coverage["brick_opening_overlap_disclosure"]:
        finding("BRICK-001", "medium", "Brick calculator", "Opening deduction assumes openings do not overlap",
                "The calculator multiplies count by one shared width/height and subtracts total opening volume. It does not accept opening positions, so overlapping door/window openings cannot be detected.",
                "Clearly state that openings must be non-overlapping, or add per-opening dimensions/positions and overlap validation.")

if "function ccCalculate" in index and "nominal mix ratio" in index.lower():
    finding("CONC-001", "medium", "Concrete calculator", "Concrete quantities are nominal-ratio estimates, not mix design",
            "The calculator uses preset nominal ratios and a dry-volume factor. It does not perform a laboratory/IS mix-design calculation or account for all material corrections.",
            "Keep the limitation visible and add a separate validated mix-design workflow only after engineering review.")

coverage["steel_theoretical_weight_disclosure"] = bool(re.search(
    r"Estimated Theoretical Steel Weight[\s\S]*theoretical bar weight only[\s\S]*hooks, bends, laps, couplers and wastage",
    index, re.I
))
if "function steelCalculate" in index and "Math.pow(dia, 2) / 162.2" in index and not coverage["steel_theoretical_weight_disclosure"]:
    finding("STEEL-001", "medium", "Steel calculator", "Steel output is a theoretical bar-weight estimate",
            "The dia²/162.2 formula estimates nominal mass per length. It does not include cutting length, hooks, bends, laps, couplers or wastage.",
            "Label the output as theoretical weight and add a separate bar-bending schedule workflow with verified rules.")

if "aiChatForm" in index:
    ai_section = index.split("<!-- CIVIL AI - AI ENGINEERING ASSISTANT -->", 1)[-1].split("<!-- END AI ENGINEERING ASSISTANT -->", 1)[0]
    coverage["ai_assistant_backend_call"] = bool(re.search(r'fetch\s*\(', ai_section))
    if not coverage["ai_assistant_backend_call"]:
        finding("AI-001", "critical", "AI backend", "AI Engineering Assistant is a frontend placeholder",
                "The submit handler appends a fixed message saying the secure connection is not active; it does not call a backend or AI model.",
                "Build a Cloudflare Worker endpoint, keep provider credentials server-side, validate requests and connect the existing chat UI.")

coverage["auth_backend_call"] = bool(re.search(r'fetch\s*\(', index) and re.search(r'\b(login|authentication|auth)\b', index, re.I))
coverage["payment_backend_call"] = bool(re.search(r'fetch\s*\(', index) and re.search(r'\b(payment|checkout|webhook)\b', index, re.I))
if not coverage["auth_backend_call"]:
    finding("AUTH-001", "critical", "Authentication", "No server-side login/authentication integration detected",
            "The current repository does not contain a verified login backend or server-side session/entitlement enforcement.",
            "Implement secure authentication before enabling Premium account access.")
if not coverage["payment_backend_call"]:
    finding("PAY-001", "critical", "Payments", "No payment verification/webhook backend detected",
            "There is no verified payment provider callback/webhook or server-side entitlement check in the current source.",
            "Keep every Premium feature disabled until verified payment and entitlement checks are implemented and tested.")

coverage["worker_entrypoint"] = bool(re.search(r'(?m)^\s*main\s*=', wrangler))
coverage["worker_name_placeholder"] = bool(re.search(r'(?m)^\s*name\s*=\s*["\']untitled["\']', wrangler))
if not coverage["worker_entrypoint"] or coverage["worker_name_placeholder"]:
    finding("WORKER-001", "high", "Cloudflare backend", "Repository does not define a deployable AI Worker entry point",
            "wrangler.toml still has name = untitled and no main entry point. Do not deploy this placeholder config as the AI backend.",
            "Create a separately named Worker with an explicit entry point and verify its build/deployment independently of Pages.")

coverage["guardian_dashboard_ui"] = "Company Guardian" in guardian
coverage["guardian_live_monitoring"] = bool(re.search(r'fetch\s*\(', guardian))
if coverage["guardian_dashboard_ui"] and not coverage["guardian_live_monitoring"]:
    finding("GUARDIAN-001", "high", "Company Guardian", "Guardian dashboard is a static UI, not a live monitoring service",
            "Agent cards show NOT CONNECTED/PLANNED states and dashboard metrics are hard-coded; no live monitoring API is called.",
            "Connect authenticated read-only status endpoints and display timestamped real results; keep production actions owner-approved.")

if coverage["project_reports_ui"] and not re.search(r'<section[^>]+id=["\']project-report', index, re.I):
    finding("REPORT-001", "medium", "Project reports", "Project Reports generator is not implemented",
            "The landing card points to the generic Coming Soon/contact section; no Project Reports generator section was found.",
            "Keep it clearly marked In Development until a real report workflow exists.")

coverage["security_headers_file"] = bool(read("_headers"))
coverage["security_audit_workflow"] = any("civil-ai-security-audit" in p for p in workflows)
coverage["full_audit_workflow"] = any("civil-ai-audit" in p for p in workflows)
coverage["bug_fixer_is_read_only"] = any("contents: read" in c and "No source files are changed automatically" in c for p,c in workflows.items() if "bug-fixer" in p)
if not coverage["bug_fixer_is_read_only"]:
    finding("BUGFIX-001", "medium", "Bug Fixer", "Bug Fixer automation safety mode needs confirmation",
            "Could not verify the expected read-only permissions and no-auto-edit notice in the workflow.",
            "Keep the agent read-only until branch-based patch generation, tests and owner review are implemented.")

finding("LIVE-001", "info", "Live verification", "Live browser and production security checks are outside this static audit",
        "This script reads repository files only. It does not execute a real browser session, probe production endpoints, inspect Cloudflare WAF settings, verify MFA, or perform penetration testing.",
        "Run browser-based end-to-end tests and an authorized security configuration review separately.")

critical = sum(1 for f in findings if f["severity"] == "critical")
high = sum(1 for f in findings if f["severity"] == "high")
medium = sum(1 for f in findings if f["severity"] == "medium")
report = {
    "audit": "CIVIL AI Full Company Audit - Phase 1",
    "mode": "read-only repository inventory and static feature-gap analysis",
    "status": "REVIEW_REQUIRED" if critical or high else ("PASS_WITH_WARNINGS" if medium else "PASS"),
    "summary": {"critical": critical, "high": high, "medium": medium, "total_findings": len(findings)},
    "feature_coverage": coverage,
    "findings": findings,
    "limitations": [
        "No files are modified by this audit.",
        "Static source inspection is not a live browser test or penetration test.",
        "Engineering formulas require independent verification against applicable standards and qualified engineering review.",
        "No live Cloudflare account settings, WAF rules, MFA, secrets, payment provider or API quotas are inspected."
    ]
}
print(json.dumps(report, indent=2))
sys.exit(0)
