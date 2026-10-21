"""OMNI 工程配置能力（本地执行，不经过 OMNI Link 后端）。"""

from .context import ProjectContext, ProjectError, resolve_context

__all__ = ["ProjectContext", "ProjectError", "resolve_context"]
