"""探查 SDE 里舰船的 group/category 名称，用于把"舰船 → 吨位图标"的映射建在权威数据上。

结论会写回 src/shared/hullclass.ts（吨位归类表）。
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
from eos.gamedata import Group, Category  # noqa: E402

SAMPLES = [
    # 护卫/驱逐/巡洋/战巡/战列（含同吨位不同科技等级）
    "Rifter", "Wolf", "Jaguar", "Punisher", "Retribution",
    "Thrasher", "Sabre", "Flycatcher",
    "Rupture", "Muninn", "Vagabond", "Loki",
    "Hurricane", "Sleipnir", "Cyclone",
    "Tempest", "Maelstrom", "Vargur", "Panther", "Typhoon Fleet Issue",
    "Dominix", "Dominix Navy Issue", "Sin", "Kronos", "Megathron Navy Issue",
    # 工业/运输/货舰
    "Badger", "Prowler", "Bustard", "Charon", "Rhea",
    # 旗舰
    "Phoenix", "Nagfar", "Moros", "Revelation",
    "Apostle", "Minokawa", "Lif", "Ninazu",
    "Archon", "Nidhoggur", "Chimera", "Thanatos",
    "Aeon", "Nyx", "Wyvern", "Hel",
    "Avatar", "Erebus", "Ragnarok", "Leviathan",
    "Colossus", "Lancer",
    # 建筑
    "Fortizar", "Keepstar", "Astrahus", "Raitaru", "Athanor", "Tatara",
    "Standup M-Set", "Mobile Depot", "Upwell Consortium",
    # 穿梭机
    "Impairor", "Ibis", "Velator", "Reaper",
    # 无人机/铁骑（顺带看一眼）
    "Hobgoblin II", "Warrior II", "Templar I", "Dragonfly I", "Firbolg I",
    "Cyclops I", "Malleus I", "Standup Templar I",
]

print("=== 舰船 → group / category ===")
seen = {}
for name in SAMPLES:
    it = edb.gamedata_session.query(Item).filter(Item.name == name).first()
    if it is None:
        print(f"  {name:26s} -> (SDE 中不存在)")
        continue
    g = edb.gamedata_session.query(Group).filter(Group.ID == it.groupID).first()
    c = edb.gamedata_session.query(Category).filter(Category.ID == g.categoryID).first() if g else None
    gname = getattr(g, "name", "?") if g else "?"
    cname = getattr(c, "name", "?") if c else "?"
    pub = getattr(it, "published", None)
    print(f"  {name:26s} -> category={cname!r:16s} group={gname!r:26s} published={pub}")
    seen.setdefault((cname, gname), []).append(name)

print("\n=== raceID / 跳跃引擎（jumpDriveRange） ===")


def raw_attr(item, name):
    at = (getattr(item, "attributes", None) or {}).get(name)
    if at is None:
        return None
    for k in ("value", "baseValue", "modifiedValue"):
        v = getattr(at, k, None)
        if isinstance(v, (int, float)):
            return v
    return None


for name in ("Apocalypse Navy Issue", "Raven", "Phoenix", "Revelation", "Archon",
             "Aeon", "Avatar", "Rhea", "Charon", "Fortizar", "Keepstar", "Rifter"):
    it = edb.gamedata_session.query(Item).filter(Item.name == name).first()
    if it is None:
        print(f"  {name:24s} -> (不存在)")
        continue
    print(f"  {name:24s} raceID={getattr(it, 'raceID', None)!r:6s} "
          f"jumpDriveRange={raw_attr(it, 'jumpDriveRange')}")

print("\n=== 去重后的 (category, group) 组合 ===")
for (cname, gname), names in sorted(seen.items()):
    print(f"  {cname:18s} | {gname:30s} | {', '.join(names[:4])}")
