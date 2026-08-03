# 贡献指南

欢迎为 OMNI Link 贡献代码、报告问题或提出建议。

## 报告问题

通过 [GitHub Issues](https://github.com/LuckkMaker/omni-link/issues) 提交问题，请包含以下信息：

- 操作系统版本
- 目标 MCU 型号与仿真器类型
- 复现步骤与预期行为
- 日志输出（如有）

## 开发环境

```bash
# 克隆仓库
git clone https://github.com/LuckkMaker/omni-link.git
cd omni-link

# 安装前端依赖
npm install

# 创建 Python 虚拟环境
npm run python:install

# 启动开发模式
npm run dev
```

开发环境要求 Node.js 20+ 和 Python 3.11+。

## 代码结构

- `electron/` — Electron 主进程（窗口管理、Python 子进程）
- `src/` — React 渲染进程（页面、组件、状态管理）
- `python/` — Python 后端（FastAPI + pyOCD）
- `docs/` — 文档（MkDocs 站点）

详细结构见 [技术栈与系统架构](tech/architecture.md)。

## 提交代码

1. Fork 仓库并创建特性分支
2. 修改代码，确保 `npm run typecheck` 通过
3. 提交 Pull Request 到 `main` 分支

## 文档维护

文档使用 MkDocs 构建，配置文件为 `mkdocs.yml`。本地预览：

```bash
pip install mkdocs
mkdocs serve
```

访问 `http://127.0.0.1:8000` 查看文档站点。
