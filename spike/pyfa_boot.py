"""SPIKE-001 引导模块：在无 GUI 环境准备好 PYFA 计算核心的导入环境。

- 把提取出的纯 Python 模块目录与 PYFA 的 app/（二进制/数据）加入 sys.path。
- 将 app/ 下的编译扩展与数据文件并入模块目录（首次运行时一次性合并），
  使 eos.db / config / cryptography / wx / sqlalchemy 等可正常导入。
  （跳过 eve.db 本身，避免无谓的大文件复制。）
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODULES_DIR = os.path.join(HERE, "pyfa_modules")
APP_DIR = r"D:\eve  pyfa\pyfa\app"

_MARKER = os.path.join(MODULES_DIR, ".merged_from_app")
_SKIP_NAMES = {"eve.db"}


def _merge_app(verbose=True):
    if os.path.exists(_MARKER):
        return
    n = 0
    for root, dirs, files in os.walk(APP_DIR):
        rel = os.path.relpath(root, APP_DIR)
        if rel == ".":
            rel = ""
        dst_root = os.path.join(MODULES_DIR, rel) if rel else MODULES_DIR
        os.makedirs(dst_root, exist_ok=True)
        for f in files:
            if f in _SKIP_NAMES or f.endswith((".py", ".pyc")):
                continue
            src = os.path.join(root, f)
            dst = os.path.join(dst_root, f)
            if os.path.exists(dst):
                continue
            try:
                shutil.copy2(src, dst)
                n += 1
            except Exception as e:
                print(f"[boot] copy skipped {src}: {e}")
    with open(_MARKER, "w", encoding="utf-8") as fh:
        fh.write(str(n))
    if verbose:
        print(f"[boot] merged {n} binary/data files from app/ -> pyfa_modules/")


_booted = False


def boot(verbose=True):
    global _booted
    if _booted:
        return
    sys.path.insert(0, APP_DIR)
    sys.path.insert(0, MODULES_DIR)
    _merge_app(verbose)
    _booted = True
    if verbose:
        print("[boot] ready; MODULES_DIR =", MODULES_DIR)
