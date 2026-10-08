import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Script, runInContext, type Context } from "node:vm";

type NativeModule = { exports: unknown };
const contextCaches = new WeakMap<Context, Map<string, Map<string, NativeModule>>>();

/** Execute native CommonJS in its VM, sharing dependencies without exposing Node require. */
export function createNativeModuleLoader(
  context: Context,
  distRoot = resolve("apps/miniprogram/dist"),
) {
  const root = realpathSync(distRoot);
  let roots = contextCaches.get(context);
  if (!roots) contextCaches.set(context, (roots = new Map()));
  let modules = roots.get(root);
  if (!modules) roots.set(root, (modules = new Map()));
  const cache = modules;
  function assertInside(path: string) {
    const name = relative(root, path);
    if (name === ".." || name.startsWith(".." + sep) || isAbsolute(name))
      throw new Error("NATIVE_MODULE_OUTSIDE_DIST");
  }
  function modulePath(path: string) {
    const candidate = resolve(path);
    assertInside(candidate);
    const file = [candidate, candidate + ".js", resolve(candidate, "index.js")].find(
      (name) => existsSync(name) && statSync(name).isFile(),
    );
    if (!file) throw new Error("NATIVE_MODULE_NOT_FOUND: " + relative(root, candidate));
    const real = realpathSync(file);
    assertInside(real);
    if (!real.endsWith(".js")) throw new Error("NATIVE_MODULE_JS_REQUIRED");
    return real;
  }
  function load(filename: string): unknown {
    const cached = cache.get(filename);
    if (cached) return cached.exports;
    // Module and require live in the target realm, including its restricted Function.
    const module = runInContext("({ exports: {} })", context) as NativeModule;
    cache.set(filename, module);
    const bridge = (specifier: unknown) => {
      if (
        typeof specifier !== "string" ||
        !(specifier.startsWith("./") || specifier.startsWith("../"))
      )
        throw new Error("NATIVE_REQUIRE_RELATIVE_ONLY");
      return load(modulePath(resolve(dirname(filename), specifier)));
    };
    const nativeRequire = runInContext(
      "(function(bridge) { return function require(path) { return bridge(path); }; })",
      context,
    )(bridge);
    try {
      const wrapper = new Script(
        "(function(require, module, exports, __filename, __dirname) {\n" +
          readFileSync(filename, "utf8") +
          "\n})",
        { filename },
      ).runInContext(context);
      wrapper(nativeRequire, module, module.exports, filename, dirname(filename));
      return module.exports;
    } catch (error) {
      if (cache.get(filename) === module) cache.delete(filename);
      throw error;
    }
  }
  return {
    requireModule(entry: string) {
      return load(modulePath(resolve(root, entry)));
    },
    runEntry(entry: string) {
      const filename = modulePath(resolve(root, entry));
      // Register each requested Page again while keeping shared module singletons.
      cache.delete(filename);
      return load(filename);
    },
  };
}
