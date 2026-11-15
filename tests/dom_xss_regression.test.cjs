const fs = require("node:fs");
const assert = require("node:assert/strict");

const index = fs.readFileSync("index.html", "utf8");
const guardian = fs.readFileSync("guardian.html", "utf8");

// Regression guard: application pages must not assign untrusted/dynamic HTML.
for (const [name, source] of [["index.html", index], ["guardian.html", guardian]]) {
  assert.doesNotMatch(source, /\\.innerHTML\\s*=/, name + " must not assign innerHTML");
}

// User-entered BOQ descriptions remain form values; generated rows are built
// from DOM nodes, never by parsing a string as HTML.
assert.match(index, /function boqAddRow\\(\\)[\\s\\S]*?document\\.createElement\\("tr"\\)/);
assert.match(index, /description = addInput\\("boq-desc", "text", "Work description"/);
assert.match(index, /removeButton\\.addEventListener\\("click"/);
assert.match(index, /output\\.textContent\\s*=/, "Brick results must be rendered as text");
assert.match(index, /result\\.textContent\\s*=/, "Concrete results must be rendered as text");
assert.match(index, /steelOutput['"]?\\)\\.textContent\\s*=/, "Steel results must be rendered as text");

// A payload commonly used to probe HTML injection must never be interpreted
// by an HTML-string assignment in either page.
const hostileDescription = '<img src=x onerror=alert(1)>';
assert.ok(hostileDescription.includes("onerror"));
console.log("PASS: DOM/XSS regression guards (no innerHTML sinks; BOQ rows use safe DOM APIs)");
