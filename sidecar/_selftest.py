"""StatOracle 子进程端到端自检（不依赖 Node）。

用法: py sidecar/_selftest.py [case]
  case: version | raven | apoc | siege | all（默认 all）
"""
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PYFA_DIR = os.environ.get("PYFA_DIR", r"D:\eve  pyfa\pyfa")
WORK_DIR = os.environ.get("PYFA_WORK_DIR", os.path.join(ROOT, ".pyfa-core"))
PY = os.environ.get("PYFA_PYTHON", sys.executable)


def lasers(n=8, tid=3049, charge=258):
    return [{"slot": "hi", "typeId": tid, "state": "active", "chargeTypeId": charge} for _ in range(n)]


CASES = {
    "version": [{"id": 1, "op": "version"}, {"id": 2, "op": "ping"}],
    "raven": [{"id": 4, "op": "calcFit", "ship": {"name": "Raven"}}],
    "apoc": [{"id": 5, "op": "calcFit", "ship": {"name": "Apocalypse Navy Issue"},
              "modules": lasers(8) + [{"slot": "lo", "typeId": 2364, "state": "active"}] * 2}],
    "missile": [{"id": 7, "op": "calcFit", "ship": {"name": "Raven"},
                 "modules": [{"slot": "hi", "name": "Cruise Missile Launcher I", "state": "active",
                              "chargeName": "Scourge Cruise Missile"} for _ in range(6)]}],
    "siege_online": [{"id": 6, "op": "calcFit", "ship": {"name": "Phoenix"},
                      "modules": [{"slot": "hi", "name": "Siege Module II", "state": "online"}]}],
    "siege_active": [{"id": 8, "op": "calcFit", "ship": {"name": "Phoenix"},
                      "modules": [{"slot": "hi", "name": "Siege Module II", "state": "active"}]}],
}
CASES["siege"] = CASES["siege_online"] + CASES["siege_active"]
CASES["all"] = (CASES["version"] + CASES["raven"] + CASES["apoc"]
                + CASES["missile"] + CASES["siege"])


def main():
    case = sys.argv[1] if len(sys.argv) > 1 else "all"
    requests = CASES.get(case, CASES["all"])

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [PY, os.path.join(HERE, "pyfa_oracle.py"),
         "--pyfa-dir", PYFA_DIR, "--work-dir", WORK_DIR],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1, env=env)

    logs = []

    def pump(stream):
        for line in stream:
            logs.append(line.rstrip())
            if len(logs) > 400:
                del logs[:200]

    threading.Thread(target=pump, args=(proc.stderr,), daemon=True).start()

    t0 = time.perf_counter()
    first = proc.stdout.readline()
    print(f"[test] 就绪耗时 {(time.perf_counter() - t0) * 1000:.0f} ms -> {first.strip()}")

    for req in requests:
        a = time.perf_counter()
        proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        dt = (time.perf_counter() - a) * 1000
        if not line:
            print(f"[test] id={req['id']} {req['op']} -> 进程已退出（无响应），rc={proc.poll()}")
            print("[test] --- stderr 末尾 ---")
            for l in logs[-25:]:
                print("   ", l)
            return
        try:
            resp = json.loads(line)
        except ValueError:
            print(f"[test] id={req['id']} 响应不是合法 JSON: {line[:200]!r}")
            for l in logs[-25:]:
                print("   ", l)
            return
        summarize(req, resp, dt)

    proc.stdin.close()
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


def summarize(req, resp, dt):
    op = req["op"]
    if not resp.get("ok"):
        print(f"[test] id={req['id']} {op} ({dt:.1f} ms) FAILED: {resp.get('error')}")
        return
    if op == "version":
        print(f"[test] id={req['id']} version ({dt:.1f} ms) -> {resp['pyfaVersion']}")
    elif op == "ping":
        print(f"[test] id={req['id']} ping    ({dt:.1f} ms) -> pong={resp['pong']}")
    elif op == "resolveNames":
        print(f"[test] id={req['id']} resolve ({dt:.1f} ms) -> {resp['resolved']} missing={resp['missing']}")
    elif op == "calcFit":
        a = resp["attrs"]
        dps = sum(w.get("dps") or 0 for w in resp["weapons"])
        print(f"[test] id={req['id']} calcFit ({dt:.1f} ms) "
              f"HP={a['hp']['shield']:.0f}/{a['hp']['armor']:.0f}/{a['hp']['hull']:.0f} "
              f"vel={a['nav']['maxVelocity']:.1f} mass={a['nav']['mass']:.3e} "
              f"weps={len(resp['weapons'])} dps={dps:.1f} "
              f"actives={len(resp['actives'])} passives={len(resp.get('passives', []))} "
              f"unhandled={len(resp['unhandled'])}")
        for w in resp["weapons"]:
            print(f"          - {w['name']} x{w['count']} volley={w.get('volley'):.2f} dps={w.get('dps'):.2f} "
                  f"rof={w['rof']:.1f} dmgMul={w['damageMultiplier']:.4f} "
                  f"opt={w['optimal']:.0f} state={w['state']} charge={w['chargeName']}")
            print(f"            aoe: cloud={w.get('aoeCloudSize')} vel={w.get('aoeVelocity')} "
                  f"drf={w.get('aoeDamageReduction')} drfSens={w.get('aoeDamageReductionSensitivity')} "
                  f"mVel={w.get('missileVelocity')} flight={w.get('missileFlightMs')} cap={w.get('capNeed')}")
        for m in resp["actives"]:
            print(f"          * {m['name']} kind={m['kind']} state={m['state']} "
                  f"dur={m['duration']} cap={m['capNeed']} eff={m['effectAmounts']}")


if __name__ == "__main__":
    main()
