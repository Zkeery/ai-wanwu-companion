"""Provider selection for product routes and workers, default closed in production."""
from app.core.config import get_settings
from app.living.rules import LivingError
from app.services.trial_gate import TrialBlocked

_factories = None
_blocked = False
_on_stop = None


def install(factories=None, *, blocked=False, on_stop=None):
    global _factories, _blocked, _on_stop
    _factories, _blocked, _on_stop = factories, blocked, on_stop


def halt(factories, on_stop):
    if factories is None:
        return
    try:
        factories.gate.stop('product_life_dispatch_stopped')
    except TrialBlocked:
        pass
    if on_stop:
        try:
            on_stop(factories.gate.policy['scopes'])
        except Exception:
            import logging
            logging.getLogger(__name__).warning('trial_life_policy_stop_incomplete')


def adapter(kind, owner, subject, operation, *, presence, fallback):
    if _blocked:
        raise LivingError('configuration_error', '受限生活配置不可用，本轮没有调用模型')
    if _factories is None:
        if get_settings().app_env == 'production':
            raise LivingError('configuration_error', '真实生活尚无有效的受限授权')
        return fallback()
    factories, on_stop = _factories, _on_stop
    try:
        client = factories.adapter(kind, owner, subject, operation, presence=presence)
        class Guarded:
            async def plan(self, prompt):
                try:
                    return await client.plan(prompt)
                except BaseException:
                    halt(factories, on_stop)
                    raise

            async def exchange(self, facts):
                try:
                    return await client.exchange(facts)
                except BaseException:
                    halt(factories, on_stop)
                    raise
        return Guarded()
    except TrialBlocked:
        if factories.gate.policy['scopes'].get(kind) == {'owner': owner, 'subject': subject}:
            halt(factories, on_stop)
        # No key, provider response, account identity or private gate details.
        raise LivingError('configuration_error', '受限生活条件未通过，本轮没有调用模型') from None
