"""第五轮（最后一轮）：脑插的施加与读取顺序；指挥脉冲用正确的属性名复核。"""
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


# 正确的抗性属性名是 *DamageResonance（不是 *Resistance）
RES_KEYS = ["shieldEmDamageResonance", "shieldThermalDamageResonance",
            "shieldKineticDamageResonance", "shieldExplosiveDamageResonance",
            "armorEmDamageResonance", "armorThermalDamageResonance",
            "armorKineticDamageResonance", "armorExplosiveDamageResonance"]
HP_KEYS = ["shieldCapacity", "armorHP", "hp", "powerOutput", "maxVelocity",
           "signatureRadius", "capacitorCapacity", "maxTargetRange", "scanResolution"]
ALL = RES_KEYS + HP_KEYS


def snap(ship, keys=ALL):
    out = {}
    for k in keys:
        try:
            out[k] = ship.getModifiedItemAttr(k)
        except Exception:
            out[k] = None
    return out


def diff(before, after):
    return {k: (before[k], after[k]) for k in before if before[k] != after[k]}


print("=" * 78)
print("A. 脑插：施加后**不重算**直接读")
print("=" * 78)
import eos.saveddata.implant as impmod  # noqa: E402

NIRVANA = ["High-grade Nirvana Alpha", "High-grade Nirvana Beta", "High-grade Nirvana Gamma",
           "High-grade Nirvana Delta", "High-grade Nirvana Epsilon", "High-grade Nirvana Omega"]


def try_case(label, setup):
    try:
        ch = Character("All 5", defaultLevel=5)
        for nm in NIRVANA:
            ch.implants.append(impmod.Implant(by_name(nm)))
        f = Fit()
        f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=ch)
        f.character = ch
        f.calculateModifiedAttributes()
        before = snap(f.ship)
        msg = setup(f, ch) or ""
        after = snap(f.ship)
        d = diff(before, after)
        print(f"  {label}: {'变化 ' + str(d) if d else '无变化'}  {msg}")
    except Exception as exc:
        print(f"  {label}: 失败 {type(exc).__name__}: {exc}")


try_case("A0 什么都不做（对照）", lambda f, ch: "")
try_case("A1 逐个 implant.calculateModifiedAttributes(fit, None)，不重算",
         lambda f, ch: [imp.calculateModifiedAttributes(f, None) for imp in list(ch.implants)] and "")
try_case("A2 同上但 runTime='server'",
         lambda f, ch: [imp.calculateModifiedAttributes(f, "server") for imp in list(ch.implants)] and "")
try_case("A3 char.fits.append(fit) 后重算",
         lambda f, ch: (ch.fits.append(f), f.calculateModifiedAttributes())[-1] and "")
try_case("A4 重算后再施加三个状态叠加读取",
         lambda f, ch: (f.calculateModifiedAttributes(),
                        [imp.calculateModifiedAttributes(f, "server") for imp in list(ch.implants)],
                        f.calculateModifiedAttributes())[-1] and "")

print("\n  直接看 Implant.calculateModifiedAttributes 的签名：")
import inspect  # noqa: E402
print("   ", inspect.signature(impmod.Implant.calculateModifiedAttributes))
print("   Fit 上与运行期/加成相关的私有方法：",
      [n for n in dir(Fit) if n.startswith("_Fit__")])
print("   Implant 私有方法：", [n for n in dir(impmod.Implant) if n.startswith("_Implant__")])

print("\n  单插自带效果链：把脑插挂到 fit 上看是否走到 ship 的 modified 上")
try:
    ch = Character("All 5", defaultLevel=5)
    imp = impmod.Implant(by_name("High-grade Nirvana Alpha"))
    ch.implants.append(imp)
    f = Fit()
    f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=ch)
    f.character = ch
    f.calculateModifiedAttributes()
    print("    ship.itemModifiedAttributes 键数 =", len(f.ship.itemModifiedAttributes or {}))
    print("    其中含 shield 的键：",
          [k for k in (f.ship.itemModifiedAttributes or {}) if "shield" in k.lower()][:12])
    print("    imp.active =", imp.active, " imp.slot =", imp.slot,
          " imp.itemID =", imp.itemID)
    print("    Char.getAll5() 与脑插是否联动（看 filteredSkillBoost）：",
          "filteredSkillBoost" in dir(ch))
except Exception as exc:
    print("    失败:", type(exc).__name__, exc)

print()
print("=" * 78)
print("B. 指挥脉冲：正确的属性名复核（应看到抗性变化）")
print("=" * 78)
import eos.saveddata.commandLink as cl  # noqa: E402

char = Character("All 5", defaultLevel=5)
for lt in ("armor_energizing", "armor_reinforcement", "shield_harmonizing",
           "shield_extension", "skirmish_evasive", "skirmish_rapid",
           "info_sensor", "info_hardening"):
    for strength in (5, 3):
        for mindlink in (False, True):
            f = Fit()
            f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
            f.character = char
            f.calculateModifiedAttributes()
            before = snap(f.ship)
            try:
                cl.applyCommandLinkToFit(f, cl.CommandLink(lt, strength, mindlink=mindlink))
                f.calculateModifiedAttributes()
            except Exception as exc:
                print(f"  {lt} s={strength} ml={mindlink}: 失败 {type(exc).__name__}: {exc}")
                continue
            d = diff(before, snap(f.ship))
            print(f"  {lt} s={strength} ml={mindlink} → {d if d else '无变化'}")

print("\n  多重 link 叠加（同时挂 armor_energizing + armor_reinforcement）：")
f = Fit()
f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
f.character = char
f.calculateModifiedAttributes()
before = snap(f.ship)
for lt in ("armor_energizing", "armor_reinforcement"):
    cl.applyCommandLinkToFit(f, cl.CommandLink(lt, 5, mindlink=True))
f.calculateModifiedAttributes()
print("   ", diff(before, snap(f.ship)))
