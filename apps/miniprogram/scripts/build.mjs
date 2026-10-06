import { readFile, readdir, mkdir, writeFile, copyFile, rm, mkdtemp } from "node:fs/promises";
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
  await build({
    entryPoints: [resolve(src, "app.ts"), ...app.pages.map((page) => resolve(src, page + ".ts"))],
    outbase: src,
    outdir: out,
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
  });
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
