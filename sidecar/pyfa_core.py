"""PYFA 无头核心：从 PYFA 安装目录提取/引导计算核心。

本模块只做两件事，不涉及推演逻辑：
  1. ensure_core()  —— 从 <pyfaDir>/pyfa.exe 提取纯 Python 模块，并与 app/ 的二进制合并，
                       产出一个可直接加入 sys.path 的"无头核心目录"。
  2. boot_core()    —— 把该目录与 app/ 加入 sys.path，并提供 SDE 连接配置。

约束：
  * 任何诊断信息一律走 stderr；stdout 留给 JSON 行协议（见 pyfa_oracle.py）。
  * 不修改 PYFA 的任何文件（只读 pyfa.exe / app/）。
"""
from __future__ import annotations

import importlib.util
import json
import marshal
import os
import shutil
import struct
import sys
import zlib

MAGIC = b"MEI\014\013\012\013\016"
_SKIP_COPY = {"eve.db"}
_META_NAME = "core.meta.json"


def _log_default(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# CArchive / PYZ 解析（格式详见 docs/第4章-PYFA集成协议-冻结稿.md §4.1）
# --------------------------------------------------------------------------- #
def _parse_carchive(data: bytes) -> dict:
    pos = data.rfind(MAGIC)
    if pos < 0:
        raise ValueError("不是 PyInstaller 归档（未找到魔数）")
    p = pos + 8
    pkg_len = struct.unpack("!i", data[p:p + 4])[0]
    toc_off = struct.unpack("!i", data[p + 4:p + 8])[0]
    toc_len = struct.unpack("!i", data[p + 8:p + 12])[0]
    pyvers = struct.unpack("!i", data[p + 12:p + 16])[0]
    pylib = data[p + 16:p + 36].split(b"\x00", 1)[0].decode("ascii", "replace")
    arch_start = len(data) - pkg_len
    toc_pos = arch_start + toc_off
    if toc_pos + toc_len != pos or arch_start + pkg_len != len(data):
        raise ValueError("CArchive 头部自洽性校验失败")
    return {"arch_start": arch_start, "toc_pos": toc_pos, "toc_len": toc_len,
            "pyvers": pyvers, "pylibname": pylib}


def _parse_toc(data: bytes, toc_pos: int, toc_len: int) -> list:
    entries, pos, end = [], toc_pos, toc_pos + toc_len
    while pos < end - 1:
        entry_len = struct.unpack("!i", data[pos:pos + 4])[0]
        if entry_len <= 0 or pos + entry_len > end:
            break
        off = struct.unpack("!i", data[pos + 4:pos + 8])[0]
        clen = struct.unpack("!i", data[pos + 8:pos + 12])[0]
        ulen = struct.unpack("!i", data[pos + 12:pos + 16])[0]
        raw = data[pos + 17:pos + entry_len].split(b"\x00", 1)[0].decode("utf-8", "replace")
        entries.append({"typecode": raw[:1], "name": raw[1:],
                        "offset": off, "clen": clen, "ulen": ulen})
        pos += entry_len
    return entries


def _read_entry(data: bytes, arch_start: int, e: dict) -> bytes:
    raw = data[arch_start + e["offset"]: arch_start + e["offset"] + e["clen"]]
    return zlib.decompress(raw) if e["clen"] < e["ulen"] else raw


def _parse_pyz(blob: bytes) -> dict:
    if blob[:4] != b"PYZ\0":
        raise ValueError("PYZ 魔数不匹配")
    toc = marshal.loads(blob[struct.unpack("!i", blob[8:12])[0]:])
    items = list(toc.items()) if isinstance(toc, dict) else list(toc)
    modules = {}
    for name, val in items:
        pairs = []
        if isinstance(val, (tuple, list)):
            if len(val) >= 3:
                pairs = [(val[1], val[2]), (val[0], val[1])]
            elif len(val) == 2:
                pairs = [(val[0], val[1])]
        for pos, length in pairs:
            if not (0 <= pos < len(blob)) or length <= 0 or pos + length > len(blob):
                continue
            try:
                body = zlib.decompress(blob[pos:pos + length])
                marshal.loads(body)          # 校验
                modules[name] = body
                break
            except Exception:
                continue
    return modules


# --------------------------------------------------------------------------- #
# 提取 / 合并 / 版本
# --------------------------------------------------------------------------- #
def read_version(pyfa_dir: str) -> str:
    """读取 <pyfaDir>/app/version.yml 中的 version。"""
    path = os.path.join(pyfa_dir, "app", "version.yml")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                if line.strip().startswith("version:"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return ""


def extract_modules(pyfa_exe: str, out_dir: str, log=_log_default) -> int:
    """从 pyfa.exe 提取全部 Python 模块（写成 .pyc）。返回模块数。"""
    with open(pyfa_exe, "rb") as fh:
        data = fh.read()
    info = _parse_carchive(data)
    log(f"[core] pylibname={info['pylibname']} pyvers={info['pyvers']}")
    entries = _parse_toc(data, info["toc_pos"], info["toc_len"])
    pyz = next((e for e in entries if e["typecode"] in ("z", "Z")), None)
    if pyz is None:
        raise ValueError("归档中未找到 PYZ")

    modules = _parse_pyz(_read_entry(data, info["arch_start"], pyz))
    log(f"[core] PYZ 模块数 = {len(modules)}")

    packages = set()
    for name in modules:
        parts = name.split(".")
        for i in range(1, len(parts)):
            packages.add(".".join(parts[:i]))

    header = importlib.util.MAGIC_NUMBER + b"\x00" * 12
    for name, code in modules.items():
        parts = name.split(".")
        path = (os.path.join(out_dir, *parts, "__init__.pyc") if name in packages
                else os.path.join(out_dir, *parts) + ".pyc")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as w:
            w.write(header + code)
    return len(modules)


def merge_binaries(app_dir: str, out_dir: str, log=_log_default) -> int:
    """把 app/ 下的编译扩展与数据合并进核心目录（跳过 eve.db 与 .py/.pyc）。"""
    n = 0
    for root, _dirs, files in os.walk(app_dir):
        rel = os.path.relpath(root, app_dir)
        dst_root = out_dir if rel == "." else os.path.join(out_dir, rel)
        os.makedirs(dst_root, exist_ok=True)
        for f in files:
            if f in _SKIP_COPY or f.endswith((".py", ".pyc")):
                continue
            dst = os.path.join(dst_root, f)
            if os.path.exists(dst):
                continue
            try:
                shutil.copy2(os.path.join(root, f), dst)
                n += 1
            except OSError as exc:
                log(f"[core] 跳过 {f}: {exc}")
    return n


def ensure_core(pyfa_dir: str, work_dir: str, log=_log_default) -> dict:
    """确保无头核心就绪；返回 {version, modulesDir, appDir, dbPath, pyfaExe}。"""
    pyfa_dir = os.path.abspath(pyfa_dir)
    app_dir = os.path.join(pyfa_dir, "app")
    pyfa_exe = os.path.join(pyfa_dir, "pyfa.exe")
    db_path = os.path.join(app_dir, "eve.db")

    if not os.path.isfile(pyfa_exe):
        raise FileNotFoundError(f"未找到 {pyfa_exe}")
    if not os.path.isfile(db_path):
        raise FileNotFoundError(f"未找到 {db_path}")

    version = read_version(pyfa_dir)
    modules_dir = os.path.join(work_dir, "modules")
    meta_path = os.path.join(work_dir, _META_NAME)

    stamp = {"version": version, "exeSize": os.path.getsize(pyfa_exe)}
    fresh = False
    if os.path.isfile(meta_path) and os.path.isdir(modules_dir):
        try:
            with open(meta_path, "r", encoding="utf-8") as fh:
                fresh = json.load(fh) == stamp
        except (OSError, ValueError):
            fresh = False

    if not fresh:
        log(f"[core] 提取无头核心（PYFA {version or '未知版本'}）→ {modules_dir}")
        if os.path.isdir(modules_dir):
            shutil.rmtree(modules_dir)
        os.makedirs(modules_dir, exist_ok=True)
        count = extract_modules(pyfa_exe, modules_dir, log)
        merged = merge_binaries(app_dir, modules_dir, log)
        os.makedirs(work_dir, exist_ok=True)
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(stamp, fh)
        log(f"[core] 完成：{count} 个模块，合并 {merged} 个二进制/数据文件")

    return {"version": version, "modulesDir": modules_dir, "appDir": app_dir,
            "dbPath": db_path, "pyfaExe": pyfa_exe}


def boot_core(core: dict, log=_log_default) -> None:
    """把核心加入 sys.path 并配置 SDE 连接串（必须在 import eos.db 之前调用）。"""
    sys.path.insert(0, core["appDir"])
    sys.path.insert(0, core["modulesDir"])

    # saveddata 库目录必须先存在，否则 Ship() 会报 unable to open database file
    os.makedirs(os.path.join(core["modulesDir"], "saveddata"), exist_ok=True)

    import eos.config as eos_config
    eos_config.gamedata_connectionstring = "sqlite:///" + core["dbPath"].replace("\\", "/")
    eos_config.saveddata_connectionstring = "sqlite:///" + os.path.join(
        core["modulesDir"], "saveddata", "saveddata.db").replace("\\", "/")
    log("[core] SDE 连接串已配置")
