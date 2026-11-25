#!/usr/bin/env python3
"""Read-only CIVIL AI repository feature-gap audit.

Inspects the current frontend, Worker, auth module, migrations, tests and
workflow definitions. It does not contact or modify production services.
"""
from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]

def read(name):
    path = ROOT / name
    return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""

files = {
    "index": read("index.html"),
    "guardian": read("guardian.html"),
    "wrangler": read("wrangler.toml"),
    "worker": read("worker/index.js"),
    "auth": read("worker/auth.js"),
    "migration": read("migrations/0001_auth_entitlements.sql"),
    "admin_migration": read("migrations/0002_admin_audit_logs.sql"),
    "ai_tests": read("tests/ai_assistant_api.test.mjs"),
    "auth_tests": read("tests/auth_e2e.test.mjs"),
    "calculator_tests": read("tests/calculator_regression.test.cjs"),
    "brick_tests": read("tests/brick_calculator.test.cjs"),
    "dom_tests": read("tests/dom_xss_regression.test.cjs"),
    "security_audit": read("tools/civil_ai_security_audit.py"),
}
workflow_dir = ROOT / ".github/workflows"
workflows = {p.name: p.read_text(encoding="utf-8", errors="replace")
             for p in workflow_dir.glob("*.yml")} if workflow_dir.is_dir() else {}
findings, coverage = [], {}

def finding(code, severity, area, title, detail, next_step):
    findings.append({"id": code, "severity": severity, "area": area,
                     "title": title, "detail": detail,
                     "recommended_action": next_step})

def has(text, pattern):
    return bool(re.search(pattern, text, re.I | re.M))

idx, worker, auth = files["index"], files["worker"], files["auth"]
coverage["frontend_calculators"] = {
    "concrete": "function ccCalculate" in idx,
    "steel": "function steelCalculate" in idx,
    "brick": "function brickCalculate" in idx,
    "boq": "function boqCalculate" in idx,
}
coverage["regression_tests"] = {
    "calculator_suite": bool(files["calculator_tests"]),
    "brick": bool(files["brick_tests"]),
    "ai_api": bool(files["ai_tests"]),
    "auth_e2e": bool(files["auth_tests"]),
    "dom_xss": bool(files["dom_tests"]),
}
coverage["ai_assistant_backend_call"] = has(idx, r'fetch\s*\(\s*["\']https://civil-ai-backend[^\']*/api/ai/ask')
coverage["ai_worker_route"] = 'url.pathname === "/api/ai/ask"' in worker
coverage["ai_model_binding"] = "env.AI.run(AI_MODEL" in worker
coverage["ai_ui_stale_configuration_note"] = has(idx, r"AI connection is being configured|activated after secure AI backend integration")
if not coverage["ai_assistant_backend_call"] or not coverage["ai_worker_route"] or not coverage["ai_model_binding"]:
    finding("AI-001", "high", "AI Assistant", "AI request path is not fully connected",
            "The audit did not find all three expected pieces: frontend request, Worker route and Workers AI model call.",
            "Trace the frontend-to-Worker request and add an isolated end-to-end API test.")
if coverage["ai_ui_stale_configuration_note"] and coverage["ai_assistant_backend_call"] and coverage["ai_worker_route"]:
    finding("AI-002", "low", "AI Assistant UI", "AI Assistant contains stale setup wording",
            "The frontend calls the deployed Worker, but a visible note still says the AI connection is being configured.",
            "Replace the stale note with an accurate informational-use and engineering-verification disclaimer.")

coverage["authentication"] = {
    "worker_routes_to_auth_handler": 'url.pathname.startsWith("/api/auth/")' in worker,
    "register_and_verify_implemented": all(x in auth for x in ['/api/auth/register', '/api/auth/verify-email']),
    "session_lookup_implemented": "export async function getSessionUser" in auth,
    "email_verification_required_for_premium": "Number(user.email_verified) !== 1" in auth and "export async function requirePremium" in auth,
    "auth_e2e_tests": bool(files["auth_tests"]),
}
if not coverage["authentication"]["worker_routes_to_auth_handler"] or not coverage["authentication"]["session_lookup_implemented"]:
    finding("AUTH-001", "critical", "Authentication", "Worker authentication routing or session lookup is missing",
            "Expected Worker-to-auth-handler routing and session lookup were not both detected.",
            "Restore and test the account registration, verification, session and logout routes.")
