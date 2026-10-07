"""Expose an installed deployment allowance without changing account credits."""
from fastapi import Depends, Request

from app.api.deps import get_current_user
from app.core.errors import api_error

PAUSED_MESSAGE = 'AI服务已暂停，暂时无法识别、生成或发送新对话。已有伙伴和记录仍可查看，请联系维护者恢复服务。'


def model_availability(request: Request) -> dict:
    budget = getattr(request.app.state, 'model_budget', None)
    if budget is None:
        return {'model_available': True, 'unavailable_message': None}
    state = budget.status()
    available = (state['authorized'] and not state['paused']
                 and state['requests'] < state['requests_max']
                 and state['reserved_cny'] < state['budget_cny'])
    return {'model_available': bool(available),
            'unavailable_message': None if available else PAUSED_MESSAGE}


def require_model_available(request: Request, _user=Depends(get_current_user)):
    state = model_availability(request)
    if not state['model_available']:
        raise api_error(503, 'model_service_paused', PAUSED_MESSAGE)
