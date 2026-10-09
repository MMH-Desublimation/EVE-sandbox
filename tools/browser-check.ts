/**
 * 真实浏览器验收（阶段 3，对照 §10.4）。
 *
 * 零依赖：用 Chrome 的 DevTools Protocol（CDP）驱动一个无头实例，
 * 打开页面、采集控制台异常、读取页面诊断区（帧率 / 单位数 / 帧间隔 P95），
 * 并可选地在页面上执行点击/按键等交互。
 *
 * 用法：
 *   node tools/browser-check.ts [--url http://127.0.0.1:5178/src/ui/index.html]
 *                               [--port 9333] [--seconds 25]
 *                               [--eval "表达式"]...
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const URL_ = arg("url", "http://127.0.0.1:5178/src/ui/index.html");
const PORT = Number(arg("port", "9333"));
const SECONDS = Number(arg("seconds", "25"));
const EVALS: string[] = [];
for (let i = 0; i < process.argv.length - 1; i++) {
  if (process.argv[i] === "--eval") EVALS.push(process.argv[i + 1]);
}

const CHROME_CANDIDATES = [
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
];

function findChrome(): string {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error("未找到 Chrome/Edge");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

async function main(): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), "eve-browser-"));
  let chrome: ChildProcess | null = null;
  try {
    chrome = spawn(findChrome(), [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--mute-audio",
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      "--window-size=1600,900",
      URL_,
    ], { stdio: ["ignore", "ignore", "ignore"] });

    // 等 CDP 就绪
    let targets: Array<{ type: string; url: string; webSocketDebuggerUrl: string }> = [];
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        targets = (await res.json()) as typeof targets;
        if (targets.some((t) => t.type === "page" && t.webSocketDebuggerUrl)) break;
      } catch { /* 未就绪 */ }
    }
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page) throw new Error("未找到可调试的页面目标");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>((ok, bad) => {
      ws.addEventListener("open", () => ok());
      ws.addEventListener("error", () => bad(new Error("CDP 连接失败")));
    });

    let nextId = 1;
    const pending = new Map<number, (v: CdpMessage) => void>();
    const consoleErrors: string[] = [];

    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as CdpMessage;
      if (msg.id !== undefined) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        consoleErrors.push("exception: " + (d?.exception?.description ?? d?.text ?? "?"));
      }
      if (msg.method === "Log.entryAdded") {
        const e = msg.params?.entry as { level?: string; text?: string } | undefined;
        if (e && (e.level === "error" || e.level === "warning")) consoleErrors.push(`${e.level}: ${e.text}`);
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const p = msg.params as { type?: string; args?: Array<{ value?: unknown }> } | undefined;
        if (p?.type === "error") {
          consoleErrors.push("console.error: " + p.args?.map((a) => String(a.value)).join(" "));
        }
      }
    });

    const call = (method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> => {
      const id = nextId++;
      return new Promise((resolveCall) => {
        pending.set(id, resolveCall);
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    await call("Runtime.enable");
    await call("Log.enable");
    await call("Page.enable");
    await call("Page.reload", { ignoreCache: true });

    const readDiag = async (): Promise<string> => {
      const r = await call("Runtime.evaluate", {
        expression: "document.getElementById('diag')?.textContent ?? 'no-diag'",
        returnByValue: true,
      });
      return String((r.result?.result as { value?: unknown } | undefined)?.value ?? "");
    };
    const readErrs = async (): Promise<string> => {
      const r = await call("Runtime.evaluate", {
        expression: "document.documentElement.getAttribute('data-errs') || ''",
        returnByValue: true,
      });
      return String((r.result?.result as { value?: unknown } | undefined)?.value ?? "");
    };

    // 等待场景加载完成（units > 0）
    let diag = "";
    for (let i = 0; i < SECONDS * 2; i++) {
      await sleep(500);
      diag = await readDiag();
      if (diag.includes('"units"')) {
        const m = /"units":(\d+)/.exec(diag);
        if (m && Number(m[1]) > 0) break;
      }
    }

    console.log("[browser] 首次就绪诊断:", diag);

    // 交互脚本（可选）
    for (const expr of EVALS) {
      const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      console.log(`[browser] eval ${expr.slice(0, 60)}… ->`, JSON.stringify(r.result?.result ?? r.error));
    }

    // 观察窗口
    console.log(`[browser] 观察 ${SECONDS}s …`);
    const samples: string[] = [];
    for (let i = 0; i < SECONDS; i++) {
      await sleep(1000);
      samples.push(await readDiag());
    }

    console.log("\n[browser] === 最终诊断 ===");
    console.log(samples[samples.length - 1]);
    const peak = samples
      .map((s) => Number(/"fps":(\d+)/.exec(s)?.[1] ?? 0))
      .reduce((a, b) => Math.max(a, b), 0);
    console.log(`[browser] 峰值 fps = ${peak}`);

    const shot = arg("shot", "");
    if (shot) {
      const r = await call("Page.captureScreenshot", { format: "png" });
      const b64 = (r.result as { data?: string } | undefined)?.data ?? "";
      if (b64) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(shot, Buffer.from(b64, "base64"));
        console.log(`[browser] 截图已保存：${shot}`);
      }
    }

    const pageErrs = await readErrs();
    if (pageErrs) console.log("[browser] 页面错误:", pageErrs);
    if (consoleErrors.length > 0) {
      console.log("[browser] === 控制台/异常 ===");
      for (const e of consoleErrors.slice(0, 30)) console.log("   ", e);
    } else {
      console.log("[browser] 无控制台错误/异常");
    }

    ws.close();
  } finally {
    chrome?.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error("[browser]", e);
  process.exit(1);
});