coverage["premium"] = {
    "entitlement_table": "CREATE TABLE IF NOT EXISTS premium_entitlements" in files["migration"],
    "require_premium_guard_defined": "export async function requirePremium" in auth,
    "require_premium_guard_used_by_worker_routes": "requirePremium(" in worker,
    "premium_api_routes_detected": has(worker, r'premium|boq|report|takeoff|estimate|structural'),
}
if coverage["premium"]["entitlement_table"] and coverage["premium"]["require_premium_guard_defined"] and not coverage["premium"]["require_premium_guard_used_by_worker_routes"]:
    finding("PREM-001", "critical", "Premium access control", "Premium entitlement guard exists but is not wired into Worker feature routes",
            "The auth module defines requirePremium(), and the database has an entitlement table, but worker/index.js does not call the guard. Frontend labels or hidden cards are not server-side authorization.",
            "Before exposing paid APIs, route each Premium operation through requirePremium() and add denied/allowed authorization tests.")
elif not coverage["premium"]["entitlement_table"] or not coverage["premium"]["require_premium_guard_defined"]:
    finding("PREM-001", "critical", "Premium access control", "Premium entitlement enforcement foundation is incomplete",
            "The audit did not find both the entitlement schema and a server-side premium guard.",
            "Implement the entitlement schema and require verified sessions plus active entitlements on every Premium endpoint.")

coverage["payments"] = {
    "provider_or_checkout_in_worker": has(worker + auth, r'razorpay|stripe|cashfree|payu|checkout'),
    "webhook_route": has(worker + auth, r'webhook'),
    "signature_verification": has(worker + auth, r'webhook.{0,80}signature|signature.{0,80}webhook|verify.{0,40}signature'),
}
if not coverage["payments"]["provider_or_checkout_in_worker"] or not coverage["payments"]["webhook_route"]:
    finding("PAY-001", "critical", "Payments", "Verified payment-to-entitlement workflow is not implemented",
            "No payment provider checkout/webhook flow was detected in the Worker source. The entitlement table alone does not verify a payment.",
            "Keep Premium activation manual/disabled until a provider callback, signature verification, idempotency and entitlement issuance are implemented and tested.")
elif not coverage["payments"]["signature_verification"]:
    finding("PAY-002", "high", "Payments", "Payment webhook signature verification was not detected",
            "A payment callback route may exist, but the audit did not find signature verification.",
            "Verify provider signatures, replay protection and idempotency before granting entitlements.")

coverage["worker"] = {
    "wrangler_main": has(files["wrangler"], r'^\s*main\s*='),
    "entrypoint_file": bool(files["worker"]),
    "health_route": 'url.pathname === "/api/health"' in worker,
    "ai_route": coverage["ai_worker_route"],
}
if not coverage["worker"]["wrangler_main"] or not coverage["worker"]["entrypoint_file"]:
    finding("WORKER-001", "high", "Cloudflare Worker", "Worker entry point configuration is incomplete",
            "wrangler.toml and worker/index.js were not both detected.",
            "Verify the deployed Worker entry point and keep Pages and Worker deployment settings separate.")

coverage["guardian"] = {
    "dashboard_present": "Company Guardian" in files["guardian"],
    "live_fetch": has(files["guardian"], r'fetch\s*\('),
}
if coverage["guardian"]["dashboard_present"] and not coverage["guardian"]["live_fetch"]:
    finding("GUARDIAN-001", "high", "Company Guardian", "Guardian dashboard is not connected to live agent status",
            "The dashboard source has no fetch-based live status integration; visual cards alone do not prove active agents.",
            "Add authenticated read-only health/status endpoints with timestamps; require owner approval for any write action.")

coverage["project_reports"] = {
    "landing_card_present": "Project Reports" in idx,
    "generator_section_present": has(idx, r'<section[^>]+id=["\']project-report'),
}
if coverage["project_reports"]["landing_card_present"] and not coverage["project_reports"]["generator_section_present"]:
    finding("REPORT-001", "medium", "Project Reports", "Project Report Generator is not implemented",
            "The landing page advertises Project Reports but no dedicated generator section was detected.",
            "Keep the card marked In Development until a real report workflow and tests are ready.")

coverage["boq"] = {
    "generator_ui": 'id="boq-generator"' in idx,
    "validates_before_print": "if (!boqCalculate()) return false;" in idx,
    "server_side_premium_guard": "requirePremium(" in worker and has(worker, r'boq'),
}
if coverage["boq"]["generator_ui"] and not coverage["boq"]["validates_before_print"]:
    finding("BOQ-001", "medium", "BOQ", "BOQ print validation is not confirmed",
            "The audit did not find a success check preventing print after invalid calculation inputs.",
            "Make calculation return a boolean and stop printing unless validation succeeds.")
