"""第二轮精确探查：铁骑输出参数 / 脑插生效条件 / 指挥脉冲的 applyCommandLinkToFit 用法。"""
import inspect
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


def num(item, key):
    at = (getattr(item, "attributes", None) or {}).get(key)
    if at is None:
        return None
    for k in ("value", "baseValue", "modifiedValue"):
        v = getattr(at, k, None)
        if isinstance(v, (int, float)):
            return v
    return None


def effects_of(item):
    effs = getattr(item, "effects", None)
    if effs is None:
        return []
    vals = list(effs.values()) if hasattr(effs, "values") else list(effs)
    return [getattr(e, "name", None) for e in vals if getattr(e, "name", None)]


def dump_fit_attrs(fit, keys):
    out = {}
    for k in keys:
        try:
            out[k] = fit.ship.getModifiedItemAttr(k)
        except Exception:
            out[k] = None
    return out


char = Character("All 5", defaultLevel=5)

print("=" * 78)
print("一、铁骑输出参数")
print("=" * 78)
from eos.saveddata.fighter import Fighter  # noqa: E402

carrier = by_name("Archon")
fit = Fit()
fit.ship = Ship(carrier, owner=char)
fit.character = char

for nm in ("Templar I", "Templar II", "Cyclops I", "Standup Templar I"):
    it = by_name(nm)
    if it is None:
        print(f"{nm}: 不存在")
        continue
    f = Fighter(it)
    fit.fighters.append(f)
    try:
        fit.calculateModifiedAttributes()
    except Exception as exc:
        print(f"{nm}: 计算失败 {exc}")
        continue
    vol = f.getVolley()
    speed = None
    for key in ("speed", "rateOfFire", "cycleTime", "duration"):
        try:
            v = f.getModifiedItemAttr(key)
        except Exception:
            v = None
        if v:
            speed = (key, v)
            break
    print(f"\n{nm} (ID={it.ID})")
    print(f"  本体 effects = {effects_of(it)}")
    print(f"  本体 speed/rateOfFire/duration = "
          f"{num(it, 'speed')}/{num(it, 'rateOfFire')}/{num(it, 'duration')}")
    print(f"  getVolley() = em={vol.em} th={vol.thermal} kin={vol.kinetic} exp={vol.explosive}")
    print(f"  循环时间 = {speed}")
    print(f"  maxRange/falloff = {f.maxRange}/{f.falloff}")
    print(f"  fighterSquadronMaxSize = {f.fighterSquadronMaxSize}")
    print(f"  hp/ehp = {f.hp}/{f.ehp}")
    try:
        print(f"  canDealDamage(True) = {f.canDealDamage(True)}")
    except Exception as exc:
        print(f"  canDealDamage 失败: {exc}")
    print("  abilities:")
    for a in (f.abilities or []):
        eff = getattr(a, "effect", None)
        print(f"    - effect={getattr(eff, 'name', None)!r} "
              f"item={getattr(getattr(a, 'item', None), 'name', None)!r}")
    try:
        print(f"  getDpsPerEffect() = {f.getDpsPerEffect()}")
    except Exception as exc:
        print(f"  getDpsPerEffect 失败: {type(exc).__name__}: {exc}")
    try:
        print(f"  getCycleParametersPerEffectOptimizedDps() = "
              f"{f.getCycleParametersPerEffectOptimizedDps()}")
    except Exception as exc:
        print(f"  优化 DPS 周期参数失败: {type(exc).__name__}: {exc}")

print()
print("=" * 78)
print("二、脑插：为什么没改变属性")
print("=" * 78)
import eos.saveddata.implant as impmod  # noqa: E402

it = by_name("High-grade Nirvana Alpha")
imp = impmod.Implant(it)
print("Implant 公开成员：", [n for n in dir(imp) if not n.startswith("_")])
for n in ("slot", "character", "active", "item", "itemID"):
    print(f"  {n} = {getattr(imp, n, '<无>')!r}")
print("  effects =", effects_of(it))
for k in ("shieldCapacityBonus", "armorHPBonus", "hullHPBonus", "powerGridBonus"):
    print(f"  {k} = {num(it, k)}")

