import assert from "node:assert/strict";
import { test } from "node:test";

import { parseIni } from "../src/config.js";

test("parses sections and keys into flat section.key map", () => {
  const parsed = parseIni("[memory]\ndb = memory.db\ninbox = ./inbox\n");
  assert.equal(parsed["memory.db"], "memory.db");
  assert.equal(parsed["memory.inbox"], "./inbox");
});

test("ignores comments and blank lines", () => {
  const parsed = parseIni("; comment\n# other comment\n\n[memory]\n; note\ndb = x.db\n");
  assert.deepEqual(parsed, { "memory.db": "x.db" });
});

test("is case-insensitive for sections and keys", () => {
  const parsed = parseIni("[Memory]\nDB = x.db\n");
  assert.equal(parsed["memory.db"], "x.db");
});

test("strips matching quotes from values", () => {
  const parsed = parseIni('[memory]\ndb = "path; with special #chars.db"\ninbox = \'./in\'\n');
  assert.equal(parsed["memory.db"], "path; with special #chars.db");
  assert.equal(parsed["memory.inbox"], "./in");
});

test("keeps '=' inside values and trims whitespace", () => {
  const parsed = parseIni("[s]\nkey =  a=b  \n");
  assert.equal(parsed["s.key"], "a=b");
});

test("ignores malformed lines and supports sectionless keys", () => {
  const parsed = parseIni("top = 1\nnot-a-kv-line\n[s]\nk = v\n");
  assert.equal(parsed.top, "1");
  assert.equal(parsed["s.k"], "v");
  assert.equal(Object.keys(parsed).length, 2);
});
