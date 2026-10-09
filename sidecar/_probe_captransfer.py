"""探查远程电容传输装置 / 远程维修模块的效果名与效果量属性。"""
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
edb.saveddata_meta.create_all(edb.saveddata_engine)
from eos.gamedata import Item  # noqa: E402
from eos.saveddata.character import Character  # noqa: E402
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.module import Module  # noqa: E402
from eos.saveddata.ship import Ship  # noqa: E402
from eos.const import FittingModuleState  # noqa: E402

char = Character("All 5", defaultLevel=5)


def q(name):
    return edb.gamedata_session.query(Item).filter(Item.name == name).first()


NAMES = [
    "Large Remote Capacitor Transmitter II",
    "Large Remote Armor Repairer II",
    "Large Remote Shield Booster II",
    "Small Energy Neutralizer II",
    "Stasis Webifier II",
    "Target Painter II",
]

for name in NAMES:
    it = q(name)
    print(f"\n=== {name} (ID={getattr(it, 'ID', None)}) ===")
    if it is None:
        print("  not found")
        continue
    effs = list(it.effects.values()) if hasattr(it.effects, "values") else list(it.effects or [])
    print("  effects:", [getattr(e, "name", None) for e in effs])
    fit = Fit()
    fit.ship = Ship(q("Apocalypse Navy Issue"), owner=char)
    fit.character = char
    m = Module(it)
    fit.modules.append(m)
    m.state = FittingModuleState.ACTIVE
    fit.calculateModifiedAttributes()
    keys = ("duration", "capacitorNeed", "maxRange", "falloff", "powerTransferAmount",
            "armorDamageAmount", "shieldBonus", "structureDamageAmount",
            "energyNeutralizerAmount", "energyNosferatuAmount",
            "speedFactor", "signatureRadiusBonus", "trackingSpeedBonus", "scanResolutionBonus")
    out = {}
    for k in keys:
        try:
            v = m.getModifiedItemAttr(k)
            if v not in (None, 0):
                out[k] = v
        except Exception:
            pass
    print("  attrs:", out)
