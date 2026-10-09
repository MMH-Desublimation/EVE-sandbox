/**
 * V0.7 四页流程的真实浏览器验收（无头 Chrome + CDP，零依赖）。
 *
 * 覆盖端到端链路：
 *   启动停在「数据导入」→ 导入 PYFA XML → 配置库入库 → 战场编成套用 → 生成推演
 *   → 沙盘出单位 → 选中单位读锁定/射程环 → 终止推演回到战场编成。
 *
 * 用法（需先启动 `node tools/dev-host.ts`）：
 *   node tools/v07-flow-check.ts [--url http://127.0.0.1:5178/src/ui/index.html] [--port 9337] [--shot 路径.png]
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
const PORT = Number(arg("port", "9337"));
const SHOT = arg("shot", "");

const CHROME_CANDIDATES = [
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
];

function findChrome(): string {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
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

/** 一段可直接贴进 PYFA「导出 XML」的单行 XML（避免命令行换行转义）。 */
const PYFA_XML = [
  '<fittings><fitting name="V07自动验收">',
  '<description value=""/>',
  '<ship type="Apocalypse Navy Issue"/>',
  '<hardware slot="hi slot 0" type="Mega Beam Laser II"/>',
  '<hardware slot="hi slot 0" type="Standard L"/>',
  '<hardware slot="lo slot 0" type="Heat Sink II"/>',
  '<hardware slot="lo slot 1" type="多谱式护盾增强器 II"/>',
  '<hardware slot="lo slot 2" type="多谱式护盾增强器 II"/>',
  '<drone bay slot="drone bay" type="Berserker II" qty="5"/>',
  "</fitting></fittings>",
].join("");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? `：${detail}` : ""}`);
}

async function main(): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), "eve-v07-"));
  let chrome: ChildProcess | null = null;
  try {
    chrome = spawn(findChrome(), [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--mute-audio",
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      "--window-size=1600,900",
      URL_,
    ], { stdio: ["ignore", "ignore", "ignore"] });

    let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
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
        const d = msg.params?.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined;
        consoleErrors.push("exception: " + (d?.exception?.description ?? d?.text ?? "?"));
      }
      if (msg.method === "Log.entryAdded") {
        const e = msg.params?.entry as { level?: string; text?: string } | undefined;
        if (e && (e.level === "error" || e.level === "warning")) consoleErrors.push(`${e.level}: ${e.text}`);
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const p = msg.params as { type?: string; args?: Array<{ value?: unknown }> } | undefined;
        if (p?.type === "error") consoleErrors.push("console.error: " + p.args?.map((a) => String(a.value)).join(" "));
      }
    });

    const call = async (method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> => {
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

    const evaljs = async (expr: string): Promise<unknown> => {
      const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.error) throw new Error(String(r.error.message));
      return (r.result?.result as { value?: unknown } | undefined)?.value ?? null;
    };

    const waitReady = async (): Promise<void> => {
      for (let i = 0; i < 60; i++) {
        const v = await evaljs("typeof window.__ui === 'object' && typeof window.__ui.page === 'function'");
        if (v === true) return;
        await sleep(500);
      }
      throw new Error("__ui 钩子未就绪");
    };

    console.log("== 1) 启动页 ==");
    await waitReady();
    await sleep(1200);
    const startPage = String(await evaljs("window.__ui.page()"));
    check("启动停在「数据导入」页", startPage === "import", `page=${startPage}`);

    console.log("== 2) 导入 PYFA XML ==");
    const imported = Number(await evaljs(`window.__ui.importText(${JSON.stringify(PYFA_XML)})`));
    check("XML 解析出 1 份配置", imported === 1, `got=${imported}`);
    if (imported !== 1) {
      // 失败时把页面上的提示原文打出来，避免盲修
      const dbg = String(await evaljs(
        "JSON.stringify({stat:document.querySelector('.import-stat')?.textContent,"
        + "result:document.querySelector('.import-result')?.textContent})",
      ));
      console.log("  [诊断]", dbg);
    }
    const libCount = Number(await evaljs("window.__ui.libraryCount()"));
    check("已自动入库到配置库", libCount >= 1, `库内 ${libCount} 份`);
    if (process.env.DEBUG === "1") {
      console.log("  [库内容]", String(await evaljs("JSON.stringify(window.__ui.fits())")));
    }

    console.log("== 3) 战场编成 → 生成推演 ==");
    const gen = String(await evaljs(
      "(()=>{const p=window.__ui.plan();const id=window.__ui.libraryIds()[0];"
      + "p.sides.forEach(s=>s.fleets.forEach(f=>f.wings.forEach(w=>w.squads.forEach(q=>{q.fitId=id;q.count=6;}))));"
      + "window.__ui.generate();return 'ok';})()",
    ));
    check("生成推演已触发", gen === "ok", gen);
    await sleep(9000);
    const state = JSON.parse(String(await evaljs(
      "JSON.stringify({page:window.__ui.page(),units:(window.__ui.frame()||{units:[]}).units.length,"
      + "cel:((window.__ui.frame()||{}).celestials||[]).length,"
      + "sides:[...new Set((window.__ui.frame()||{units:[]}).units.map(u=>u.sideId))].sort()})",
    ))) as { page: string; units: number; cel: number; sides: number[] };
    check("切换到推演页", state.page === "sim", `page=${state.page}`);
    check("双方各 6 艘共 12 单位", state.units === 12, `units=${state.units}`);
    check("星门在 1..3 之间", state.cel >= 1 && state.cel <= 3, `celestials=${state.cel}`);
    check("两个势力 0/1", JSON.stringify(state.sides) === "[0,1]", JSON.stringify(state.sides));

    console.log("== 3b) 运动流畅度（tick 间插值） ==");
    // 让红方 1 号船朝蓝方 1 号船接近 → 产生持续运动，再在 rAF 上采样渲染位置
    const mover = JSON.parse(String(await evaljs(
      "(()=>{const f=window.__ui.frame();const a=f.units.find(u=>u.sideId===0);const b=f.units.find(u=>u.sideId===1);"
      + "window.__ui.select([a.id]);"
      + "window.__ui.send({type:'command',cmd:{tick:f.tick,target:{unitIds:[a.id]},"
      + "action:'setOrder',params:{type:'approach',targetId:b.id}}});"
      + "return JSON.stringify({a:a.id,b:b.id});})()",
    ))) as { a: string; b: string };
    await sleep(2000);
    if (process.env.DEBUG === "1") {
      console.log("  [运动调试]", String(await evaljs(
        `(()=>{const f=window.__ui.frame();const a=f.units.find(u=>u.id===${JSON.stringify(mover.a)});`
        + "return JSON.stringify({order:a.order,vx:a.vx,vy:a.vy,x:a.x,y:a.y,tick:f.tick,"
        + "playing:f.playing,speed:f.speed,log:f.commandLog.slice(-2)});})()",
      )));
    }
    // 插值必须与倍速解耦：tick 在 4× 只隔 250ms、在 0.5× 要隔 2000ms，
    // 两档都要"每帧都在前进"。慢速档要先给足加速时间（加速按游戏时间计）。
    for (const spd of [4, 1, 0.5]) {
      await evaljs(`window.__ui.speed(${spd})`);
      await sleep(Math.max(1200, Math.round(2400 / spd)));
      const sm = JSON.parse(String(await evaljs(
        `(async()=>JSON.stringify(await window.__ui.smoothness(${JSON.stringify(mover.a)},1600)))()`,
      ))) as {
        frames: number; fps: number; ticks: number; medianM: number;
        frozenRatio: number; backwardRatio: number; jumpRatio: number;
        jumpP95Ratio: number; bigStepRatio: number; moving: boolean;
      };
      console.log(`  [流畅度 ${spd}×]`, JSON.stringify(sm));
      const tag = `${spd}×`;
      // 期望每帧步长 = 单位速度 × 倍速 / 帧率；用它反查插值有没有偏慢/偏快
      const expect = JSON.parse(String(await evaljs(
        `(()=>{const a=window.__ui.frame().units.find(u=>u.id===${JSON.stringify(mover.a)});`
        + "return JSON.stringify(Math.hypot(a.vx,a.vy));})()",
      ))) as number;
      const wantM = (expect * spd) / Math.max(1, sm.fps);
      check(`${tag} 采样单位确实在运动`, sm.moving, `medianM=${sm.medianM}`);
      check(`${tag} 渲染连续：无回退帧`, sm.backwardRatio <= 0.05, `backwardRatio=${sm.backwardRatio}`);
      check(`${tag} 渲染连续：无冻结段`, sm.frozenRatio <= 0.2, `frozenRatio=${sm.frozenRatio}`);
      // 平滑度以 95 分位为准：max 会被单帧 GC / 布局抖动顶起来，判的是"持续的一节一节感"。
      // 阈值 2.0：4× 下一个 tick 只摊到约 5 个发帧，而 tick 到达与渲染帧格不对齐，
      // 会出现"这一段 4 帧、那一段 6 帧"的量化纹波（≈1.5×），属正常；真出现
      // 每 tick 一次的固定跳变时比值会显著更大。
      check(`${tag} 渲染连续：步长稳定`, sm.jumpP95Ratio > 0 && sm.jumpP95Ratio <= 2,
        `jumpP95Ratio=${sm.jumpP95Ratio}`);
      check(`${tag} 渲染连续：极少大步进`, sm.bigStepRatio <= 0.08, `bigStepRatio=${sm.bigStepRatio}`);
      check(`${tag} 渲染连续：无离谱跳变`, sm.jumpRatio > 0 && sm.jumpRatio <= 10, `jumpRatio=${sm.jumpRatio}`);
      check(`${tag} 渲染速度与倍速一致`, sm.medianM > wantM * 0.7 && sm.medianM < wantM * 1.3,
        `medianM=${sm.medianM} 期望≈${Math.round(wantM * 100) / 100}`);
    }
    await evaljs("window.__ui.speed(4)");

    console.log("== 3c) 无人机图标平滑（组自身插值，不随母舰） ==");
    // 用户报障：无人机图标"频繁闪烁、聚散移动"。根因是环绕沿切线**直走**，
    // 半径每 tick 涨一点、下一 tick 又被拉回 → 径向抖动。
    // 这里直接采样**组自己**的渲染位置，要求它像舰船一样连续前进（无冻结 / 回退 / 大步进）。
    const droneSel = JSON.parse(String(await evaljs(
      "(()=>{const f=window.__ui.frame();let host=null,gid=null;"
      + "for(const u of f.units){for(const g of (u.groups||[])){"
      // 组 id 只在母舰内唯一，必须拼母舰 id 才是全局唯一的句柄
      + "if(g.alive&&g.kind==='drone'){host=u;gid=u.id+'#'+g.id;break;}}if(host)break;}"
      + "if(!host)return JSON.stringify({gid:null});"
      + "const foe=f.units.find(u=>u.alive&&u.sideId!==host.sideId);"
      + "window.__ui.send({type:'command',cmd:{tick:f.tick,target:{unitIds:[host.id]},"
      + "action:'setTarget',params:{targetId:foe.id}}});"
      + "return JSON.stringify({host:host.id,gid:gid});})()",
    ))) as { host?: string; gid: string | null };
    check("战场生成了无人机（组）", typeof droneSel.gid === "string", JSON.stringify(droneSel));
    if (typeof droneSel.gid === "string") {
      // 用 1× 采样：一圈环绕的转角小，首末连线方向仍是"整体前进方向"，
      // 投影出的"回退帧"才真的代表抖动，而不是绕圈的切向翻转。
      await evaljs("window.__ui.speed(1)");
      await sleep(2500);
      const gsm = JSON.parse(String(await evaljs(
        `(async()=>JSON.stringify(await window.__ui.smoothness(${JSON.stringify(droneSel.gid)},1600)))()`,
      ))) as {
        frames: number; fps: number; medianM: number;
        frozenRatio: number; backwardRatio: number; jumpP95Ratio: number; bigStepRatio: number; moving: boolean;
      };
      console.log("  [无人机流畅度 1×]", JSON.stringify(gsm));
      check("无人机图标在移动（不是钉死原地）", gsm.moving, `medianM=${gsm.medianM}`);
      check("无人机无冻结段（不闪烁）", gsm.frozenRatio <= 0.25, `frozenRatio=${gsm.frozenRatio}`);
      check("无人机无回退帧（不聚散回退）", gsm.backwardRatio <= 0.15, `backwardRatio=${gsm.backwardRatio}`);
      check("无人机步长稳定（半径不来回抖）",
        gsm.jumpP95Ratio > 0 && gsm.jumpP95Ratio <= 2.5, `jumpP95Ratio=${gsm.jumpP95Ratio}`);
      check("无人机极少大步进", gsm.bigStepRatio <= 0.12, `bigStepRatio=${gsm.bigStepRatio}`);
      await evaljs("window.__ui.speed(4)");
      await sleep(300);
    }

    console.log("== 4) 装备中文简写与进度条 ==");
    const equip = JSON.parse(String(await evaljs(
      "JSON.stringify(Array.from(document.querySelectorAll('#left .module .lbl')).slice(0,6).map(n=>n.textContent))",
    ))) as string[];
    if (process.env.DEBUG === "1") {
      console.log("  [小队装备行]", String(await evaljs("JSON.stringify(window.__ui.squadModules())")));
      console.log("  [帧结构]", String(await evaljs(
        "(()=>{const f=window.__ui.frame();return JSON.stringify({"
        + "squads:f&&f.squads?f.squads.length:null,"
        + "s0:f&&f.squads&&f.squads[0]?{n:f.squads[0].name,mods:f.squads[0].modules.map(m=>[m.typeId,m.label]),w:f.squads[0].weapons.length}:null,"
        + "unit0:f&&f.units[0]?Object.keys(f.units[0]).length:null});})()",
      )));
      console.log("  [DOM]", String(await evaljs(
        "(()=>{const n=document.querySelector('#left .module');return n?n.outerHTML.slice(0,300):'none';})()",
      )));
      console.log("  [SDE]", String(await evaljs(
        "JSON.stringify([3049,2364,2281].map(id=>({id,zh:window.__ui.zh(id),grp:window.__ui.groupName(id)})))",
      )));
    }
    check("左侧装备行存在中文简写", equip.some((t) => /盾全抗/.test(t ?? "")), JSON.stringify(equip));
    const hasCyc = Boolean(await evaljs(
      "Array.from(document.querySelectorAll('#left .module')).some(n=>n.querySelector('.cyc'))",
    ));
    check("装备按钮带进度条节点", hasCyc);

    console.log("== 4b) 装备启停端到端（启用 → 循环填充 → 淡红待停 → 本轮走完才停） ==");
    const modState = async (): Promise<{ text: string; cls: string; cyc: number }> =>
      JSON.parse(String(await evaljs(
        "(()=>{const n=document.querySelector('#left .module');"
        + "return JSON.stringify({text:n.querySelector('.lbl').textContent,cls:n.className,"
        + "cyc:parseFloat(n.querySelector('.cyc').style.getPropertyValue('--cyc'))||0});})()",
      )));
    const m0 = await modState();
    check("装备初始未启用", !/on/.test(m0.cls) && /\(0\/\d+\)/.test(m0.text), `${m0.text}｜${m0.cls}`);
    if (process.env.DEBUG === "1") {
      // 逐实例单独下发，定位"点一次只启用一半"到底是哪个 instanceIndex 没落地
      const send = async (inst: number, state: string): Promise<void> => {
        await evaljs(
          "(()=>{const f=window.__ui.frame();const u=f.units.find(x=>x.sideId===0);"
          + "window.__ui.send({type:'command',cmd:{tick:f.tick,"
          + "target:{sideId:u.sideId,squadId:u.squadId},"
          + `action:'toggleModule',params:{kind:'shieldHardener',instanceIndex:${inst},state:'${state}'}}});`
          + "return 'sent';})()",
        );
      };
      // 小队视图每 4 帧才带一次，读取要轮询等待
      const readRows = async (): Promise<string> => {
        for (let i = 0; i < 12; i++) {
          const s = String(await evaljs(
            "(()=>{const f=window.__ui.frame();return f.squads&&f.squads[0]?"
            + "JSON.stringify(f.squads[0].modules.map(m=>[m.owned,m.on,m.pendingOff])):'NODATA';})()",
          ));
          if (s !== "NODATA") return s;
          await sleep(120);
        }
        return "NODATA";
      };
      for (const i of [0, 1]) await send(i, "online");
      await sleep(700);
      console.log("  [复位后]", await readRows());
      for (const inst of [0, 1]) {
        await send(inst, "active");
        await sleep(700);
        console.log(`  [仅下发实例 ${inst}]`, await readRows());
      }
      for (const i of [0, 1]) await send(i, "online");
      await sleep(700);
      console.log("  [复位后2]", await readRows());
    }
    await evaljs("document.querySelector('#left .module').click()");
    await sleep(700);
    if (process.env.DEBUG === "1") {
      // 同一 tick 一次性下发两个实例（未来 tick，排除"指令过期"干扰），看是否两条都落地
      console.log("  [同 tick 双实例]", String(await evaljs(
        "(()=>{const f=window.__ui.frame();const u=f.units.find(x=>x.sideId===0);"
        + "const tk=f.tick+3;const target={sideId:u.sideId,squadId:u.squadId};"
        + "for(const inst of [0,1])window.__ui.send({type:'command',cmd:{tick:tk,target,"
        + "action:'toggleModule',params:{kind:'shieldHardener',instanceIndex:inst,state:'active'}}});"
        + "return 'sent@'+tk;})()",
      )));
      await sleep(1500);
      console.log("  [同 tick 双实例后]", await evaljs(
        "(()=>{const f=window.__ui.frame();const g=f.squads||[];"
        + "return JSON.stringify(g[0]?g[0].modules.map(m=>[m.owned,m.on]):'NODATA');})()",
      ));
    }
    let m1 = await modState();
    check("左键启用：该型号全部实例转运转", /\bon\b/.test(m1.cls) && !/\(0\//.test(m1.text), `${m1.text}｜${m1.cls}`);
    // 进度条在每轮起点为 0%，采样可能正好落在起点 → 轮询等待，避免时序抖动
    for (let i = 0; i < 8 && m1.cyc <= 0; i++) { await sleep(250); m1 = await modState(); }
    check("启用后进度条开始填充", m1.cyc > 0, `--cyc=${m1.cyc}%`);
    await sleep(1000);
    const m2 = await modState();
    check("进度条随运转持续推进", m2.cyc !== m1.cyc, `${m1.cyc}% → ${m2.cyc}%`);
    await evaljs("document.querySelector('#left .module').click()");
    await sleep(500);
    const m3 = await modState();
    check("再点一次：先挂「停用中」（淡红）", /pending/.test(m3.cls) && /停用中/.test(m3.text), `${m3.text}｜${m3.cls}`);
    check("待停期间实例仍在运转（不是立刻断）", !/\(0\//.test(m3.text), m3.text);
    // 轮询等待本轮循环走完（不依赖固定 sleep，避免"本轮时长"抖动）
    let m4 = await modState();
    for (let i = 0; i < 60; i++) {
      if (!/pending/.test(m4.cls) && !/\bon\b/.test(m4.cls) && /\(0\//.test(m4.text)) break;
      await sleep(250);
      m4 = await modState();
    }
    check("本轮走完才真正停用", !/pending/.test(m4.cls) && !/\bon\b/.test(m4.cls) && /\(0\//.test(m4.text),
      `${m4.text}｜${m4.cls}`);

    console.log("== 4c) 右侧「舰队指令」装备按钮同理（stale 闭包回归防护） ==");
    const rightState = async (): Promise<{ text: string; cls: string }> =>
      JSON.parse(String(await evaljs(
        "(()=>{const n=document.querySelector('.module-box .module');"
        + "return JSON.stringify({text:n.querySelector('.lbl').textContent,cls:n.className});})()",
      )));
    if (process.env.DEBUG === "1") {
      console.log("  [右侧目录行]", String(await evaljs(
        "(()=>{const f=window.__ui.frame();const g=f.squads||[];"
        + "return JSON.stringify(g.map(s=>s.modules.map(m=>({t:m.typeId,o:m.owned,on:m.on,po:m.pendingOff,"
        + "inst:m.instances.map(i=>[i.kind,i.instanceIndex])}))));})()",
      )));
    }
    await evaljs("document.querySelector('.module-box .module').click()");
    await sleep(700);
    const r1 = await rightState();
    check("右侧：一次点击即启用该型号全部实例", /\bon\b/.test(r1.cls) && !/\(0\//.test(r1.text),
      `${r1.text}｜${r1.cls}`);
    await evaljs("document.querySelector('.module-box .module').click()");
    await sleep(400);
    const r2 = await rightState();
    check("右侧：再点一次进入「停用中」（淡红）或本轮已走完关闭",
      /pending/.test(r2.cls) || (!/\bon\b/.test(r2.cls) && /\(0\//.test(r2.text)), `${r2.text}｜${r2.cls}`);
    // 复位：等本轮走完再继续，避免遗留「停用中」影响后续断言
    for (let i = 0; i < 60; i++) {
      const s = await rightState();
      if (!/pending/.test(s.cls)) break;
      await sleep(250);
    }

    console.log("== 5) 锁定环 / 射程环 ==");
    const rings = JSON.parse(String(await evaljs(
      "(()=>{const f=window.__ui.frame();const id=f.units[0].id;window.__ui.select([id]);"
      + "return JSON.stringify(window.__ui.rings());})()",
    ))) as Array<{ lockRange: number; range: number }>;
    check("选中单位有锁定距离（橙环）", rings.length === 1 && rings[0].lockRange > 0,
      JSON.stringify(rings.slice(0, 1)));
    check("选中单位有武器射程（绿环）", rings.length === 1 && rings[0].range > 0,
      JSON.stringify(rings.slice(0, 1)));
    const ringOn = Boolean(await evaljs(
      "(()=>{const b=Array.from(document.querySelectorAll('.tb-btn')).find(n=>n.textContent.includes('锁定/射程环'));return b?b.classList.contains('on'):false;})()",
    ));
    check("工具条「锁定/射程环」默认开启", ringOn);

    console.log("== 5b) 环只在「单选」绘制 / 沙盘不画舰船名字 ==");
    // 用户要求：环只在点选**单个**单位时显示，框选不显示（几百个环叠成一团看不清）；
    // 沙盘只显示图标，不写舰船名字。这里读的是**渲染计数**，验的是绘制行为本身。
    await sleep(400);
    const rs1 = JSON.parse(String(await evaljs("JSON.stringify(window.__ui.renderStats())"))) as
      { ringsDrawn: number; labelsDrawn: number; unitNames: boolean };
    check("单选单位时画出锁定/射程环（2 个）", rs1.ringsDrawn === 2, `ringsDrawn=${rs1.ringsDrawn}`);
    check("沙盘不画舰船名字（只显示图标）",
      rs1.labelsDrawn === 0 && rs1.unitNames === false,
      `labelsDrawn=${rs1.labelsDrawn} unitNames=${rs1.unitNames}`);
    await evaljs("(()=>{const f=window.__ui.frame();window.__ui.select(f.units.slice(0,4).map(u=>u.id));return 'ok';})()");
    await sleep(400);
    const rs2 = JSON.parse(String(await evaljs("JSON.stringify(window.__ui.renderStats())"))) as
      { ringsDrawn: number };
    check("框选多个单位时不画环", rs2.ringsDrawn === 0, `ringsDrawn=${rs2.ringsDrawn}`);
    // 复位成单选，后续断言依赖"选中 1 个"
    await evaljs("(()=>{const f=window.__ui.frame();window.__ui.select([f.units[0].id]);return 'ok';})()");

    console.log("== 6) 终止推演 ==");
    await evaljs("window.__ui.terminate()");
    await sleep(800);
    const afterTerm = String(await evaljs("window.__ui.page()"));
    check("终止后回到「战场编成」", afterTerm === "formation", `page=${afterTerm}`);

    console.log("== 7) 直接点导航「④ 推演」= 非空沙盘（回归防护） ==");
    // 用户报障：点顶栏「④ 推演」进去是一片空沙盘（无舰队、左侧列表空、也不能拖）。
    // 这里走**与用户完全相同**的导航点击通路，要求它按当前编成当场生成推演。
    await evaljs("window.__ui.nav('sim')");
    let navUnits = 0;
    let navPage = "";
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      navPage = String(await evaljs("window.__ui.page()"));
      navUnits = Number(await evaljs("(window.__ui.frame()||{units:[]}).units.length"));
      if (navPage === "sim" && navUnits > 0) break;
    }
    check("点导航「④ 推演」切到推演页", navPage === "sim", `page=${navPage}`);
    check("点导航「④ 推演」后沙盘非空（有舰队）", navUnits > 0, `units=${navUnits}`);
    // 光有数据还不够：要确认舰队**真的落在可视范围里**（取景塌陷会把它们压成亚像素）
    const navOnScreen = Number(await evaljs("(window.__ui.metrics()||{}).unitsOnScreen ?? 0"));
    check("点导航「④ 推演」后舰队在可视范围内（看得见）", navOnScreen > 0,
      `unitsOnScreen=${navOnScreen}/${navUnits}`);
    const leftFilled = Boolean(await evaljs(
      "(()=>{const n=document.querySelector('#left');return !!n && n.innerText.trim().length > 0;})()",
    ));
    check("左侧舰队列表非空", leftFilled);

    console.log("== 8) 左键拖动沙盘改变取景（回归防护） ==");
    // 用户报障：鼠标不能拖动沙盒。这里合成一次真实左键拖动，比对取景参数是否变化。
    const cbox = JSON.parse(String(await evaljs(
      "(()=>{const b=document.querySelector('#map').getBoundingClientRect();"
      + "return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()",
    ))) as { x: number; y: number };
    const viewBefore = JSON.parse(String(await evaljs("JSON.stringify(window.__ui.view())"))) as {
      cx: number; cy: number; scale: number;
    };
    const mouse = (type: string, x: number, y: number): Promise<CdpMessage> =>
      call("Input.dispatchMouseEvent", {
        type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1,
      });
    await mouse("mousePressed", cbox.x, cbox.y);
    for (let i = 1; i <= 6; i++) {
      await mouse("mouseMoved", cbox.x + i * 20, cbox.y + i * 8);
      await sleep(40);
    }
    await mouse("mouseReleased", cbox.x + 120, cbox.y + 48);
    await sleep(300);
    const viewAfter = JSON.parse(String(await evaljs("JSON.stringify(window.__ui.view())"))) as {
      cx: number; cy: number; scale: number;
    };
    const moved = Math.hypot(viewAfter.cx - viewBefore.cx, viewAfter.cy - viewBefore.cy);
    check("左键拖动沙盘改变了取景（可拖动）", moved > 0,
      `cx ${Math.round(viewBefore.cx)}→${Math.round(viewAfter.cx)}｜cy ${Math.round(viewBefore.cy)}→${Math.round(viewAfter.cy)}`
      + `｜scale=${viewBefore.scale.toExponential(2)}`);

    // ── 左侧 UI 选中 / 右键菜单选中 ──────────────────────────────────────
    // 期望集合**独立**从帧里的组织字段（sideId/fleetId/wingId/squadId）算出来，
    // 与被测代码不是同一份实现，能抓到"过滤条件写错"这类 bug。
    const orgExpect = async (level: "fleet" | "wing" | "squad"): Promise<{ exp: string[]; got: string[] }> =>
      JSON.parse(String(await evaljs(
        "(()=>{const f=window.__ui.frame();const all=f.units.filter(u=>u.alive&&!u.evac);"
        + "const h=all[0];"
        + "const exp=all.filter(u=>u.sideId===h.sideId&&u.fleetId===h.fleetId"
        + (level === "wing" ? "&&u.wingId===h.wingId" : "")
        + (level === "squad" ? "&&u.wingId===h.wingId&&u.squadId===h.squadId" : "")
        + ").map(u=>u.id).sort();"
        + "const got=[...window.__ui.selectedIds()].sort();"
        + "return JSON.stringify({exp,got});})()",
      ))) as { exp: string[]; got: string[] };
    const sameSet = (r: { exp: string[]; got: string[] }): boolean =>
      r.got.length === r.exp.length && r.got.length > 0 && JSON.stringify(r.got) === JSON.stringify(r.exp);

    console.log("== 9) 左侧「舰队 / 联队 / 小队」行选中 ==");
    const clickSel = async (sel: string): Promise<void> => {
      await evaljs(`document.querySelector('${sel}').click()`);
      await sleep(300);
    };
    await clickSel("#left .org-row.org-fleet");
    const lvFleet = await orgExpect("fleet");
    check("点左侧「舰队」行选中整支舰队", sameSet(lvFleet), `${lvFleet.got.length}/${lvFleet.exp.length}`);
    await clickSel("#left .org-row.org-wing");
    const lvWing = await orgExpect("wing");
    check("点左侧「联队」行选中整个联队", sameSet(lvWing), `${lvWing.got.length}/${lvWing.exp.length}`);
    await clickSel("#left .squad .squad-head");
    const lvSquad = await orgExpect("squad");
    check("点左侧「小队」行选中整个小队", sameSet(lvSquad), `${lvSquad.got.length}/${lvSquad.exp.length}`);

    console.log("== 10) 右键菜单「选中所属联队 / 舰队」 ==");
    // 在某个图标上派发真实 contextmenu（与用户右键同一条 handler），读菜单项
    await evaljs(
      "(()=>{const u=window.__ui.frame().units.find(x=>x.alive&&!x.evac);"
      + "const p=window.__ui.unitScreen(u.id);const r=document.querySelector('#map').getBoundingClientRect();"
      + "document.querySelector('#map').dispatchEvent(new MouseEvent('contextmenu',"
      + "{bubbles:true,cancelable:true,clientX:r.left+p.x,clientY:r.top+p.y,button:2}));return 'ok';})()",
    );
    await sleep(300);
    const menuLabels = JSON.parse(String(await evaljs(
      "JSON.stringify(Array.from(document.querySelectorAll('.ctx-menu .ctx-item .ctx-label')).map(n=>n.textContent))",
    ))) as string[];
    const wingIdx = menuLabels.findIndex((t) => /选中所属联队/.test(t ?? ""));
    const fleetIdx = menuLabels.findIndex((t) => /选中所属舰队/.test(t ?? ""));
    check("右键菜单含「选中所属联队」", wingIdx >= 0, JSON.stringify(menuLabels));
    check("右键菜单含「选中所属舰队」", fleetIdx >= 0);
    // 点「选中所属联队」→ 选择应变成该联队全部单位（独立算出的期望集合）
    if (wingIdx >= 0) {
      await evaljs(`document.querySelectorAll('.ctx-menu .ctx-item')[${wingIdx}].click()`);
      await sleep(300);
      const rw = await orgExpect("wing");
      check("点「选中所属联队」后选中整个联队", sameSet(rw), `${rw.got.length}/${rw.exp.length}`);
    }
    if (fleetIdx >= 0) {
      await evaljs(`document.querySelectorAll('.ctx-menu .ctx-item')[${fleetIdx}].click()`);
      await sleep(300);
      const rf = await orgExpect("fleet");
      check("点「选中所属舰队」后选中整支舰队", sameSet(rf), `${rf.got.length}/${rf.exp.length}`);
    }

    const pageErrs = String(await evaljs("document.documentElement.getAttribute('data-errs') || ''"));
    if (pageErrs) console.log("\n[页面错误]", pageErrs);
    if (consoleErrors.length > 0) {
      console.log("\n[控制台/异常]");
      for (const e of consoleErrors.slice(0, 20)) console.log("   ", e);
    } else {
      console.log("\n[控制台] 无错误/异常");
    }

    if (SHOT) {
      const r = await call("Page.captureScreenshot", { format: "png" });
      const b64 = (r.result as { data?: string } | undefined)?.data ?? "";
      if (b64) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(SHOT, Buffer.from(b64, "base64"));
        console.log(`[截图] ${SHOT}`);
      }
    }

    ws.close();
  } finally {
    chrome?.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n[v07-flow] ${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[v07-flow]", e);
  process.exit(1);
});
