import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";

test("Feishu console inline JavaScript parses", async () => {
  const html = await readFile(new URL("../../web/feishu.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(scripts.length > 0, "console page should contain an inline script");
  scripts.forEach((source, index) => {
    assert.doesNotThrow(() => new Script(source, { filename: "feishu.html:inline-" + (index + 1) }));
  });
});
