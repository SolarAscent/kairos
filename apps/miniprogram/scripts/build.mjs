import { readFile, readdir, mkdir, writeFile, copyFile, rm, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, relative, dirname } from "node:path";
import { build } from "esbuild";
import { validateConfig } from "./config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const chosen = process.env.MINIPROGRAM_CONFIG;
let raw;
try {
  raw = await readFile(chosen ? resolve(chosen) : resolve(root, "config.local.json"), "utf8");
} catch (error) {
  if (chosen || error.code !== "ENOENT") throw error;
  raw = await readFile(resolve(root, "config.example.json"), "utf8");
}
const config = validateConfig(JSON.parse(raw));
console.log(
  `Mini Program: ${config.environment}, ${config.loginMode}, ${config.appId === "touristappid" ? "AppID pending" : "AppID configured"}`,
);
if (process.argv.includes("--check")) process.exit(0);
const src = resolve(root, "src");
const destination = resolve(root, "dist");
// Build away from the watched project. Removing dist while DevTools is open
// invalidates its glass-easel compiler state and deletes private tool settings.
const out = await mkdtemp(resolve(tmpdir(), "kairos-miniprogram-"));
try {
  async function assets(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isDirectory()) await assets(path);
      else if (/\.(json|wxml|wxss|png)$/.test(item.name)) {
        const dest = resolve(out, relative(src, path));
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(path, dest);
      }
    }
  }
  await assets(src);
  const app = JSON.parse(await readFile(resolve(src, "app.json"), "utf8"));
  const common = {
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2020",
    minify: true,
    define: {
      __MINIPROGRAM_CONFIG__: JSON.stringify(config),
      "process.env.NODE_ENV": '"production"',
    },
    sourcemap: false,
  };
  // WeChat loads CommonJS modules; esbuild's automatic splitting requires ESM.
  // Publish shared dependencies once instead of copying them into every page.
  const shared = new Map([
    ["zod", "shared/zod.js"],
    ["@life/contracts", "shared/contracts.js"],
    ["mobx-miniprogram", "shared/mobx.js"],
  ]);
  function sharedImports(outfile, included) {
    return {
      name: "wechat-shared-dependencies",
      setup(builder) {
        builder.onResolve({ filter: /^(zod|@life\/contracts|mobx-miniprogram)$/ }, (args) => {
          if (args.path === included) return;
          const target = shared.get(args.path);
          let path = relative(dirname(outfile), resolve(out, target)).replaceAll("\\", "/");
          if (!path.startsWith(".")) path = "./" + path;
          return { path, external: true };
        });
      },
    };
  }
  for (const [dependency, path] of shared) {
    const outfile = resolve(out, path);
    await build({
      ...common,
      stdin: { contents: `export * from ${JSON.stringify(dependency)};`, resolveDir: root },
      outfile,
      plugins: [sharedImports(outfile, dependency)],
    });
  }
  for (const page of ["app", ...app.pages]) {
    const outfile = resolve(out, page + ".js");
    await build({
      ...common,
      entryPoints: [resolve(src, page + ".ts")],
      outfile,
      plugins: [sharedImports(outfile)],
    });
  }
  await writeFile(
    resolve(out, "project.config.json"),
    JSON.stringify(
      {
        description: "KAIROS 原生微信客户端",
        projectname: "kairos-" + config.environment,
        appid: config.appId,
        compileType: "miniprogram",
        miniprogramRoot: "./",
        libVersion: "3.7.1",
        setting: { es6: true, minified: true, urlCheck: true },
      },
      null,
      2,
    ) + "\n",
  );
  let packageBytes = 0;
  async function measure(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isDirectory()) await measure(path);
      else packageBytes += (await stat(path)).size;
    }
  }
  await measure(out);
  if (packageBytes > 2 * 1024 * 1024)
    throw new Error(`MINIPROGRAM_MAIN_PACKAGE_TOO_LARGE: ${packageBytes} bytes exceeds 2 MiB`);
  console.log(`Mini Program main package: ${Math.ceil(packageBytes / 1024)} KiB / 2048 KiB`);
  const generated = new Set();
  async function publish(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isDirectory()) await publish(path);
      else {
        const name = relative(out, path);
        generated.add(name);
        const target = resolve(destination, name);
        const content = await readFile(path);
        let previous;
        try {
          previous = await readFile(target);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        if (previous?.equals(content)) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
    }
  }
  await publish(out);
  async function prune(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, item.name);
      if (item.isDirectory()) await prune(path);
      else if (
        item.name !== "project.private.config.json" &&
        !generated.has(relative(destination, path))
      )
        await rm(path);
    }
  }
  await prune(destination);
} finally {
  await rm(out, { recursive: true, force: true });
}
console.log(
  "Import apps/miniprogram/dist in WeChat DevTools. Build output contains only public client configuration.",
);
