#!/usr/bin/env python3
"""Read-only CIVIL AI static platform audit. No files are modified."""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
import json
import re
import sys

FILES = ("index.html", "guardian.html")


class AuditParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.fragments = []
        self.local_links = []
        self.labels_for = set()
        self.inputs = []
        self.images_without_alt = 0
        self.anchors_without_href = 0
        self.buttons_without_label = 0
        self.external_blank_without_rel = 0
        self.inline_handlers = 0
        self.script_parts = []
        self._script_depth = 0
        self._label_depth = 0
        self._button_depth = 0
        self._button_label = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        element_id = attrs.get("id")
        if element_id:
            self.ids.append(element_id)

        if tag == "a":
            href = (attrs.get("href") or "").strip()
            if not href:
                self.anchors_without_href += 1
            else:
                parsed = urlsplit(href)
                if not parsed.scheme and not parsed.netloc:
                    if parsed.fragment:
                        self.fragments.append(parsed.fragment)
                    if parsed.path:
                        self.local_links.append(parsed.path)
            if attrs.get("target") == "_blank":
                rel = set((attrs.get("rel") or "").lower().split())
                if not {"noopener", "noreferrer"}.intersection(rel):
                    self.external_blank_without_rel += 1

        if tag == "img" and not (attrs.get("alt") or "").strip():
            self.images_without_alt += 1

        if tag in ("input", "select", "textarea"):
            if attrs.get("type", "").lower() != "hidden":
                self.inputs.append({
                    "id": element_id,
                    "type": tag,
                    "aria_label": (attrs.get("aria-label") or "").strip(),
                    "aria_labelledby": (attrs.get("aria-labelledby") or "").strip(),
                })

        if tag == "label" and attrs.get("for"):
            self.labels_for.add(attrs["for"])

        if tag == "button":
            self._button_depth += 1
            self._button_label = (attrs.get("aria-label") or "").strip()

        if tag == "script":
            self._script_depth += 1

        self.inline_handlers += sum(1 for key in attrs if key.lower().startswith("on"))

    def handle_data(self, data):
        if self._script_depth:
            self.script_parts.append(data)
        if self._button_depth:
            self._button_label += data.strip()
            
    def handle_endtag(self, tag):
        if tag == "button" and self._button_depth:
            if not self._button_label.strip():
                self.buttons_without_label += 1
            self._button_depth -= 1
            self._button_label = ""
        if tag == "script" and self._script_depth:
            self._script_depth -= 1


def audit(path):
    parser = AuditParser()
    source = path.read_text(encoding="utf-8")
    parser.feed(source)
    counts = Counter(parser.ids)
    duplicates = sorted(k for k, v in counts.items() if v > 1)
    missing_fragments = sorted(set(parser.fragments) - set(parser.ids))

    missing_local_files = []
    for link in sorted(set(parser.local_links)):
        target = (path.parent / link).resolve()
        if not target.is_file():
            missing_local_files.append(link)

    missing_js_ids = set()
    script_text = "\n".join(parser.script_parts)
    for match in re.finditer(
        r"""(?:getElementById\s*\(\s*['"]([^'"]+)['"]\s*\)|querySelector(?:All)?\s*\(\s*['"]#([A-Za-z][\w:-]*)['"]\s*\))""",
        script_text,
    ):
        referenced_id = match.group(1) or match.group(2)
        if referenced_id not in counts:
            missing_js_ids.add(referenced_id)

    missing_labels = sorted(
        item["id"] for item in parser.inputs
        if item["id"]
        and item["id"] not in parser.labels_for
        and not item.get("aria_label")
        and not item.get("aria_labelledby")
    )
    unlabeled_inputs = sum(
        1 for item in parser.inputs
        if not item["id"] and not item.get("aria_label") and not item.get("aria_labelledby")
    )

    errors = []
    warnings = []
    if duplicates:
        errors.append("Duplicate HTML IDs: " + ", ".join(duplicates))
    if missing_fragments:
        errors.append("Broken internal links: " + ", ".join(missing_fragments))
    if missing_local_files:
        errors.append("Missing local linked files: " + ", ".join(missing_local_files))
    if missing_js_ids:
        errors.append("JavaScript references missing element IDs: " + ", ".join(sorted(missing_js_ids)))

    if parser.anchors_without_href:
        warnings.append(f"{parser.anchors_without_href} anchor(s) without href")
    if parser.buttons_without_label:
        warnings.append(f"{parser.buttons_without_label} button(s) without accessible text or aria-label")
    if parser.images_without_alt:
        warnings.append(f"{parser.images_without_alt} image(s) without alt text")
    if missing_labels or unlabeled_inputs:
        warnings.append(
            f"{len(missing_labels) + unlabeled_inputs} form control(s) without an associated label"
        )
    if parser.external_blank_without_rel:
        warnings.append(
            f"{parser.external_blank_without_rel} target=_blank link(s) missing noopener/noreferrer"
        )

    return {
        "file": str(path),
        "checks": {
            "duplicate_ids": duplicates,
            "broken_internal_links": missing_fragments,
            "missing_local_files": missing_local_files,
            "javascript_missing_element_ids": sorted(missing_js_ids),
        },
        "warnings": warnings,
        "counts": {
            "anchors_without_href": parser.anchors_without_href,
            "buttons_without_accessible_label": parser.buttons_without_label,
            "images_without_alt": parser.images_without_alt,
            "form_controls_without_label": len(missing_labels) + unlabeled_inputs,
            "external_blank_links_missing_rel": parser.external_blank_without_rel,
            "inline_event_handlers": parser.inline_handlers,
        },
        "errors": errors,
    }


results = []
errors = []
warnings = []
for name in FILES:
    path = Path(name)
    if not path.is_file():
        errors.append(f"Missing required file: {name}")
        continue
    result = audit(path)
    results.append(result)
    errors.extend(f"{name}: {item}" for item in result["errors"])
    warnings.extend(f"{name}: {item}" for item in result["warnings"])

report = {
    "status": "FAIL" if errors else ("PASS_WITH_WARNINGS" if warnings else "PASS"),
    "scope": [
        "HTML structure and duplicate IDs",
        "internal fragment and local-file links",
        "static JavaScript references to element IDs",
        "basic accessibility indicators",
        "external target=_blank link safety indicators",
    ],
    "files": results,
    "errors": errors,
    "warnings": warnings,
    "limitations": [
        "This is a static source audit, not a live browser test.",
        "It does not verify calculator engineering formulas, API/backend behavior, authentication, payment processing, or firewall effectiveness.",
        "Warnings require manual review and may include context-dependent cases.",
    ],
}
print(json.dumps(report, indent=2))
sys.exit(1 if errors else 0)
