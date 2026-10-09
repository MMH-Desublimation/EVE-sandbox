/**
 * 开发宿主（仅开发期）。
 *
 * 做三件事，零依赖：
 *   1. 静态服务：把项目目录当站点；`.ts` 文件用 Node 内置的 stripTypeScriptTypes
 *      即时转成 JS 下发（浏览器直接跑 TS 源码，无需打包器）。
 *   2. `/oracle` 端点：转发到常驻的 Python StatOracle 子进程（JSON 行协议）。
 *   3. 控制台打印访问地址。
 *
 * 生产环境由 WebView2 宿主 + C# 桥承担同样职责（见 src/ui/bridge.ts）。
 *
 * 用法： node tools/dev-host.ts [--port 5178] [--units 200]
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { stripTypeScriptTypes } from "node:module";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "5178"));
const PY = process.env.PYFA_PYTHON ??
  String.raw`C:\Users\admin\AppData\Local\Python\pythoncore-3.14-64\python.exe`;
const PYFA_DIR = process.env.PYFA_DIR ?? String.raw`D:\eve  pyfa\pyfa`;
const WORK_DIR = process.env.PYFA_WORK_DIR ?? join(ROOT, ".pyfa-core");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ------------------------------------------------------------------ oracle */

let oracle: ChildProcessWithoutNullStreams | null = null;
let oracleReady: Promise<string> | null = null;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;

function startOracle(): Promise<string> {
  if (oracleReady) return oracleReady;
  oracleReady = new Promise<string>((resolveReady, rejectReady) => {
    console.log(`[dev-host] 启动 StatOracle：${PY} sidecar/pyfa_oracle.py`);
    const proc = spawn(PY, [
      join(ROOT, "sidecar", "pyfa_oracle.py"),
      "--pyfa-dir", PYFA_DIR,
      "--work-dir", WORK_DIR,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
    });
    oracle = proc;

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line: string) => {
      const text = line.trim();
      if (!text) return;
      let msg: { id?: number | null; ready?: boolean; pyfaVersion?: string };
      try {
        msg = JSON.parse(text);
      } catch {
        console.warn("[oracle] 非法 JSON:", text.slice(0, 160));
        return;
      }
      if (msg.ready) {
        resolveReady(msg.pyfaVersion ?? "unknown");
        return;
      }
      if (msg.id == null) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.resolve(msg);
    });
    const errRl = createInterface({ input: proc.stderr });
    errRl.on("line", (l: string) => console.log("[oracle]", l));

    proc.on("exit", (code) => {
      console.error(`[dev-host] StatOracle 退出 code=${code}`);
      oracle = null;
      oracleReady = null;
      for (const [, p] of pending) p.reject(new Error("oracle 已退出"));
      pending.clear();
    });
    proc.on("error", rejectReady);
  });
  return oracleReady;
}

function askOracle(payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolveCall, rejectCall) => {
    if (!oracle) {
      rejectCall(new Error("oracle 未启动"));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve: resolveCall, reject: rejectCall });
    oracle.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
  });
}

/* ------------------------------------------------------------------ server */

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function serveStatic(urlPath: string, res: ServerResponse): Promise<void> {
  const rel = decodeURIComponent(urlPath.split("?")[0]);
  const abs = normalize(join(ROOT, rel || "/"));
  if (!abs.startsWith(ROOT) || !existsSync(abs)) {
    res.writeHead(404).end("404 " + rel);
    return;
  }
  const ext = extname(abs);
  const raw = await readFile(abs, "utf8");
  let body = raw;
  if (ext === ".ts") {
    body = stripTypeScriptTypes(raw, { mode: "strip" });
  }
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  console.log(`[http] ${req.method} ${req.url}`);
  try {
    if (req.method === "POST" && req.url?.startsWith("/oracle")) {
      const body = await readBody(req);
      const payload = JSON.parse(body) as Record<string, unknown>;
      const reply = await askOracle(payload);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(reply));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/healthz")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, oracle: Boolean(oracle) }));
      return;
    }
    // 根路径重定向到 UI 入口：这样页面里的相对说明符（./main.ts）才会解析到 /src/ui/
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "") {
      res.writeHead(302, { Location: "/src/ui/index.html" });
      res.end();
      return;
    }
    await serveStatic(req.url ?? "/", res);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(String((err as Error).stack ?? err));
  }
});

const version = await startOracle();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dev-host] PYFA ${version} 就绪`);
  console.log(`[dev-host] 打开 http://127.0.0.1:${PORT}/`);
});
