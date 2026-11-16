const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const html = fs.readFileSync("index.html", "utf8");

function extractFunction(name, nextName) {
  const start = html.indexOf("function " + name + "(");
  assert.notEqual(start, -1, name + " must exist in index.html");
  const end = nextName
    ? html.indexOf("function " + nextName + "(", start)
    : html.indexOf("</script>", start);
  assert.notEqual(end, -1, "Could not find end of " + name);
  return html.slice(start, end).trim();
}

function makeElements(values) {
  const elements = {};
  for (const [id, value] of Object.entries(values)) {
    elements[id] = {
      value: String(value),
      textContent: "",
      innerText: "",
      style: { display: "none", whiteSpace: "" }
    };
  }
  return elements;
}

function runSimple(fn, values, callName) {
  const elements = makeElements(values);
  const document = { getElementById: id => elements[id] };
  const context = vm.createContext({ document, Math, Number });
  vm.runInContext(fn, context);
  vm.runInContext(callName + "()", context);
  return elements;
}

const concreteFn = extractFunction("ccCalculate");
{
  const e = runSimple(concreteFn, {
    "cc-unit": "m", "cc-factor": 1.54, "cc-ratio": "1,2,4",
    "cc-length": 1, "cc-width": 1, "cc-height": 1, "cc-result": ""
  }, "ccCalculate");
  assert.match(e["cc-result"].textContent, /Wet Concrete Volume: 1\.000 m³/);
  assert.match(e["cc-result"].textContent, /Dry Volume: 1\.540 m³/);
  assert.match(e["cc-result"].textContent, /Estimated Cement: 6\.34 bags/);
}
{
  const e = runSimple(concreteFn, {
    "cc-unit": "ft", "cc-factor": 1.54, "cc-ratio": "1,2,4",
    "cc-length": 10, "cc-width": 10, "cc-height": 1, "cc-result": ""
  }, "ccCalculate");
  assert.match(e["cc-result"].textContent, /Wet Concrete Volume: 2\.832 m³/);
}
{
  const e = runSimple(concreteFn, {
    "cc-unit": "m", "cc-factor": 2.5, "cc-ratio": "1,2,4",
    "cc-length": 1, "cc-width": 1, "cc-height": 1, "cc-result": ""
  }, "ccCalculate");
  assert.match(e["cc-result"].textContent, /Please enter valid positive dimensions and factor/);
}

const steelFn = extractFunction("steelCalculate");
{
  const e = runSimple(steelFn, {
    steelDiameter: 12, steelLength: 12, steelUnit: "m", steelBars: 10,
    steelResult: "", steelError: "", steelOutput: ""
  }, "steelCalculate");
  assert.match(e.steelOutput.textContent, /Total Steel Weight: 106\.54 kg/);
  assert.equal(e.steelResult.style.display, "block");
}
{
  const e = runSimple(steelFn, {
    steelDiameter: 12, steelLength: -1, steelUnit: "m", steelBars: 10,
    steelResult: "", steelError: "", steelOutput: ""
  }, "steelCalculate");
  assert.match(e.steelError.innerText, /positive length/);
  assert.equal(e.steelResult.style.display, "none");
}
{
  const e = runSimple(steelFn, {
    steelDiameter: 12, steelLength: 10, steelUnit: "ft", steelBars: 2,
    steelResult: "", steelError: "", steelOutput: ""
  }, "steelCalculate");
  assert.match(e.steelOutput.textContent, /Total Steel Weight: 5\.41 kg/);
}

const boqFn = extractFunction("boqCalculate", "boqPrint");
const boqPrintStart = html.indexOf("function boqPrint()");
const boqPrintEnd = html.indexOf("document.addEventListener", boqPrintStart);
assert.notEqual(boqPrintStart, -1, "boqPrint must exist in index.html");
assert.notEqual(boqPrintEnd, -1, "Could not find end of boqPrint");
const boqPrintFn = html.slice(boqPrintStart, boqPrintEnd).trim();
function runBoq({ qty, rate, gst, print = false }) {
  const alerts = [];
  const printCalls = [];
  const row = {
    querySelector(selector) {
      if (selector === ".boq-qty") return { value: String(qty) };
      if (selector === ".boq-rate") return { value: String(rate) };
      if (selector === ".boq-amount") return { textContent: "" };
      return null;
    }
  };
  const elements = {
    boqGst: { value: String(gst) },
    boqSubtotal: { textContent: "" },
    boqTax: { textContent: "" },
    boqGrandTotal: { textContent: "" }
  };
  const document = {
    getElementById: id => elements[id],
    querySelectorAll: selector => selector === "#boqRows tr" ? [row] : []
  };
  const context = vm.createContext({
    document, Number, alert: message => alerts.push(message),
    window: { print: () => printCalls.push("printed") }
  });
  vm.runInContext(boqFn + "\\n" + boqPrintFn, context);
  const calculationResult = vm.runInContext(print ? "boqPrint()" : "boqCalculate()", context);
  return { elements, alerts, printCalls, calculationResult };
}
{
  const { elements, alerts, calculationResult } = runBoq({ qty: 10, rate: 500, gst: 18 });
  assert.deepEqual(alerts, []);
  assert.equal(calculationResult, true);
  assert.equal(elements.boqSubtotal.textContent, "₹5000.00");
  assert.equal(elements.boqTax.textContent, "₹900.00");
  assert.equal(elements.boqGrandTotal.textContent, "₹5900.00");
}
{
  const { elements, alerts, calculationResult } = runBoq({ qty: -1, rate: 500, gst: 18 });
  assert.match(alerts[0], /non-negative numbers/);
  assert.equal(calculationResult, false);
  assert.equal(elements.boqGrandTotal.textContent, "");
}
{
  const { elements, alerts, calculationResult } = runBoq({ qty: 10, rate: 500, gst: 101 });
  assert.match(alerts[0], /tax percentage between 0 and 100/);
  assert.equal(calculationResult, false);
  assert.equal(elements.boqGrandTotal.textContent, "");
}

{
  const { printCalls, calculationResult } = runBoq({ qty: 10, rate: 500, gst: 18, print: true });
  assert.equal(calculationResult, true);
  assert.deepEqual(printCalls, ["printed"]);
}
{
  const { alerts, printCalls, calculationResult } = runBoq({ qty: -1, rate: 500, gst: 18, print: true });
  assert.equal(calculationResult, false);
  assert.match(alerts[0], /non-negative numbers/);
  assert.deepEqual(printCalls, [], "Invalid BOQ must never open the print dialog");
}
console.log("PASS: 11 concrete, steel and BOQ regression scenarios");
