"""反汇编 PYFA 的命中/应用率核心函数，取得权威公式。"""
import dis
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
for m in ("eos.saveddata.fit", "eos.saveddata.ship", "eos.saveddata.module",
          "eos.saveddata.targetProfile", "eos.saveddata.character"):
    __import__(m, fromlist=["*"])

from graphs.data.fitApplicationProfile.calc import launcher as L  # noqa: E402
from graphs.data.fitApplicationProfile.calc import turret as T  # noqa: E402


def dump(fn, note=""):
    print(f"\n===== {fn.__module__}.{fn.__qualname__} {note} =====")
    print("  常量:", [c for c in fn.__code__.co_consts if isinstance(c, (int, float, str))])
    dis.dis(fn)


dump(L.calcMissileFactor)
dump(T.calcTrackingFactor)
dump(T.calcTurretDamageMult)
dump(T.calcAngularSpeed)

print("\n===== L.getLauncherMult / L.getApplicationMultipliers 常量与名字 =====")
for fn in (L.getLauncherMult, L.getApplicationMultipliers, L.getDamageMultipliers, L.getAllMultipliers):
    try:
        print(f"  {fn.__name__}: consts={[c for c in fn.__code__.co_consts if isinstance(c, (int,float,str))]}")
    except Exception as exc:
        print("  ", fn, exc)
