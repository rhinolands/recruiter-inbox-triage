// Checks the published workflow: its shape, its placeholders, and the
// code inside the two decision nodes. Run with: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wf = JSON.parse(
  readFileSync(new URL("../workflow.sanitized.json", import.meta.url), "utf8"),
);
const node = (name) => wf.nodes.find((n) => n.name === name);

// Run an n8n Code node body with stand-ins for $input and $().
function runCode(name, items, refs = {}) {
  const fn = new Function("$input", "$", node(name).parameters.jsCode);
  const $input = { all: () => items, first: () => items[0] };
  const $ = (ref) => ({ item: { json: refs[ref] } });
  return fn($input, $);
}

const triage = (email) => runCode("Triage rules", [{ json: email }])[0].json;
const applyLlm = (rule, answer) =>
  runCode("Apply LLM", [{ json: { content: answer } }], {
    "Triage rules": rule,
  })[0].json;

test("every connection points at a node that exists", () => {
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, out] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), from);
    for (const branch of out.main)
      for (const edge of branch) assert.ok(names.has(edge.node), edge.node);
  }
});

test("router sends each bucket to its own connected branch", () => {
  const out = wf.connections["Route by bucket"].main;
  assert.equal(out.length, 3);
  assert.match(node("Route by bucket").parameters.output, /ALERT:0,LOG:1,IGNORE:2/);
  for (const branch of out) assert.ok(branch.length > 0);
});

test("credentials and ids are placeholders, tokens come from env", () => {
  for (const n of wf.nodes)
    for (const c of Object.values(n.credentials || {}))
      assert.match(c.id, /^<[A-Z_]+>$/, n.name);
  const raw = JSON.stringify(wf);
  assert.match(raw, /\$env\.TELEGRAM_BOT_TOKEN/);
  assert.match(raw, /\$env\.NOTION_TOKEN/);
  assert.doesNotMatch(raw, /bot\d{6,}:/); // no literal Telegram bot token
  assert.doesNotMatch(raw, /secret_[A-Za-z0-9]{20,}|ntn_[A-Za-z0-9]{20,}/);
});

test("rules: ATS sender is ALERT", () => {
  const r = triage({ from: "jobs@greenhouse.io", subject: "Next steps", snippet: "" });
  assert.equal(r.bucket, "ALERT");
});

test("rules: LinkedIn job digest is IGNORE", () => {
  const r = triage({
    from: "jobalerts-noreply@linkedin.com",
    subject: "24 new jobs match your preferences",
  });
  assert.equal(r.bucket, "IGNORE");
});

test("rules: newsletter with no job signal is IGNORE", () => {
  const r = triage({ from: "news@example.org", subject: "Weekly newsletter" });
  assert.equal(r.bucket, "IGNORE");
});

test("rules: Hebrew job keyword is LOG and goes to the model", () => {
  const r = triage({ from: "a@example.org", subject: "משרה חדשה" });
  assert.equal(r.bucket, "LOG");
  assert.equal(r.needsLLM, true);
});

test("model cannot drop an ATS ALERT", () => {
  const rule = triage({ from: "jobs@lever.co", subject: "Interview" });
  assert.equal(applyLlm(rule, "IGNORE").bucket, "ALERT");
  assert.equal(applyLlm(rule, "LOG").bucket, "ALERT");
});

test("model cannot drop a LOG to IGNORE", () => {
  const rule = triage({ from: "a@example.org", subject: "An opportunity" });
  assert.equal(applyLlm(rule, "IGNORE").bucket, "LOG");
});

test("model can raise LOG to ALERT", () => {
  const rule = triage({ from: "a@example.org", subject: "Interview invite" });
  const r = applyLlm(rule, "ALERT");
  assert.equal(r.bucket, "ALERT");
  assert.equal(r.refinedBy, "llm");
});

test("unreadable model answer keeps the rule bucket", () => {
  const rule = triage({ from: "a@example.org", subject: "An opportunity" });
  const r = applyLlm(rule, "");
  assert.equal(r.bucket, "LOG");
  assert.equal(r.refinedBy, "rules");
});
