"""Scoped project adapters for the explicitly selected local companion review.

Never populates the global model key, grants budgets, or enables automatic life.
Production continues to use its normal configured factories.
"""
from pathlib import Path

from dotenv import dotenv_values

from app.core.errors import api_error
from app.living.gathering_dialogue import MaaSDialogueAdapter
from app.living.life_live_planner import check_current_catalog, run_real_planner
from app.living.life_provider import BASE_URL, MaaSLifePlannerAdapter

BACKEND = Path(__file__).resolve().parents[1]


def project_key():
    try:
        values = dotenv_values(BACKEND / '.env')
        key = values.get('MODEL_API_KEY')
        if values.get('MODEL_BASE_URL') != BASE_URL or not isinstance(key, str) or not key.strip():
            raise ValueError()
        return key
    except (OSError, ValueError, TypeError):
        raise api_error(503, 'configuration_error', '本项目真实生活模型配置未准备好') from None


def check_configuration(selected):
    if selected.origin != 'real_provider':
        raise api_error(409, 'configuration_error', '此体验入口只执行已授权的真实生活任务')
    project_key()


async def execute_requested(selected, owner, space_id, task_id):
    # Resolve ownership before any credential access; the runner reserves budget
    # before its factory is allowed to construct the provider client.
    selected.read_task(owner, space_id, task_id)
    if selected.origin != 'real_provider':
        raise api_error(409, 'configuration_error', '此体验入口只执行已授权的真实生活任务')
    await run_real_planner(selected, owner, space_id, task_id,
                           lambda: MaaSLifePlannerAdapter(project_key()), check_current_catalog)


def dialogue_available():
    try:
        project_key()
        return True
    except Exception:
        return False


def dialogue_client():
    return MaaSDialogueAdapter(project_key())


def install(*, shared_automatic=False):
    from app.api import gatherings, life_runtime
    from app.core.config import get_settings
    settings = get_settings()
    expected = BACKEND.parent / '.runtime/c160-review/check.db'
    if (type(shared_automatic) is not bool or settings.app_env != 'test' or settings.database_url != f'sqlite:///{expected}'
            or settings.model_api_key or not settings.life_live_planner_preview_enabled):
        raise ValueError('Scoped life adapters require the explicit local review environment')
    if shared_automatic:
        # Validate before installing any factory. This opt-in only exposes the
        # existing persistent worker; grants and owner consent remain mandatory.
        project_key()
    life_runtime.check_live_configuration = check_configuration
    life_runtime.execute_requested = execute_requested
    gatherings.dialogue_available = dialogue_available
    gatherings.dialogue_client = dialogue_client
    if shared_automatic:
        gatherings.automatic_available = dialogue_available
