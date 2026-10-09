"""第六轮（定案）：脑插挂在 **Fit** 上（PYFA 的 fit.implants），不是挂在 Character 上。"""
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
import eos.saveddata.implant as impmod  # noqa: E402


def by_name(n):
    return edb.gamedata_session.query(Item).filter(Item.name == n).first()


KEYS = ["shieldCapacity", "armorHP", "hp", "powerOutput", "maxVelocity",
        "signatureRadius", "maxTargetRange", "scanResolution", "capacitorCapacity",
        "shieldEmDamageResonance", "armorEmDamageResonance", "cpuOutput"]
NIRVANA = ["High-grade Nirvana Alpha", "High-grade Nirvana Beta", "High-grade Nirvana Gamma",
           "High-grade Nirvana Delta", "High-grade Nirvana Epsilon", "High-grade Nirvana Omega"]
ASCENDANCY = ["High-grade Ascendancy Alpha", "High-grade Ascendancy Beta",
              "High-grade Ascendancy Gamma", "High-grade Ascendancy Delta",
              "High-grade Ascendancy Epsilon", "High-grade Ascendancy Omega"]


def snap(f):
    out = {}
    for k in KEYS:
        try:
            out[k] = f.ship.getModifiedItemAttr(k)
        except Exception:
            out[k] = None
    return out


char = Character("All 5", defaultLevel=5)
fit = Fit()
fit.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
fit.character = char
fit.calculateModifiedAttributes()
base = snap(fit)
print("基线：", base)

print("\nFit 上与 implant 相关的成员：", [n for n in dir(fit) if "implant" in n.lower()])
print("fit.implants 类型/长度：", type(fit.implants), len(fit.implants))

for label, group in (("高级极乐（Nirvana，盾量）", NIRVANA),
                     ("高级圣光（Ascendancy，跃迁速度）", ASCENDANCY)):
    f = Fit()
    f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
    f.character = char
    f.calculateModifiedAttributes()
    before = snap(f)
    for nm in group:
        it = by_name(nm)
        if it is None:
            print(f"  {nm}: 不存在")
            continue
        imp = impmod.Implant(it)
        try:
            f.implants.append(imp)
        except Exception as exc:
            print(f"  挂载 {nm} 失败: {type(exc).__name__}: {exc}")
    f.calculateModifiedAttributes()
    after = snap(f)
    d = {k: (before[k], after[k]) for k in KEYS if before[k] != after[k]}
    print(f"\n{label}（{len(f.implants)} 件）：")
    print("  变化：", d if d else "无变化")
    if d:
        for k, (b, a) in d.items():
            pct = (a / b - 1) * 100 if b else float("nan")
            print(f"    {k}: {b} → {a}  ({pct:+.2f}%)")

print("\n单件脑插（只装 Alpha）对比：")
f = Fit()
f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
f.character = char
f.calculateModifiedAttributes()
before = snap(f)
f.implants.append(impmod.Implant(by_name("High-grade Nirvana Alpha")))
f.calculateModifiedAttributes()
print("  ", {k: (before[k], snap(f)[k]) for k in KEYS if before[k] != snap(f)[k]} or "无变化")

print("\n与指挥脉冲叠加（脑插 + armor_energizing s=5 mindlink=True）：")
import eos.saveddata.commandLink as cl  # noqa: E402
f = Fit()
f.ship = Ship(by_name("Apocalypse Navy Issue"), owner=char)
f.character = char
for nm in NIRVANA:
    f.implants.append(impmod.Implant(by_name(nm)))
f.calculateModifiedAttributes()
before = snap(f)
cl.applyCommandLinkToFit(f, cl.CommandLink("armor_energizing", 5, mindlink=True))
f.calculateModifiedAttributes()
print("  ", {k: (before[k], snap(f)[k]) for k in KEYS if before[k] != snap(f)[k]} or "无变化")
