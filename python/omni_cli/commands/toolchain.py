"""查看构建工具链解析结果：显式目录/共享目录/内置 tools 优先，缺项回退系统 PATH。"""

import json

from .. import toolchain


def add_parser(sub):
    p = sub.add_parser("toolchain", help="显示 cmake/ninja/编译器/工具的解析来源")
    p.add_argument("--json", dest="json_", action="store_true", help="输出 JSON")
    p.set_defaults(func=_run)


def _run(args) -> int:
    data = toolchain.describe()
    if args.json_:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0

    roots = data.get("roots") or []
    if roots:
        for item in roots:
            print(f"root  {item.get('kind', '-'):<8} {item.get('path', '')}")
    else:
        print("root  (没有工具目录，全部使用系统 PATH)")
    print(f"shared {data.get('shared_root', '-')}")
    for name, info in data["tools"].items():
        path = info.get("path") or "-"
        print(f"  {name:<20} {info.get('source', '-'):<8} {path}")
    return 0
