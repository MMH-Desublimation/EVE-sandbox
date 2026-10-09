"""进程内验证 oracle 的三条新通路：脑插 / 指挥脉冲 / 铁骑。

不经过子进程协议，直接调 Oracle.op_calc_fit —— 定位问题更快。
用法：py sidecar/_selftest_e7.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pyfa_core import boot_core, ensure_core  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
core = ensure_core(os.environ.get("PYFA_DIR", r"D:\eve  pyfa\pyfa"),
                   os.environ.get("PYFA_WORK_DIR", os.path.join(ROOT, ".pyfa-core")))
boot_core(core)

from pyfa_oracle import Oracle  # noqa: E402

o = Oracle(core)

fails = 0
checks = 0


def check(label, actual, expected=None, tol=None, truthy=False):
    global fails, checks
    checks += 1
    if truthy:
        ok = bool(actual)
    elif tol is not None and isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        ok = abs(actual - expected) <= tol
    else:
        ok = actual == expected
    if not ok:
        fails += 1
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: {actual}"
          + ("" if ok else f"  (期望 {expected})"))


ARCHON = 23757
TEMPLAR_I = 23055
CYCLOPS_I = 32325
APOSTLE = 37604
FORTIZAR = 35833
STANDUP_TEMPLAR = 47035
NIRVANA = [53710, 53711, 53712, 53713, 53714, 53715]  # Alpha..Omega（下面按名兜底）

ARMOR_COMMAND_BURST_II = 43552
ARMOR_ENERGIZING_CHARGE = 42832

NIRVANA_NAMES = [
    "High-grade Nirvana Alpha", "High-grade Nirvana Beta", "High-grade Nirvana Gamma",
    "High-grade Nirvana Delta", "High-grade Nirvana Epsilon", "High-grade Nirvana Omega",
]

print("=" * 78)
print("1) 铁骑：一个发射管 = 一个纵队，能力带齐射/周期/射程")
print("=" * 78)
base_req = {
    "op": "calcFit",
    "ship": {"typeId": ARCHON},
    "modules": [],
    "fighters": [{"typeId": TEMPLAR_I, "count": 2}],
}
r1 = o.op_calc_fit(base_req)
check("计算成功", r1.get("ok"), True)
fx = r1.get("fighters") or []
check("铁骑行数（按型号归组）", len(fx), 1)
if fx:
    row = fx[0]
    print(f"      型号={row['name']} 纵队长={row['count']} 规模={row['squadronSize']} "
          f"轻型={row['isLight']} 单架HP={row['hpEach']}")
    check("纵队规模 = 6", row["squadronSize"], 6)
    check("是轻型铁骑", row["isLight"], True)
    check("单架护盾 HP > 0", (row["hpEach"]["shield"] or 0) > 0, True)
    check("能力数（攻击 + 远程导弹）", len(row["abilities"]), 2)
    for ab in row["abilities"]:
        vol = sum((ab["volley"] or {}).get(k, 0) or 0 for k in ("em", "thermal", "kinetic", "explosive"))
        dps = vol / (ab["cycleMs"] / 1000.0) if ab["cycleMs"] else 0
        print(f"      {ab['effect']}: 齐射={vol:.1f} 周期={ab['cycleMs']:.0f}ms "
              f"→ {dps:.1f} DPS；射程 opt={ab['optimal']} fall={ab['falloff']} "
              f"爆炸半径={ab['explosionRadius']} DRF={ab['drf']}")
        check(f"  {ab['effect']} 齐射 > 0", vol > 0, True)
        check(f"  {ab['effect']} 周期 > 0", (ab["cycleMs"] or 0) > 0, True)
    attack = [a for a in row["abilities"] if "Attack" in a["effect"]]
    missiles = [a for a in row["abilities"] if "Missiles" in a["effect"]]
    if attack:
        check("攻击能力周期 5000ms", attack[0]["cycleMs"], 5000, 1)
        # 射程是**技能加成后**的值（基础 8000 × 1.25 = 10000），故只校验下限与相对关系
        check("攻击能力射程 ≥ 基础 8000m", attack[0]["optimal"] >= 8000, True)
        check("攻击能力有爆炸半径（导弹应用率用）", (attack[0]["explosionRadius"] or 0) > 0, True)
    if attack and missiles:
        ratio = attack[0]["optimal"] / missiles[0]["optimal"]
        check("攻击射程 / 远程射程 ≈ 0.8（8000:10000）", round(ratio, 3), 0.8, 0.02)
        check("攻击 DPS > 远程 DPS（贴身用攻击）",
              attack[0]["cycleMs"] < missiles[0]["cycleMs"], True)

print("\n重型铁骑与建筑铁骑（纵队规模不同）：")
for nm, tid in (("Cyclops I", CYCLOPS_I), ("Standup Templar I", STANDUP_TEMPLAR)):
    r = o.op_calc_fit({"op": "calcFit", "ship": {"typeId": FORTIZAR},
                       "modules": [], "fighters": [{"typeId": tid, "count": 1}]})
    row = (r.get("fighters") or [{}])[0]
    print(f"  {nm}: ok={r.get('ok')} 规模={row.get('squadronSize')} "
          f"能力数={len(row.get('abilities') or [])}")

print()
print("=" * 78)
print("2) 脑插：有配置才算，没配置不算")
print("=" * 78)
mega = 3049
std_l = 258
ship = 17726  # Apocalypse Navy Issue
mods = [{"slot": "hi", "typeId": mega, "state": "active", "chargeTypeId": std_l} for _ in range(8)]

no_imp = o.op_calc_fit({"op": "calcFit", "ship": {"typeId": ship}, "modules": mods})
with_imp = o.op_calc_fit({
    "op": "calcFit", "ship": {"typeId": ship}, "modules": mods,
    "implants": [{"name": n} for n in NIRVANA_NAMES],
})
check("无脑插时 implants 为空", len(no_imp.get("implants") or []), 0)
check("有脑插时 implants 有 6 件", len(with_imp.get("implants") or []), 6)
if with_imp.get("implants"):
    print(f"      示例：{with_imp['implants'][0]}")
sh0 = no_imp["attrs"]["hp"]["shield"]
sh1 = with_imp["attrs"]["hp"]["shield"]
print(f"      护盾：{sh0} → {sh1}  ({(sh1 / sh0 - 1) * 100:+.2f}%)")
check("高级极乐全套提升护盾 > 30%", (sh1 / sh0 - 1) > 0.30, True)

single = o.op_calc_fit({
    "op": "calcFit", "ship": {"typeId": ship}, "modules": mods,
    "implants": [{"name": "High-grade Nirvana Alpha"}],
})
sh2 = single["attrs"]["hp"]["shield"]
print(f"      只装单件：护盾 {sh0} → {sh2}  ({(sh2 / sh0 - 1) * 100:+.2f}%)")
check("单件加成远小于全套（体现套装机制）", 0 < (sh2 / sh0 - 1) < 0.05, True)

print()
print("=" * 78)
print("3) 指挥脉冲：按 PYFA 真值改抗性")
print("=" * 78)
link = o.op_calc_fit({
    "op": "calcFit", "ship": {"typeId": ship}, "modules": mods,
    "env": {"commandLinks": [{"linkType": "armor_energizing", "strength": 5, "mindlink": True}]},
})
check("env.commandLinks 已记录", len((link.get("env") or {}).get("commandLinks") or []), 1)
a0 = no_imp["attrs"]["res"]["armor"][0]
a1 = link["attrs"]["res"]["armor"][0]
print(f"      装甲 EM 共振：{a0} → {a1}（抗性 {(1 / a0 - 1) * 100:.1f}% → {(1 / a1 - 1) * 100:.1f}%）")
check("装甲 EM 抗性显著提升", a1 < a0 * 0.85, True)

both = o.op_calc_fit({
    "op": "calcFit", "ship": {"typeId": ship}, "modules": mods,
    "implants": [{"name": n} for n in NIRVANA_NAMES],
    "env": {"commandLinks": [
        {"linkType": "armor_energizing", "strength": 5, "mindlink": True},
        {"linkType": "armor_reinforcement", "strength": 5, "mindlink": True},
    ]},
})
hp_both = both["attrs"]["hp"]["armor"]
print(f"      脑插 + 双链接：装甲 HP {no_imp['attrs']['hp']['armor']} → {hp_both}")
check("多重链接叠加生效", hp_both > no_imp["attrs"]["hp"]["armor"] * 1.1, True)

print("\n未知 link 类型应被记为 unhandled 而不是崩掉：")
bad = o.op_calc_fit({
    "op": "calcFit", "ship": {"typeId": ship}, "modules": mods,
    "env": {"commandLinks": [{"linkType": "不存在的链接", "strength": 5, "mindlink": False}]},
})
check("未崩溃", bad.get("ok"), True)
check("记入 unhandled（未知 link 类型被拦下）",
      any("UNKNOWN_COMMAND_LINK" in str(u.get("reason", ""))
          for u in bad.get("unhandled") or []), True)
print(f"      unhandled = {bad.get('unhandled')}")

print()
print(f"[_selftest_e7] {checks} 项断言，{'全部通过' if fails == 0 else str(fails) + ' 项失败'}")
sys.exit(1 if fails else 0)
