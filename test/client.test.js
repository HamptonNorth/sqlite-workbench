// The client bundle must EVALUATE, not merely build.
//
// A Lit `css` template only accepts CSSResult/number values; interpolating a
// plain string throws at module-evaluation time, so the component never
// registers and the page renders blank with nothing useful in the console.
// `bun build` succeeds regardless — it bundles, it doesn't run. This test runs
// the module against a real DOM so that class of mistake fails here instead.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Window } from "happy-dom";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let restore = [];

beforeAll(() => {
  const window = new Window({ url: "http://localhost:9999" });
  // Lit reads Document.prototype/CSSStyleSheet.prototype at module scope, so the
  // constructors have to be present too, not just the instances.
  for (const key of ["window", "document", "Document", "HTMLElement", "customElements",
                     "CSSStyleSheet", "sessionStorage", "Element", "ShadowRoot",
                     "Node", "NodeFilter", "navigator", "fetch", "Blob", "URL"]) {
    restore.push([key, globalThis[key]]);
    globalThis[key] = window[key];
  }
});

afterAll(() => {
  for (const [key, value] of restore) globalThis[key] = value;
});

test("the client module evaluates and registers <sqlite-workbench>", async () => {
  const built = await Bun.build({ entrypoints: [join(ROOT, "src/client/workbench.js")], target: "browser" });
  expect(built.success).toBe(true);

  const code = await built.outputs[0].text();
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  await import(url); // throws if a css`` interpolation is a bare string, etc.

  expect(customElements.get("sqlite-workbench")).toBeDefined();
});