if coverage["boq"]["generator_ui"] and not coverage["boq"]["server_side_premium_guard"]:
    finding("BOQ-002", "high", "BOQ Premium protection", "BOQ is a frontend tool without a detected server-side entitlement gate",
            "The BOQ UI is present, but the Worker has no BOQ endpoint protected by requirePremium(). Client-side labels are not a secure paywall.",
            "Keep BOQ classified as not payment-protected until server-side authorization exists.")

coverage["engineering_limitations"] = {
    "brick_opening_overlap_disclosed": has(idx, r'opening limitation.{0,160}non-overlapping|openings must be non-overlapping'),
    "nominal_mix_not_mix_design_disclosed": has(idx, r'nominal.{0,50}mix ratio|not a mix design'),
    "steel_theoretical_weight_disclosed": has(idx, r'theoretical.{0,80}(hooks|bends|laps|wastage)'),
}
if coverage["frontend_calculators"]["brick"] and not coverage["engineering_limitations"]["brick_opening_overlap_disclosed"]:
    finding("BRICK-001", "medium", "Brick calculator", "Opening overlap limitation is not clearly disclosed",
            "The current calculation appears to subtract aggregate door/window opening volumes without recording opening positions.",
            "State that openings must not overlap, or implement per-opening geometry and overlap checks.")
if coverage["frontend_calculators"]["concrete"] and not coverage["engineering_limitations"]["nominal_mix_not_mix_design_disclosed"]:
    finding("CONC-001", "medium", "Concrete calculator", "Nominal quantity estimate may be confused with engineered mix design",
            "A nominal-ratio material estimate is not a laboratory/standard mix-design workflow.",
            "Clearly separate nominal quantity estimates from a future validated mix-design module.")
if coverage["frontend_calculators"]["steel"] and not coverage["engineering_limitations"]["steel_theoretical_weight_disclosed"]:
    finding("STEEL-001", "medium", "Steel calculator", "Theoretical steel weight limitation is not clearly disclosed",
            "A diameter-squared weight formula does not calculate a complete bar-bending schedule.",
            "Label it theoretical weight and add BBS only with verified bend, hook, lap and wastage rules.")

coverage["security_and_ci"] = {
    "security_audit_script": bool(files["security_audit"]),
    "auth_tests": bool(files["auth_tests"]),
    "ai_api_tests": bool(files["ai_tests"]),
    "full_audit_workflow": "civil-ai-full-audit.yml" in workflows,
    "full_audit_manual_trigger": "workflow_dispatch:" in workflows.get("civil-ai-full-audit.yml", ""),
    "bug_fixer_workflow_present": any("bug-fixer" in name for name in workflows),
}
if not coverage["security_and_ci"]["full_audit_workflow"] or not coverage["security_and_ci"]["full_audit_manual_trigger"]:
    finding("CI-001", "medium", "Audit automation", "Manual full-audit workflow trigger is not configured",
            "The full company audit workflow or its manual trigger was not detected.",
            "Add workflow_dispatch and retain source-path triggers for the audit workflow.")

finding("LIVE-001", "info", "Audit limitations", "Production and account-level checks are outside this repository audit",
        "This audit does not probe production endpoints, inspect Cloudflare dashboard settings/secrets/WAF/MFA, or perform penetration testing.",
        "Perform a separate authorized live smoke test and account security review.")

counts = {level: sum(1 for item in findings if item["severity"] == level)
          for level in ("critical", "high", "medium", "low", "info")}
report = {
    "audit": "CIVIL AI Full Company Audit - Updated",
    "mode": "read-only repository feature-gap analysis",
    "status": "REVIEW_REQUIRED" if counts["critical"] or counts["high"] else ("PASS_WITH_WARNINGS" if counts["medium"] else "PASS"),
    "summary": {**counts, "total_findings": len(findings)},
    "feature_coverage": coverage,
    "findings": findings,
    "limitations": [
        "Repository-only static inspection; no production requests are made.",
        "A detected source pattern does not prove runtime correctness.",
        "Engineering calculations require applicable-code and qualified-engineer verification.",
        "Cloudflare account settings, secrets, WAF, MFA, payment provider dashboards and quotas are not inspected."
    ]
}
print(json.dumps(report, indent=2))
sys.exit(0)
