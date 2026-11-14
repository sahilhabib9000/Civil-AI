#!/usr/bin/env python3
"""Read-only CIVIL AI static-site audit. No files are modified."""
from html.parser import HTMLParser
from pathlib import Path
from collections import Counter
import json
import sys

FILES = ("index.html", "guardian.html")

class AuditParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.fragments = []
        self.empty_links = 0
        self.buttons = 0
        self.empty_buttons = 0
        self._button_depth = 0
        self._button_text = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.append(attrs["id"])
        href = attrs.get("href", "")
        if href.startswith("#") and len(href) > 1:
            self.fragments.append(href[1:])
        if tag == "a" and not href:
            self.empty_links += 1
        if tag == "button":
            self.buttons += 1
            self._button_depth += 1
            self._button_text = ""

    def handle_data(self, data):
        if self._button_depth:
            self._button_text += data.strip()

    def handle_endtag(self, tag):
        if tag == "button" and self._button_depth:
            if not self._button_text.strip():
                self.empty_buttons += 1
            self._button_depth -= 1

def audit(path):
    parser = AuditParser()
    parser.feed(path.read_text(encoding="utf-8"))
    counts = Counter(parser.ids)
    duplicates = sorted(k for k, v in counts.items() if v > 1)
    missing = sorted(set(parser.fragments) - set(parser.ids))
    return {
        "file": str(path),
        "duplicate_ids": duplicates,
        "broken_internal_links": missing,
        "anchors_without_href": parser.empty_links,
        "buttons_without_text": parser.empty_buttons,
    }

results = []
errors = []
for name in FILES:
    path = Path(name)
    if not path.is_file():
        errors.append(f"Missing required file: {name}")
        continue
    result = audit(path)
    results.append(result)
    if result["duplicate_ids"]:
        errors.append(f"{name}: duplicate IDs: {', '.join(result['duplicate_ids'])}")
    if result["broken_internal_links"]:
        errors.append(f"{name}: broken internal links: {', '.join(result['broken_internal_links'])}")

print(json.dumps({"status": "FAIL" if errors else "PASS", "files": results, "errors": errors}, indent=2))
sys.exit(1 if errors else 0)
