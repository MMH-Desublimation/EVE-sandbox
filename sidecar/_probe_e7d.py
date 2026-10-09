"""第四轮（收尾）：脑插显式施加 / 指挥脉冲需重算 / 铁骑能力与周期映射。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pyfa_core import boot_core, ensure_core  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
core = ensure_core(os.environ.get("PYFA_DIR", r"D:\eve  pyfa\pyfa"),
                   os.environ.get("PYFA_WORK_DIR", os.path.join(ROOT, ".pyfa-core")))
boot_core(core)

import eos.db as edb  # noqa: E402
from eos.gamedata import Item  # noqa: E402
from eos.saveddata.character import Character  # noqa: E402
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.ship import Ship  # noqa: E402


def by_name(n):
    return edb.gamedata_session.query(Item).filter(Item.name == n).first()


KEYS = ["shieldCapacity", "armorHP", "hp", "powerOutput", "shieldEmResistance",
        "armorEmResistance", "maxVelocity", "signatureRadius"]
BASE_KEYS = ["shieldEmResistance", "shieldThermalResistance", "armorEmResistance",
             "armorThermalResistance", "maxVelocity", "signatureRadius",
             "maxTargetRange", "scanResolution", "capacitorCapacity"]


def snap(ship):
    out = {}
    for k in KEYS:
        try:
            out[k] = ship.getModifiedItemAttr(k)
        except Exception:
            out[k] = None
    return out


print("=" * 78)
print("A. 脑插：显式调用 implant.calculateModifiedAttributes(fit, runTime)")
print("=" * 78)
import eos.saveddata.implant as impmod  # noqa: E402

NIRVANA = ["High-grade Nirvana Alpha", "High-grade Nirvana Beta", "High-grade Nirvana Gamma",
           "High-grade Nirvana Delta", "High-grade Nirvana Epsilon", "High-grade Nirvana Omega"]

for run_time in (None, "server", "client", "both"):
    try:
        ch = Character("All 5", defaultLevel=5)
        for nm in NIRVANA:
            ch.implants.append(impmod.Implant(by_name(nm)))
        f = Fit()
        f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=ch)
        f.character = ch
        f.calculateModifiedAttributes()
        before = snap(f.ship)
        for imp in list(ch.implants):
            try:
                imp.calculateModifiedAttributes(f, run_time)
            except Exception as exc:
                print(f"  runTime={run_time!r} 逐个施加失败: {type(exc).__name__}: {exc}")
                break
        else:
            f.calculateModifiedAttributes()
            after = snap(f.ship)
            diff = {k: (before[k], after[k]) for k in KEYS if before[k] != after[k]}
            print(f"  runTime={run_time!r}: {'变化 ' + str(diff) if diff else '无变化'}")
            continue
        break
    except Exception as exc:
        print(f"  runTime={run_time!r} 失败: {type(exc).__name__}: {exc}")

print("\n  换一条路径：先给 fit 挂 character，再逐个 append 脑插后重算")
try:
    ch = Character("All 5", defaultLevel=5)
    f = Fit()
    f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=ch)
    f.character = ch
    f.calculateModifiedAttributes()
    before = snap(f.ship)
    for nm in NIRVANA:
        imp = impmod.Implant(by_name(nm))
        ch.implants.append(imp)
        try:
            imp.calculateModifiedAttributes(f, None)
        except Exception:
            pass
    f.calculateModifiedAttributes()
    after = snap(f.ship)
    diff = {k: (before[k], after[k]) for k in KEYS if before[k] != after[k]}
    print("  ", "变化 " + str(diff) if diff else "无变化")
except Exception as exc:
    print("  失败:", type(exc).__name__, exc)

print("\n  再试：Character 上是否有 applyImplant/applyBoosters 之类")
print("  ", [n for n in dir(Character) if not n.startswith("_")])

print()
print("=" * 78)
print("B. 指挥脉冲：apply 之后**重新计算**")
print("=" * 78)
import eos.saveddata.commandLink as cl  # noqa: E402

char = Character("All 5", defaultLevel=5)
changed = 0
for lt in [k for k in cl.COMMAND_LINK_DEFS.keys() if k != "all"]:
    for strength in (5, 3, 1):
        for mindlink in (False, True):
            f = Fit()
            f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
            f.character = char
            f.calculateModifiedAttributes()
            before = {k: f.ship.getModifiedItemAttr(k) for k in BASE_KEYS}
            try:
                link = cl.CommandLink(lt, strength, mindlink=mindlink, active=True)
                cl.applyCommandLinkToFit(f, link)
            except Exception as exc:
                print(f"  {lt} s={strength} ml={mindlink}: apply 失败 "
                      f"{type(exc).__name__}: {exc}")
                continue
            # ★ 关键：apply 之后再算一次
            try:
                f.calculateModifiedAttributes()
            except Exception as exc:
                print(f"  {lt} s={strength} ml={mindlink}: 重算失败 "
                      f"{type(exc).__name__}: {exc}")
                continue
            after = {k: f.ship.getModifiedItemAttr(k) for k in BASE_KEYS}
            diff = {k: (before[k], after[k]) for k in BASE_KEYS if before[k] != after[k]}
            if diff:
                changed += 1
                if changed <= 12:
                    print(f"  {lt} s={strength} ml={mindlink} → {diff}")
print(f"  合计 {changed} 个组合产生了属性变化")
print(f"  commandLinks 内容 = {getattr(f, 'commandLinks', None)}")
try:
    print(f"  getCommandInfo() = {f.getCommandInfo()}")
except Exception as exc:
    print(f"  getCommandInfo 失败: {exc}")

print()
print("=" * 78)
print("C. 铁骑：能力 → 齐射/周期/射程 的映射")
print("=" * 78)
from eos.saveddata.fighter import Fighter  # noqa: E402

carrier = by_name("Archon")
for nm in ("Templar I", "Cyclops I", "Standup Templar I"):
    it = by_name(nm)
    f = Fit()
    f.ship = Ship(carrier, owner=char)
    f.character = char
    fr = Fighter(it)
    f.fighters.append(fr)
    f.calculateModifiedAttributes()
    print(f"\n{nm}：")
    try:
        cyc = fr.getCycleParametersPerEffectInfinite()
        for eid, info in cyc.items():
            print(f"    effect {eid}: activeTime={info.activeTime} "
                  f"inactiveTime={info.inactiveTime} qty={info.quantity}")
    except Exception as exc:
        print(f"    周期失败: {exc}")
    try:
        vols = fr.getVolleyParametersPerEffect()
        for eid, per in vols.items():
            for k, v in per.items():
                print(f"    effect {eid} volley = em={v.em} th={v.thermal} "
                      f"kin={v.kinetic} exp={v.explosive} breachers={v.breachers}")
    except Exception as exc:
        print(f"    齐射失败: {exc}")
    print(f"    fighterSquadronMaxSize={fr.fighterSquadronMaxSize} "
          f"orbitRange={it.attributes.get('fighterSquadronOrbitRange')} "
          f"maxVelocity={fr.getModifiedItemAttr('maxVelocity')}")
    print(f"    全部属性键（fighterAbility 前缀）："
          f"{[k for k in (it.attributes or {}) if k.startswith('fighterAbility')][:24]}")
