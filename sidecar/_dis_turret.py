"""反汇编炮台的射程系数与组合函数。"""
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
for m in ("eos.saveddata.fit", "eos.saveddata.ship", "eos.saveddata.module", "eos.saveddata.character"):
    __import__(m, fromlist=["*"])

from graphs.data.fitApplicationProfile.calc import turret as T  # noqa: E402
from graphs.data.fitDamageStats.calc import application as A  # noqa: E402

for fn in (T.calculateRangeFactor, A.getTurretMult, A.getLauncherMult, A.getDroneMult):
    print(f"\n===== {getattr(fn, '__module__', '?')}.{fn.__name__} =====")
    print("  doc:", (fn.__doc__ or "").strip()[:400])
    print("  consts:", [c for c in fn.__code__.co_consts if isinstance(c, (int, float, str))])
    print("  names:", fn.__code__.co_names)
    dis.dis(fn)