print("\nchar.implants 类型/长度：", type(char.implants), len(char.implants))
print("Character 是否有 calculateModifiedAttributes：",
      hasattr(char, "calculateModifiedAttributes"))

# 正确做法猜测：Implant 需要 slot 与 character 回指
print("\n试法 A：imp.slot + imp.character 再 append")
c2 = Character("All 5", defaultLevel=5)
imp2 = impmod.Implant(by_name("High-grade Nirvana Alpha"))
for attr, val in (("slot", 1),):
    try:
        setattr(imp2, attr, val)
        print(f"  设置 {attr}={val} OK")
    except Exception as exc:
        print(f"  设置 {attr} 失败: {exc}")
try:
    imp2.character = c2
    print("  设置 character OK")
except Exception as exc:
    print("  设置 character 失败:", exc)
try:
    c2.implants.append(imp2)
    print("  append OK，len =", len(c2.implants))
except Exception as exc:
    print("  append 失败:", exc)

for label, ch in (("无脑插", Character("All 5", defaultLevel=5)), ("有脑插", c2)):
    f = Fit()
    f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=ch)
    f.character = ch
    f.calculateModifiedAttributes()
    print(f"  {label}: " + str(dump_fit_attrs(
        f, ["shieldCapacity", "armorHP", "hp", "powerOutput", "shieldEmResistance"])))

print("\n试法 B：直接查 Character 对舰船的加成路径")
print("  Character 公开成员（部分）：",
      [n for n in dir(char) if not n.startswith("_")][:60])

print()
print("=" * 78)
print("三、指挥脉冲：CommandLink 常量与 applyCommandLinkToFit")
print("=" * 78)
import eos.saveddata.commandLink as cl  # noqa: E402

for name in ("ALL_LINK_TYPE", "CATEGORY_LABELS", "CATEGORY_ORDER", "CATEGORY_LINKS",
             "STRENGTHS", "SKILL_MULTIPLIER", "TECH_MULTIPLIER", "MINDLINK_MULTIPLIER",
             "COMMAND_LINK_DEFS", "WARFARE_LINK_BASE_VALUES"):
    print(f"  {name} = {getattr(cl, name, None)!r}")

print("\n  applyCommandLinkToFit 签名：", inspect.signature(cl.applyCommandLinkToFit))
print("  getLinkMultiplier 签名：", inspect.signature(cl.getLinkMultiplier))
print("  CommandLink 签名：", inspect.signature(cl.CommandLink))

print("\n实际应用：给一艘启示级挂各种指挥脉冲，看属性变化")
BASE_KEYS = ["shieldEmResistance", "shieldThermalResistance", "shieldKineticResistance",
             "shieldExplosiveResistance", "armorEmResistance", "armorThermalResistance",
             "armorKineticResistance", "armorExplosiveResistance",
             "maxVelocity", "mass", "signatureRadius", "maxTargetRange",
             "scanResolution", "capacitorCapacity", "shieldCapacity", "armorHP"]

base_fit = Fit()
base_fit.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
base_fit.character = char
base_fit.calculateModifiedAttributes()
before = dump_fit_attrs(base_fit, BASE_KEYS)

link_types = getattr(cl, "ALL_LINK_TYPE", [])
print(f"  共 {len(link_types) if hasattr(link_types, '__len__') else '?'} 种 link 类型")
for lt in (link_types if hasattr(link_types, "__iter__") else []):
    for strength in (1, 2):
        for mindlink in (False, True):
            f = Fit()
            f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
            f.character = char
            f.calculateModifiedAttributes()
            try:
                link = cl.CommandLink(lt, strength, mindlink=mindlink, active=True)
                cl.applyCommandLinkToFit(f, link)
            except Exception as exc:
                print(f"  link={lt} s={strength} ml={mindlink}: 应用失败 "
                      f"{type(exc).__name__}: {exc}")
                continue
            after = dump_fit_attrs(f, BASE_KEYS)
            diff = {k: (before[k], after[k]) for k in BASE_KEYS if after[k] != before[k]}
            if diff:
                print(f"  link={lt} strength={strength} mindlink={mindlink} → 变化：{diff}")
            else:
                print(f"  link={lt} strength={strength} mindlink={mindlink} → 无变化")
