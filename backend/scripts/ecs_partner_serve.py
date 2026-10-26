"""Production entry point for the isolated partner deployment on the shared ECS."""
import os
from pathlib import Path

from fastapi import Depends
from fastapi.responses import JSONResponse
from starlette.routing import Mount

from app.api.deps import get_current_user
from app.core.config import get_settings
from app.main import app
from app.services.transcription_config import transcription_status
from app.services.daily_model_quota import DailyModelQuota, DailyQuotaExceeded, install_httpx_quota

settings = get_settings()
if settings.app_env != 'production' or settings.auth_mode != 'invite' or settings.model_max_retries != 0:
    raise ValueError('Partner production requires invite login and zero model retries')
if settings.voice_live_reply_enabled:
    raise ValueError('Unaccepted live voice replies must remain disabled')
whisper_configured = transcription_status(settings.voice_local_model_path) == 'configured'
if settings.voice_local_model_path and not whisper_configured:
    raise ValueError('Configured local transcription requires complete offline prerequisites')
quota = DailyModelQuota(Path(os.environ['PARTNER_DAILY_QUOTA_DB']),
                        int(os.environ['PARTNER_DAILY_REQUEST_LIMIT']))
install_httpx_quota(quota, [settings.model_base_url, settings.image_base_url, settings.motion_atlas_base_url])
app.state.daily_model_quota = quota
from app.services.trial_wiring import configure_trials  # noqa: E402
from app.core.database import engine  # noqa: E402
from app.api import voice  # noqa: E402
try:
    trials = configure_trials(engine, settings, quota, os.environ)
except Exception:
    # Invalid/expired trial state must stop that trial, not take the site down.
    trials = {'voice': None, 'life': None, 'blocked': True}
if trials['voice'] is not None:
    voice.service = trials['voice']
from app.services.life_dispatch import install as install_life_dispatch  # noqa: E402
def stop_trial_life_policies(scopes):
    from uuid import uuid4
    from app.api import life_runtime, gatherings
    errors = []
    private = scopes.get('private_life')
    try:
        current = life_runtime.live_runtime.snapshot(private['owner'], private['subject']) if private else None
        if current and current.automatic and current.automatic.enabled:
            life_runtime.live_runtime.save_automatic(private['owner'], private['subject'], str(uuid4()),
                                                     current.automatic.revision, False)
    except Exception:
        errors.append('private')
    shared = scopes['shared_life']
    try:
        current = gatherings.automatic_store.status(shared['owner'], shared['subject'])
        if current['enabled']:
            gatherings.automatic_store.configure(shared['owner'], shared['subject'], str(uuid4()),
                                                  current['revision'], False)
    except Exception:
        errors.append('shared')
    if errors:
        raise RuntimeError('trial_life_policy_stop_incomplete')


install_life_dispatch(trials.get('shared_dialogue') or trials['life'], blocked=trials.get('blocked', False), on_stop=stop_trial_life_policies)
app.state.trial_life_factories = trials.get('shared_dialogue') or trials['life']  # No worker is started by installation.


@app.exception_handler(DailyQuotaExceeded)
async def exhausted(_request, _error):
    from app.services.daily_model_quota import DAILY_LIMIT_MESSAGE
    return JSONResponse(status_code=429, content={'error': {'code': 'daily_model_limit', 'message': DAILY_LIMIT_MESSAGE}},
                        headers={'Cache-Control': 'no-store'})


@app.get('/healthz', include_in_schema=False)
def health():
    return {'ok': True, 'service': 'wanwu-partner'}


@app.get('/api/v1/deployment-check')
def deployment_check(_user=Depends(get_current_user)):
    return {'release': 'ecs-partner-20261015', 'service_mode': 'normal',
            'whisper_enabled': whisper_configured, 'daily_model_requests': quota.status(),
            'voice_trial_ready': trials['voice'] is not None, 'life_trial_ready': trials['life'] is not None,
            'shared_dialogue_trial_ready': trials.get('shared_dialogue') is not None,
            'trial_configuration_blocked': trials.get('blocked', False)}


# app.main registers its HTML fallback before these deployment-only endpoints.
# Keep that catch-all mount last so it cannot swallow health or protected checks.
for route in list(app.router.routes):
    if isinstance(route, Mount) and route.path == '':
        app.router.routes.remove(route)
        app.router.routes.append(route)
