import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeModuleLoader } from "../helpers/native-module-loader";

const temporary: string[] = [];
function fixture(files: Record<string, string>, sandbox: Record<string, unknown> = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), "native-loader-test-"));
  temporary.push(dir);
  const root = resolve(dir, "dist");
  mkdirSync(root);
  for (const [name, text] of Object.entries(files)) {
    const path = resolve(root, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  return { root, dir, context, loader: createNativeModuleLoader(context, root) };
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("native CommonJS module loader", () => {
  it("shares one dependency across relative paths, entry reloads and loaders in the same VM", () => {
    const { loader, root, context } = fixture({
      "shared/store.js":
        "globalThis.loads = (globalThis.loads || 0) + 1; module.exports = { count: 0 };",
      "app.js": "module.exports = require('./shared/store');",
      "pages/home/index.js": "module.exports = require('../../shared/./store.js');",
    });
    const app = loader.runEntry("app.js") as { count: number };
    app.count = 9;
    expect(loader.runEntry("pages/home/index.js")).toBe(app);
    expect(loader.runEntry("pages/home/index.js")).toBe(app);
    expect(createNativeModuleLoader(context, root).requireModule("shared/store.js")).toBe(app);
    expect(runInContext("loads", context)).toBe(1);
    expect(runInContext("typeof process + ':' + typeof Buffer", context)).toBe(
      "undefined:undefined",
    );
  });
  it("enforces the dist boundary for traversal, absolute requires and symlinks", () => {
    const { loader, root, dir, context } = fixture({
      "traversal.js": "require('../outside.js');",
      "absolute.js": "require('/outside.js');",
      "node.js": "require('node:fs');",
      "symlink.js": "require('./escape.js');",
    });
    const outside = resolve(dir, "outside.js");
    writeFileSync(outside, "globalThis.escaped = true;");
    symlinkSync(outside, resolve(root, "escape.js"));
    expect(() => loader.runEntry("traversal.js")).toThrow("NATIVE_MODULE_OUTSIDE_DIST");
    expect(() => loader.runEntry("absolute.js")).toThrow("NATIVE_REQUIRE_RELATIVE_ONLY");
    expect(() => loader.runEntry("node.js")).toThrow("NATIVE_REQUIRE_RELATIVE_ONLY");
    expect(() => loader.runEntry("symlink.js")).toThrow("NATIVE_MODULE_OUTSIDE_DIST");
    expect(() => loader.runEntry(outside)).toThrow("NATIVE_MODULE_OUTSIDE_DIST");
    expect(runInContext("typeof escaped", context)).toBe("undefined");
  });
  it("supports restricted Function without using it to load wrappers and keeps require in that realm", () => {
    const { loader, context } = fixture(
      {
        "shared/value.js":
          "module.exports = { nativeFunctionType: typeof Function('return 1'), globals: typeof process };",
        "app.js":
          "module.exports = { shared: require('./shared/value.js'), requireConstructor: require.constructor };",
      },
      {
        Function: function () {
          return {};
        },
      },
    );
    const app = loader.runEntry("app.js") as any;
    expect(app.shared.nativeFunctionType).toBe("object");
    expect(app.shared.globals).toBe("undefined");
    // The bridge must not expose a host Function constructor through native require.
    expect(() => app.requireConstructor("return process")()).toThrow();
    expect(runInContext("typeof Function('return 1')", context)).toBe("object");
  });
  it("pre-caches modules for cycles and discards failed modules so retries can succeed", () => {
    const { loader, context } = fixture({
      "a.js": "exports.name='a'; exports.other=require('./b.js').name;",
      "b.js": "exports.name='b'; exports.other=require('./a.js').name;",
      "retry.js":
        "if (!globalThis.retryReady) throw new Error('not-ready'); module.exports={ready:true};",
    });
    expect(loader.requireModule("a.js")).toEqual({ name: "a", other: "b" });
    expect(loader.requireModule("b.js")).toEqual({ name: "b", other: "a" });
    expect(() => loader.requireModule("retry.js")).toThrow("not-ready");
    context.retryReady = true;
    expect(loader.requireModule("retry.js")).toEqual({ ready: true });
  });
});
