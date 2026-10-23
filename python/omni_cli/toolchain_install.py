"""OMNI 工具链离线安装器。

由独立 ``omni-toolchain.exe`` 调用，也可以由 ``omni toolchain install`` 复用。

清单 ``tools.json`` 示例::

    {
      "schema": 1,
      "tools": [
        {
          "name": "cmake",
          "version": "3.31.2",
          "archive": "cmake-3.31.2-windows-x86_64.zip",
          "source": "cmake-3.31.2-windows-x86_64",
          "target": "cmake",
          "probe": "bin/cmake.exe",
          "sha256": "..."
        }
      ]
    }

安装目录默认 ``%LOCALAPPDATA%/OMNI/toolchains``，可用 ``OMNI_TOOLCHAIN_HOME``
或 ``--install-dir`` 覆盖。安装是用户级的，不需要管理员权限。
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import shutil
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Optional

MANIFEST_NAME = "tools.json"
LOCK_NAME = "lock.json"


def default_home() -> str:
    env = os.environ.get("OMNI_TOOLCHAIN_HOME")
    if env:
        return os.path.abspath(env)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(
            os.path.expanduser("~"), ".local", "share"
        )
    return os.path.join(base, "OMNI", "toolchains")


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_extract(archive: str, dest: str) -> None:
    dest_abs = os.path.abspath(dest)
    with zipfile.ZipFile(archive) as zf:
        for member in zf.infolist():
            target = os.path.abspath(os.path.join(dest_abs, member.filename))
            if target != dest_abs and not target.startswith(dest_abs + os.sep):
                raise RuntimeError(f"压缩包包含非法路径: {member.filename}")
        zf.extractall(dest_abs)


def _remove(path: str) -> None:
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path, ignore_errors=True)
    elif os.path.exists(path):
        os.remove(path)


def _rel_path(base: str, relative: str) -> str:
    return os.path.join(base, *[part for part in relative.replace("\\", "/").split("/") if part])


def _target_path(entry: dict, install_dir: str) -> str:
    return _rel_path(install_dir, entry["target"])


def _probe_path(entry: dict, install_dir: str) -> Optional[str]:
    probe = entry.get("probe")
    if not probe:
        return None
    return _rel_path(_target_path(entry, install_dir), probe)


def _is_installed(entry: dict, install_dir: str) -> bool:
    probe = _probe_path(entry, install_dir)
    return bool(probe and os.path.exists(probe))


def _load_manifest(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    tools = data.get("tools")
    if not isinstance(tools, list) or not tools:
        raise RuntimeError(f"清单里没有 tools: {path}")
    for entry in tools:
        if not isinstance(entry, dict) or not entry.get("name") or not entry.get("target"):
            raise RuntimeError(f"清单条目缺少 name/target: {entry!r}")
        if not entry.get("archive") and not entry.get("dir"):
            raise RuntimeError(f"{entry.get('name')}: 需要 archive 或 dir")
    return data


def _find_manifest(explicit: Optional[str], offline: Optional[str]) -> str:
    candidates = []
    if explicit:
        candidates.append(explicit)
    if offline:
        candidates.append(os.path.join(offline, MANIFEST_NAME))
        # 离线包 zip 常有单层/双层顶层目录。
        candidates.extend(glob.glob(os.path.join(offline, "*", MANIFEST_NAME)))
        candidates.extend(glob.glob(os.path.join(offline, "*", "*", MANIFEST_NAME)))
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    candidates.append(os.path.join(exe_dir, MANIFEST_NAME))
    candidates.append(os.path.join(os.getcwd(), MANIFEST_NAME))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return os.path.abspath(candidate)
    raise RuntimeError(
        f"找不到 {MANIFEST_NAME}；用 --manifest 指定，或把它放在离线包目录/安装器旁边"
    )


def _read_lock(install_dir: str) -> dict:
    path = os.path.join(install_dir, LOCK_NAME)
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle) or {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_lock(install_dir: str, lock: dict) -> None:
    os.makedirs(install_dir, exist_ok=True)
    path = os.path.join(install_dir, LOCK_NAME)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(lock, handle, ensure_ascii=False, indent=2)
    os.replace(temp, path)


def _install_entry(entry: dict, offline: str, install_dir: str,
                   force: bool, log) -> tuple[str, dict]:
    name = entry["name"]
    version = entry.get("version", "")
    target = _target_path(entry, install_dir)

    if _is_installed(entry, install_dir) and not force:
        log(f"skip {name} {version}（已安装）")
        return "skipped", {"name": name, "version": version, "target": target}

    archive = entry.get("archive")
    directory = entry.get("dir")
    source_rel = entry.get("source", "")
    mode = entry.get("mode", "tree")

    temp_extract = None
    backup = None
    staging = target + ".tmp-" + uuid.uuid4().hex
    try:
        if archive:
            archive_path = archive if os.path.isabs(archive) else os.path.join(offline, archive)
            if not os.path.isfile(archive_path):
                raise RuntimeError(f"{name}: 找不到压缩包 {archive_path}")
            expected = entry.get("sha256")
            actual = _sha256(archive_path)
            if expected and actual.lower() != str(expected).lower():
                raise RuntimeError(
                    f"{name}: SHA256 不匹配\n  期望 {expected}\n  实际 {actual}"
                )
            if not expected:
                log(f"warning {name}: 清单未提供 sha256，跳过校验")
            temp_extract = tempfile.mkdtemp(prefix=f".{name}-", dir=install_dir)
            _safe_extract(archive_path, temp_extract)
            source_root = temp_extract
        elif directory:
            source_root = directory if os.path.isabs(directory) else os.path.join(offline, directory)
            if not os.path.isdir(source_root):
                raise RuntimeError(f"{name}: 找不到目录 {source_root}")
        else:
            raise RuntimeError(f"{name}: 需要 archive 或 dir")

        source = _rel_path(source_root, source_rel) if source_rel else source_root
        os.makedirs(os.path.dirname(target), exist_ok=True)
        _remove(staging)

        if mode == "file":
            file_rel = entry.get("file")
            if not file_rel:
                raise RuntimeError(f"{name}: mode=file 需要 file 字段")
            source_file = _rel_path(source, file_rel)
            if not os.path.isfile(source_file):
                raise RuntimeError(f"{name}: 找不到文件 {source_file}")
            os.makedirs(staging, exist_ok=True)
            shutil.copy2(source_file, os.path.join(staging, os.path.basename(file_rel)))
        else:
            if not os.path.isdir(source):
                raise RuntimeError(f"{name}: 找不到目录 {source}")
            shutil.copytree(source, staging)

        # 目标存在时先备份，move 失败可以恢复。
        if os.path.exists(target):
            backup = target + ".old-" + uuid.uuid4().hex
            os.replace(target, backup)
        os.replace(staging, target)
        if backup and os.path.exists(backup):
            _remove(backup)
            backup = None

        log(f"installed {name} {version} -> {target}")
        return "installed", {"name": name, "version": version, "target": target}
    except Exception:
        if backup and os.path.exists(backup) and not os.path.exists(target):
            try:
                os.replace(backup, target)
            except OSError:
                pass
        raise
    finally:
        _remove(staging)
        if temp_extract:
            _remove(temp_extract)


def _cmd_list(manifest: dict, install_dir: str, as_json: bool) -> int:
    rows = []
    for entry in manifest["tools"]:
        target = _target_path(entry, install_dir)
        rows.append({
            "name": entry["name"],
            "version": entry.get("version", ""),
            "installed": _is_installed(entry, install_dir),
            "target": target,
            "probe": _probe_path(entry, install_dir),
        })
    if as_json:
        print(json.dumps({"install_dir": install_dir, "tools": rows}, ensure_ascii=False, indent=2))
        return 0
    print(f"install dir: {install_dir}")
    for row in rows:
        status = "installed" if row["installed"] else "missing"
        print(f"  {row['name']:<20} {row['version']:<12} {status:<10} {row['target']}")
    return 0


def _cmd_verify(manifest: dict, install_dir: str, as_json: bool) -> int:
    missing = []
    for entry in manifest["tools"]:
        if not _is_installed(entry, install_dir):
            missing.append({
                "name": entry["name"],
                "version": entry.get("version", ""),
                "target": _target_path(entry, install_dir),
                "probe": _probe_path(entry, install_dir),
            })
    success = not missing
    if as_json:
        print(json.dumps({
            "success": success, "install_dir": install_dir, "missing": missing,
        }, ensure_ascii=False, indent=2))
    else:
        if success:
            print(f"toolchains OK: {install_dir}")
        else:
            print(f"缺少 {len(missing)} 个工具（{install_dir}）：")
            for item in missing:
                print(f"  {item['name']} {item['version']} -> {item['probe']}")
    return 0 if success else 1


def _cmd_install(manifest: dict, offline: str, install_dir: str,
                 force: bool, silent: bool, as_json: bool) -> int:
    os.makedirs(install_dir, exist_ok=True)
    log = (lambda message: None) if silent else print
    installed = []
    skipped = []
    errors = []

    for entry in manifest["tools"]:
        try:
            status, info = _install_entry(entry, offline, install_dir, force, log)
            (installed if status == "installed" else skipped).append(info)
        except Exception as exc:  # 单个工具失败不阻塞其它工具，但最终返回非 0
            errors.append({"name": entry.get("name"), "error": str(exc)})
            print(f"error {entry.get('name')}: {exc}", file=sys.stderr)

    lock = _read_lock(install_dir)
    lock.update({
        "schema": 1,
        "install_dir": os.path.abspath(install_dir),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    tools = lock.get("tools") or {}
    for info in installed + skipped:
        tools[info["name"]] = info
    lock["tools"] = tools
    _write_lock(install_dir, lock)

    success = not errors
    if as_json:
        print(json.dumps({
            "success": success,
            "install_dir": os.path.abspath(install_dir),
            "installed": installed,
            "skipped": skipped,
            "errors": errors,
        }, ensure_ascii=False, indent=2))
    elif not silent:
        print(
            f"done: installed {len(installed)}, skipped {len(skipped)}, "
            f"errors {len(errors)} -> {os.path.abspath(install_dir)}"
        )
    return 0 if success else 1


def main(argv: Optional[list] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass
    parser = argparse.ArgumentParser(
        prog="omni-toolchain",
        description="OMNI 工具链离线安装器",
    )
    parser.add_argument("--manifest", default=None, help="tools.json 路径")
    parser.add_argument("--offline", default=None, help="离线包目录（压缩包/解压目录 + tools.json）")
    parser.add_argument("--install-dir", default=None, help="安装目录（默认 %%LOCALAPPDATA%%/OMNI/toolchains）")
    parser.add_argument("--force", action="store_true", help="覆盖已安装的工具")
    parser.add_argument("--only", action="append", default=None,
                        help="只处理指定工具（可重复；用于测试/局部安装）")
    parser.add_argument("--list", action="store_true", help="列出清单与安装状态")
    parser.add_argument("--verify", action="store_true", help="只校验已安装的工具")
    parser.add_argument("--silent", action="store_true", help="静默模式（只输出错误）")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    args = parser.parse_args(argv)

    offline_temp = None
    rc = 2
    try:
        offline_arg = args.offline
        if offline_arg and os.path.isfile(offline_arg):
            if not offline_arg.lower().endswith(".zip"):
                raise RuntimeError(f"--offline 只支持目录或 .zip：{offline_arg}")
            offline_temp = tempfile.mkdtemp(prefix="omni-offline-")
            _safe_extract(offline_arg, offline_temp)
            offline = offline_temp
        else:
            offline = os.path.abspath(offline_arg) if offline_arg else None

        manifest_path = _find_manifest(args.manifest, offline)
        if not offline:
            offline = os.path.dirname(manifest_path)
        install_dir = os.path.abspath(args.install_dir or default_home())
        manifest = _load_manifest(manifest_path)
        if args.only:
            wanted = set(args.only)
            manifest["tools"] = [entry for entry in manifest["tools"] if entry["name"] in wanted]
            if not manifest["tools"]:
                raise RuntimeError(f"--only 没有匹配到工具: {', '.join(sorted(wanted))}")

        if args.list:
            rc = _cmd_list(manifest, install_dir, args.json)
        elif args.verify:
            rc = _cmd_verify(manifest, install_dir, args.json)
        else:
            rc = _cmd_install(manifest, offline, install_dir, args.force, args.silent, args.json)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
    finally:
        if offline_temp:
            _remove(offline_temp)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
