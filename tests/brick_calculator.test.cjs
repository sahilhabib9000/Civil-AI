const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const html = fs.readFileSync("index.html", "utf8");
const match = html.match(/<script>\s*(function brickCalculate\(\)[\s\S]*?)\s*<\/script>/);
assert.ok(match, "Brick calculator function must exist in index.html");

function run(values) {
  const elements = {};
  for (const [id, value] of Object.entries(values)) {
    elements[id] = { value: String(value), textContent: "", innerHTML: "", style: { display: "none" } };
  }
  for (const id of ["brickError", "brickResult", "brickOutput"]) {
    elements[id] ||= { value: "", textContent: "", innerHTML: "", style: { display: "none" } };
  }
  const document = { getElementById: (id) => elements[id] };
  const context = vm.createContext({ document, Math, Number });
  vm.runInContext(match[1], context);
  vm.runInContext("brickCalculate()", context);
  return elements;
}

const base = {
  brickLength: 3, brickHeight: 3, brickThickness: 0.23, brickUnit: "m",
  brickDoorCount: 0, brickDoorWidth: "", brickDoorHeight: "",
  brickWindowCount: 0, brickWindowWidth: "", brickWindowHeight: "",
  brickJoint: 10, brickWastage: 5
};

{
  const e = run(base);
  assert.equal(e.brickError.textContent, "");
  assert.match(e.brickOutput.textContent, /Gross Wall Volume:<\/strong> 2\.070 m³/);
  assert.match(e.brickOutput.textContent, /Net Wall Volume:<\/strong> 2\.070 m³/);
  assert.match(e.brickOutput.textContent, /Total Bricks Required: 1,087 pieces/);
}
{
  const e = run({ ...base, brickDoorCount: 1, brickDoorWidth: 0.9, brickDoorHeight: 2.1,
    brickWindowCount: 1, brickWindowWidth: 1.2, brickWindowHeight: 1.2 });
  assert.equal(e.brickError.textContent, "");
  assert.match(e.brickOutput.textContent, /Door Openings:<\/strong> 0\.435 m³/);
  assert.match(e.brickOutput.textContent, /Window Openings:<\/strong> 0\.331 m³/);
  assert.match(e.brickOutput.textContent, /Net Wall Volume:<\/strong> 1\.304 m³/);
}
{
  const e = run({ ...base, brickUnit: "ft", brickLength: 10, brickHeight: 10, brickThickness: 1 });
  assert.equal(e.brickError.textContent, "");
  assert.match(e.brickOutput.textContent, /Gross Wall Volume:<\/strong> 2\.832 m³/);
}
{
  const e = run({ ...base, brickDoorCount: 1, brickDoorWidth: 4, brickDoorHeight: 2 });
  assert.match(e.brickError.textContent, /fit within the wall/);
  assert.equal(e.brickResult.style.display, "none");
}
{
  const e = run({ ...base, brickWindowCount: 1.5, brickWindowWidth: 1, brickWindowHeight: 1 });
  assert.match(e.brickError.textContent, /whole non-negative opening counts/);
}
{
  const e = run({ ...base, brickDoorCount: 1, brickDoorWidth: 3, brickDoorHeight: 3 });
  assert.match(e.brickError.textContent, /smaller than the gross wall area/);
}
console.log("PASS: 6 brick calculator regression tests");
