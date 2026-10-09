/**
 * UI 构建步骤（阶段 4）。
 *
 * 零依赖：用 Node 内置的 `stripTypeScriptTypes` 做类型擦除，不能用打包器。
 * 产物：dist/ui/
 *   ├── index.html       （引用 ./src/ui/main.js）
 *   ├── app.css
 *   └── src/**           （保持 src/ 目录结构，导入说明符 .ts → .js）
 *
 * 之所以保持目录结构：源码里的相对导入（`../core/sim.ts`）在擦除后原样保留为
 * `../core/sim.js`，只要结构与 src/ 一致就一定解析得到，无需做依赖图分析。
 *
 * 用法： node tools/build-ui.ts [--out dist/ui]
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(ROOT, arg("out", "dist/ui"));
const SRC = join(ROOT, "src");

/** 递归收集文件。 */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** 把模块说明符里的 `.ts` 改成 `.js`（含 import / export / 动态 import / new URL）。 */
function rewriteSpecifiers(code: string): string {
  return code.replace(/(["'`])([^"'`\s]+)\.ts\1/g, "$1$2.js$1");
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const files = await walk(SRC);
  let n = 0;
  for (const abs of files) {
    const rel = relative(SRC, abs);
    const ext = extname(abs);
    // .ts → .js（保持目录结构，使相对导入在擦除后依然有效）
    const destRel = ext === ".ts" ? rel.slice(0, -ext.length) + ".js" : rel;
    const dest = join(OUT, "src", destRel);
    await mkdir(dirname(dest), { recursive: true });

    if (ext === ".ts") {
      const raw = await readFile(abs, "utf8");
      let js: string;
      try {
        js = stripTypeScriptTypes(raw, { mode: "strip" });
      } catch (err) {
        throw new Error(`类型擦除失败 ${rel}: ${(err as Error).message}`);
      }
      await writeFile(dest, rewriteSpecifiers(js), "utf8");
      n++;
    } else if (ext === ".css" || ext === ".html" || ext === ".json") {
      await writeFile(dest, await readFile(abs), undefined);
    } else {
      // 其它静态资源（舰船线稿 PNG 等）原样拷贝，保持目录结构
      await writeFile(dest, await readFile(abs), undefined);
    }
  }

  // 入口页与样式放在 dist/ui 根，并修正入口引用
  const html = await readFile(join(SRC, "ui", "index.html"), "utf8");
  const fixed = html
    .replace(/(["'])\.\/main\.ts\1/g, "$1./src/ui/main.js$1")
    .replace(/(["'])\.\/app\.css\1/g, "$1./app.css$1");
  await writeFile(join(OUT, "index.html"), fixed, "utf8");
  await writeFile(join(OUT, "app.css"), await readFile(join(SRC, "ui", "app.css")), undefined);

  // 完整性检查：入口与 worker 必须存在
  for (const need of ["index.html", "app.css", "src/ui/main.js", "src/ui/worker/sim.worker.js"]) {
    try {
      await readFile(join(OUT, need));
    } catch {
      throw new Error(`产物缺失：${need}`);
    }
  }

  console.log(`[build-ui] ${n} 个 .ts → ${relative(ROOT, OUT)}`);
  console.log("[build-ui] 入口：src/ui/main.js，Worker：src/ui/worker/sim.worker.js");
}

main().catch((err) => {
  console.error("[build-ui]", err);
  process.exit(1);
});
