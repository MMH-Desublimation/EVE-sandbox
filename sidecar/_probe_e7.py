"""一轮集中探查（铁骑 / 脑插 / 指挥脉冲），全部以 PYFA 实测为准。

问三件事：
  1. 铁骑（Fighter）的**伤害/射速/射程**到底挂在哪里（上次读到 0）；
  2. 脑插（Implant）怎么挂到 Character 上、是否真的改变属性；
  3. 指挥脉冲（Command Burst）在 PYFA 里怎么表示、效果量怎么取。
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

import eos.db as edb  # noqa: E402
from eos.gamedata import Item  # noqa: E402


def by_name(name):
    return edb.gamedata_session.query(Item).filter(Item.name == name).first()


def attrs_of(item, needles=("damage", "rof", "range", "speed", "cycle", "duration")):
    out = {}
    for k, at in (getattr(item, "attributes", None) or {}).items():
        if not any(n in k.lower() for n in needles):
            continue
        v = None
        for key in ("value", "baseValue", "modifiedValue"):
            vv = getattr(at, key, None)
            if isinstance(vv, (int, float)):
                v = vv
                break
        out[k] = v
    return out


def effects_of(item):
    effs = getattr(item, "effects", None)
    if effs is None:
        return []
    vals = list(effs.values()) if hasattr(effs, "values") else list(effs)
    return [getattr(e, "name", None) for e in vals if getattr(e, "name", None)]


print("=" * 78)
print("一、铁骑（Fighter）")
print("=" * 78)
from eos.saveddata.character import Character  # noqa: E402
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.fighter import Fighter  # noqa: E402
from eos.saveddata.ship import Ship  # noqa: E402

char = Character("All 5", defaultLevel=5)
carrier = by_name("Archon")
fit = Fit()
fit.ship = Ship(carrier, owner=char)
fit.character = char

templar = by_name("Templar I")
f = Fighter(templar)
fit.fighters.append(f)
fit.calculateModifiedAttributes()

print("Fighter 公开成员：")
print(" ", [n for n in dir(f) if not n.startswith("_")])

print("\nFighter 上疑似 DPS 的成员：")
for n in ("getDps", "dps", "volley", "getVolley", "damageMultiplier", "abilities",
          "abilitiesLoaded", "getModifiedItemAttr", "activeAbility"):
    o = getattr(f, n, None)
    if o is None:
        continue
    if callable(o):
        try:
            print(f"  {n}() -> {o()}")
        except Exception as exc:
            print(f"  {n}() 失败: {type(exc).__name__}: {exc}")
    else:
        print(f"  {n} = {o!r}")

print("\nabilities 明细：")
try:
    for a in (f.abilities or []):
        print("  ---", a, "---")
        for n in [x for x in dir(a) if not x.startswith("_")]:
            if n in ("item", "effect", "name", "getModifiedItemAttr"):
                print(f"      {n} = {getattr(a, n, None)!r}")
        ab_item = getattr(a, "item", None)
        if ab_item is not None:
            print(f"      item name = {ab_item.name}")
            print(f"      item effects = {effects_of(ab_item)}")
            print(f"      item attrs = {attrs_of(ab_item)}")
except Exception as exc:
    print("  abilities 读取失败：", exc)

print("\n铁骑本体 item 上带 damage/rof/range 的属性：")
print(" ", attrs_of(templar))
print("铁骑本体 effects：", effects_of(templar))

print("\n对比：同族铁骑 II 与重型铁骑")
for nm in ("Templar II", "Cyclops I", "Standup Templar I"):
    it = by_name(nm)
    if it is None:
        print(f"  {nm}: 不存在")
        continue
    print(f"  {nm}: effects={effects_of(it)}")
    print(f"      attrs={attrs_of(it)}")

print()
print("=" * 78)
print("二、脑插（Implant）")
print("=" * 78)
import eos.saveddata.implant as impmod  # noqa: E402

print("模块公开名字：", [n for n in dir(impmod) if not n.startswith("_")])
import inspect  # noqa: E402
for n in dir(impmod):
    o = getattr(impmod, n)
    if isinstance(o, type):
        try:
            print(f"  {n}{inspect.signature(o.__init__)}")
        except Exception:
            pass

print("\nCharacter 上与脑插相关的成员：")
print(" ", [n for n in dir(char) if "implant" in n.lower() or "booster" in n.lower()])

IMPLANTS = [
    "High-grade Nirvana Alpha", "High-grade Nirvana Beta", "High-grade Nirvana Gamma",
    "High-grade Nirvana Delta", "High-grade Nirvana Epsilon", "High-grade Nirvana Omega",
    "High-grade Ascendancy Alpha",
    "Inherent Implants 'Squire' Power Grid Management EG-601",
]

print("\n尝试挂载脑插并观察属性变化：")
fit2 = Fit()
fit2.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
fit2.character = char
fit2.calculateModifiedAttributes()
base = {
    "shieldCapacity": fit2.ship.getModifiedItemAttr("shieldCapacity"),
    "armorHP": fit2.ship.getModifiedItemAttr("armorHP"),
    "powerOutput": fit2.ship.getModifiedItemAttr("powerOutput"),
    "maxVelocity": fit2.ship.getModifiedItemAttr("maxVelocity"),
}
print("  未装脑插：", base)

applied = []
for nm in IMPLANTS:
    it = by_name(nm)
    if it is None:
        print(f"  {nm}: SDE 中不存在")
        continue
    made = None
    for ctor in (lambda i: impmod.Implant(i, char), lambda i: impmod.Implant(i)):
        try:
            made = ctor(it)
            break
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
    if made is None:
        print(f"  {nm}: 构建失败（{last}）")
        continue
    for how in ("char.implants.append", "char.implants.add"):
        try:
            coll = char.implants
            if how.endswith("append"):
                coll.append(made)
            else:
                coll.add(made)
            applied.append(nm)
            print(f"  {nm}: 已通过 {how} 挂载")
            break
        except Exception as exc:
            continue
    else:
        print(f"  {nm}: 挂载到 char.implants 失败")

if applied:
    fit3 = Fit()
    fit3.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
    fit3.character = char
    fit3.calculateModifiedAttributes()
    after = {
        "shieldCapacity": fit3.ship.getModifiedItemAttr("shieldCapacity"),
        "armorHP": fit3.ship.getModifiedItemAttr("armorHP"),
        "powerOutput": fit3.ship.getModifiedItemAttr("powerOutput"),
        "maxVelocity": fit3.ship.getModifiedItemAttr("maxVelocity"),
    }
    print("  已装脑插：", after)
    print("  对比：", {k: (after[k], base[k]) for k in base if after[k] != base[k]} or "（无变化）")

print()
print("=" * 78)
print("三、指挥脉冲（Command Burst）")
print("=" * 78)
import eos.saveddata.commandLink as clmod  # noqa: E402

print("eos.saveddata.commandLink 公开名字：", [n for n in dir(clmod) if not n.startswith("_")])
for n in dir(clmod):
    o = getattr(clmod, n)
    if isinstance(o, type):
        try:
            print(f"  {n}{inspect.signature(o.__init__)}")
        except Exception:
            pass

print("\nSDE 里的指挥脉冲模块 / 弹药：")
rows = (edb.gamedata_session.query(Item)
        .filter(Item.name.like("%Command Burst%")).limit(30).all())
for it in rows:
    print(f"  {it.ID:>7}  {it.name}  group={it.groupID}")

print("\nSDE 里的指挥脉冲弹药（Charge）：")
rows = (edb.gamedata_session.query(Item)
        .filter(Item.name.like("%Charge%"))
        .filter(Item.name.like("%Armor%")).limit(20).all())
for it in rows:
    print(f"  {it.ID:>7}  {it.name}  group={it.groupID}")

print("\nFit 上与指挥脉冲/舰队加成相关的成员：")
print(" ", [n for n in dir(fit) if "command" in n.lower() or "link" in n.lower()
            or "bonus" in n.lower() or "fleet" in n.lower()])

print("\nCharacter 上与指挥脉冲相关的成员：")
print(" ", [n for n in dir(char) if "command" in n.lower() or "link" in n.lower()
            or "bonus" in n.lower() or "fleet" in n.lower()])
