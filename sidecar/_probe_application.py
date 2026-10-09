"""探查 PYFA 自带的应用率 / 命中率计算模块（避免自行猜测公式）。"""
import inspect
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pyfa_core import boot_core, ensure_core  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
core = ensure_core(os.environ.get("PYFA_DIR", r"D:\eve  pyfa\pyfa"),
                   os.environ.get("PYFA_WORK_DIR", os.path.join(ROOT, ".pyfa-core")))
boot_core(core)

print("=== 先完成 eos 初始化（否则 graphs.* 会因导入顺序触发循环导入）===")
import eos.db as edb  # noqa: E402
edb.saveddata_meta.create_all(edb.saveddata_engine)
for m in ("eos.saveddata.fit", "eos.saveddata.ship", "eos.saveddata.module",
          "eos.saveddata.targetProfile", "eos.saveddata.damagePattern",
          "eos.saveddata.character", "eos.saveddata.drone"):
    try:
        __import__(m, fromlist=["*"])
        print("  ok", m)
    except Exception as exc:
        print("  FAIL", m, type(exc).__name__, exc)

CANDIDATES = [
    "graphs.data.fitDamageStats.calc.application",
    "graphs.data.fitApplicationProfile.calc.launcher",
    "graphs.data.fitApplicationProfile.calc.turret",
    "graphs.data.fitApplicationProfile.getter",
    "graphs.data.fitWarpTime",
]

for name in CANDIDATES:
    print(f"\n=== {name} ===")
    try:
        m = __import__(name, fromlist=["*"])
    except Exception as exc:
        print("  import FAIL:", type(exc).__name__, exc)
        if os.environ.get("DEBUG") == "1":
            traceback.print_exc()
        continue
    print("  file:", getattr(m, "__file__", "?"))
    pub = [a for a in dir(m) if not a.startswith("_")]
    print("  public:", pub)
    for a in pub:
        obj = getattr(m, a)
        if inspect.isfunction(obj) and getattr(obj, "__module__", "") == name:
            try:
                print(f"    def {a}{inspect.signature(obj)}")
            except Exception:
                pass
