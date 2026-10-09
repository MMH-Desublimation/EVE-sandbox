"""第三轮：决定性探查。

A. 铁骑的**循环时间**到底挂在哪个属性上（逐个能力的效果属性 ID 反查）；
B. 脑插的正确挂法（6 种接线/顺序组合对比）；
C. 指挥脉冲：按 COMMAND_LINK_DEFS 的真实 link 类型 × 强度 × 脑插 实测属性变化。
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
from eos.gamedata import Attribute, Item  # noqa: E402
from eos.saveddata.character import Character  # noqa: E402
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.ship import Ship  # noqa: E402


def by_name(n):
    return edb.gamedata_session.query(Item).filter(Item.name == n).first()


def attr_name(aid):
    if aid is None:
        return None
    try:
        a = edb.gamedata_session.query(Attribute).filter(Attribute.ID == aid).first()
        return getattr(a, "name", None)
    except Exception:
        return None


def dump_all_attrs(item):
    out = {}
    for k, at in (getattr(item, "attributes", None) or {}).items():
        v = None
        for key in ("value", "baseValue", "modifiedValue"):
            vv = getattr(at, key, None)
            if isinstance(vv, (int, float)):
                v = vv
                break
        if v is not None:
            out[k] = v
    return out


print("=" * 78)
print("A. 铁骑的循环时间 / 射程参数在哪")
print("=" * 78)
from eos.saveddata.fighter import Fighter  # noqa: E402

char = Character("All 5", defaultLevel=5)
fit = Fit()
fit.ship = Ship(by_name("Archon"), owner=char)
fit.character = char

templar = by_name("Templar I")
f = Fighter(templar)
fit.fighters.append(f)
fit.calculateModifiedAttributes()

print("Templar I 的全部属性：")
for k, v in sorted(dump_all_attrs(templar).items()):
    print(f"    {k} = {v}")

print("\n各能力的效果参数（属性 ID → 名称 → 铁骑上的取值）：")
for a in (f.abilities or []):
    eff = getattr(a, "effect", None)
    nm = getattr(eff, "name", None)
    print(f"  --- ability effect={nm} ---")
    for field in ("durationAttributeID", "rangeAttributeID", "falloffAttributeID",
                  "trackingSpeedAttributeID", "dischargeAttributeID", "durationPosition",
                  "rangePosition"):
        if not hasattr(eff, field):
            continue
        aid = getattr(eff, field, None)
        an = attr_name(aid)
        val = None
        if an:
            try:
                val = f.getModifiedItemAttr(an)
            except Exception as exc:
                val = f"<err {type(exc).__name__}>"
        print(f"      {field}={aid} → {an} = {val}")

print("\n尝试修好 factorReload 后取 DPS：")
for setter in ("f.factorReload", "fit.factorReload"):
    try:
        if setter.startswith("f."):
            f.factorReload = 1
        else:
            fit.factorReload = 1
        print(f"  {setter} = 1 设置成功")
    except Exception as exc:
        print(f"  {setter} 设置失败: {type(exc).__name__}: {exc}")
for call in ("getDps", "getDpsPerEffect"):
    try:
        print(f"  {call}() = {getattr(f, call)()}")
    except Exception as exc:
        print(f"  {call}() 仍失败: {type(exc).__name__}: {exc}")
for call, args in (("getCycleParametersPerEffectInfinite", ()),
                   ("getCycleParametersPerEffect", ())):
    try:
        print(f"  {call}() = {getattr(f, call)(*args)}")
    except Exception as exc:
        print(f"  {call}() 失败: {type(exc).__name__}: {exc}")
try:
    print(f"  getVolleyParametersPerEffect() = {f.getVolleyParametersPerEffect()}")
except Exception as exc:
    print(f"  getVolleyParametersPerEffect() 失败: {type(exc).__name__}: {exc}")
print(f"  raw getVolley() = {f.getVolley()}")

print()
print("=" * 78)
print("B. 脑插的正确挂法")
print("=" * 78)
import eos.saveddata.implant as impmod  # noqa: E402

NIRVANA = ["High-grade Nirvana Alpha", "High-grade Nirvana Beta", "High-grade Nirvana Gamma",
           "High-grade Nirvana Delta", "High-grade Nirvana Epsilon", "High-grade Nirvana Omega"]
KEYS = ["shieldCapacity", "armorHP", "hp", "powerOutput", "shieldEmResistance"]


def check(label, make):
    try:
        ch, extra = make()
        f = Fit()
        f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=ch)
        f.character = ch
        f.calculateModifiedAttributes()
        vals = {k: f.ship.getModifiedItemAttr(k) for k in KEYS}
        print(f"  {label}: {vals}  {extra}")
        return vals
    except Exception as exc:
        print(f"  {label}: 失败 {type(exc).__name__}: {exc}")
        return None


def base():
    return Character("All 5", defaultLevel=5), ""


base_vals = check("基线（无脑插）", base)


def mk_append():
    ch = Character("All 5", defaultLevel=5)
    for nm in NIRVANA:
        ch.implants.append(impmod.Implant(by_name(nm)))
    return ch, f"implants={len(ch.implants)}"


def mk_backref():
    ch = Character("All 5", defaultLevel=5)
    for nm in NIRVANA:
        imp = impmod.Implant(by_name(nm))
        try:
            imp.character = [ch]
        except Exception:
            pass
        ch.implants.append(imp)
    return ch, f"implants={len(ch.implants)} backref set"


def mk_char_calc():
    ch = Character("All 5", defaultLevel=5)
    for nm in NIRVANA:
        ch.implants.append(impmod.Implant(by_name(nm)))
    ch.calculateModifiedAttributes()
    return ch, "char.calculateModifiedAttributes() called"


def mk_order_char_first():
    ch = Character("All 5", defaultLevel=5)
    for nm in NIRVANA:
        ch.implants.append(impmod.Implant(by_name(nm)))
    ch._order = "char_first"
    return ch, "fit 构造顺序：character 先于 ship"


check("A 仅 append", mk_append)
check("B append + imp.character=[ch]", mk_backref)
check("C append + char.calculateModifiedAttributes()", mk_char_calc)

# D：character 先于 ship
try:
    ch = Character("All 5", defaultLevel=5)
    for nm in NIRVANA:
        ch.implants.append(impmod.Implant(by_name(nm)))
    f = Fit()
    f.character = ch
    f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=ch)
    f.calculateModifiedAttributes()
    print(f"  D character 先于 ship: "
          f"{ {k: f.ship.getModifiedItemAttr(k) for k in KEYS} }")
except Exception as exc:
    print(f"  D 失败 {type(exc).__name__}: {exc}")

# E：ship.owner 不设（只靠 fit.character）
try:
    ch = Character("All 5", defaultLevel=5)
    for nm in NIRVANA:
        ch.implants.append(impmod.Implant(by_name(nm)))
    f = Fit()
    f.ship = Ship(by_name("Apocalypse Navy Issue"))
    f.character = ch
    f.calculateModifiedAttributes()
    print(f"  E 不设 ship.owner: "
          f"{ {k: f.ship.getModifiedItemAttr(k) for k in KEYS} }")
except Exception as exc:
    print(f"  E 失败 {type(exc).__name__}: {exc}")

print("\n  直查单个脑插是否自己就能给出加成：")
imp = impmod.Implant(by_name("High-grade Nirvana Alpha"))
for k in ("shieldCapacity", "shieldCapacityBonus", "hp"):
    try:
        print(f"    implant.getModifiedItemAttr({k}) = {imp.getModifiedItemAttr(k)}")
    except Exception as exc:
        print(f"    implant.getModifiedItemAttr({k}) 失败: {exc}")

print()
print("=" * 78)
print("C. 指挥脉冲：真实 link 类型实测")
print("=" * 78)
import eos.saveddata.commandLink as cl  # noqa: E402

BASE_KEYS = ["shieldEmResistance", "shieldThermalResistance", "shieldKineticResistance",
             "shieldExplosiveResistance", "armorEmResistance", "armorThermalResistance",
             "armorKineticResistance", "armorExplosiveResistance",
             "maxVelocity", "signatureRadius", "maxTargetRange", "scanResolution",
             "capacitorCapacity", "shieldCapacity", "armorHP",
             "armorDamageAmount", "shieldBonus"]


def snapshot():
    f = Fit()
    f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
    f.character = char
    f.calculateModifiedAttributes()
    before = {}
    for k in BASE_KEYS:
        try:
            before[k] = f.ship.getModifiedItemAttr(k)
        except Exception:
            before[k] = None
    return f, before


keys = [k for k in cl.COMMAND_LINK_DEFS.keys() if k != "all"]
print(f"  link 类型 {len(keys)} 个；只打印有变化的组合")
for lt in keys:
    for strength in (5, 3, 1):
        for mindlink in (False, True):
            f, before = snapshot()
            try:
                link = cl.CommandLink(lt, strength, mindlink=mindlink, active=True)
                cl.applyCommandLinkToFit(f, link)
            except Exception as exc:
                print(f"  {lt} s={strength} ml={mindlink}: 失败 "
                      f"{type(exc).__name__}: {exc}")
                continue
            after = {}
            for k in BASE_KEYS:
                try:
                    after[k] = f.ship.getModifiedItemAttr(k)
                except Exception:
                    after[k] = None
            diff = {k: (before[k], after[k]) for k in BASE_KEYS if before[k] != after[k]}
            if diff:
                print(f"  {lt} s={strength} ml={mindlink} → {diff}")
print("  （以上为全部有变化的组合）")
print(f"  getLinkMultiplier(5, True) = {cl.getLinkMultiplier(5, True)}")
print(f"  getLinkMultiplier(3, False) = {cl.getLinkMultiplier(3, False)}")
