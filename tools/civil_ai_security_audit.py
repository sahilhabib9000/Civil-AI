#!/usr/bin/env python3
"""Read-only baseline security and backend configuration audit for CIVIL AI."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
files = {
    "index.html": ROOT / "index.html",
    "guardian.html": ROOT / "guardian.html",
    "wrangler.toml": ROOT / "wrangler.toml",
}
errors = []
warnings = []
checks = {}

for name, path in files.items():
    if not path.is_file():
        errors.append(f"Required file missing: {name}")

source = "\n".join(p.read_text(encoding="utf-8", errors="replace")
                   for n, p in files.items() if n.endswith(".html") and p.exists())
wrangler = files["wrangler.toml"].read_text(encoding="utf-8", errors="replace") if files["wrangler.toml"].exists() else ""
headers_path = ROOT / "_headers"
headers = headers_path.read_text(encoding="utf-8", errors="replace") if headers_path.exists() else ""

secret_patterns = [
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    r"(?i)\bAKIA[0-9A-Z]{16}\b",
    r"(?i)(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*['\"][A-Za-z0-9_./+=-]{16,}['\"]",
]
secret_hits = [p for p in secret_patterns if re.search(p, source)]
if secret_hits:
    errors.append("Possible hard-coded credential pattern detected in HTML source.")
checks["possible_hardcoded_secrets"] = len(secret_hits)

dangerous_patterns = [r"\beval\s*\(", r"\bnew\s+Function\s*\(", r"\bdocument\.write\s*\("]
dangerous_hits = [p for p in dangerous_patterns if re.search(p, source)]
if dangerous_hits:
    warnings.append("Potentially dangerous JavaScript execution/write API found; review manually.")
checks["dangerous_javascript_patterns"] = len(dangerous_hits)

checks["dynamic_html_sink_count"] = len(re.findall(r"\.innerHTML\s*=", source))
if checks["dynamic_html_sink_count"]:
    warnings.append("Dynamic innerHTML assignments exist; verify all inserted values are trusted or escaped.")

checks["insecure_http_url_count"] = len(re.findall(r"https?://(?!localhost)[^\s\"'<>]+", source, re.I)) - len(re.findall(r"https://", source, re.I))
if checks["insecure_http_url_count"] > 0:
    warnings.append("One or more plain-HTTP URLs found; review whether HTTPS is available.")

required_headers = [
    "X-Content-Type-Options: nosniff",
    "X-Frame-Options: DENY",
    "Referrer-Policy: strict-origin-when-cross-origin",
    "Permissions-Policy:",
]
missing_headers = [h for h in required_headers if h.lower() not in headers.lower()]
checks["security_headers_configured"] = len(required_headers) - len(missing_headers)
checks["security_headers_missing"] = missing_headers
if missing_headers:
    errors.append("Required baseline security headers are missing from _headers.")

checks["cloudflare_worker_entrypoint_configured"] = bool(re.search(r"(?m)^\s*main\s*=", wrangler))
checks["cloudflare_worker_name_is_placeholder"] = bool(re.search(r'(?m)^\s*name\s*=\s*["\']untitled["\']', wrangler))
checks["ai_assistant_backend_call_present"] = bool(re.search(r"fetch\s*\(", source))
checks["login_or_auth_backend_present"] = bool(re.search(r"\b(auth|authentication|login)\b", source, re.I) and re.search(r"fetch\s*\(", source))
checks["payment_backend_present"] = bool(re.search(r"\b(payment|checkout|webhook)\b", source, re.I) and re.search(r"fetch\s*\(", source))

if not checks["cloudflare_worker_entrypoint_configured"]:
    warnings.append("No Worker entry point is configured in wrangler.toml; no deployable AI Worker was found in this repository.")
if checks["cloudflare_worker_name_is_placeholder"]:
    warnings.append("wrangler.toml still uses the placeholder name 'untitled'; do not deploy this config as an AI Worker.")
if not checks["ai_assistant_backend_call_present"]:
    warnings.append("AI Assistant has no backend fetch call; it is currently a frontend placeholder.")
if not checks["login_or_auth_backend_present"]:
    warnings.append("No login/authentication backend integration was detected.")
if not checks["payment_backend_present"]:
    warnings.append("No payment/webhook backend integration was detected.")

report = {
    "audit": "CIVIL AI Backend and Security Baseline",
    "mode": "read-only static inspection",
    "status": "FAIL" if errors else ("PASS_WITH_WARNINGS" if warnings else "PASS"),
    "checks": checks,
    "errors": errors,
    "warnings": warnings,
    "limitations": [
        "Static source inspection only; not a penetration test.",
        "Does not test live Cloudflare settings, firewall rules, runtime behavior, account MFA, API provider quotas or secret-scanning settings.",
        "Does not prove absence of vulnerabilities."
    ]
}
print(json.dumps(report, indent=2))
sys.exit(1 if errors else 0)
