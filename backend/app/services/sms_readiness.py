"""Offline SMS diagnostics. Never use real credentials, senders or database state."""
from __future__ import annotations

import math

from app.core.config import Settings


def _synthetic_signature_available() -> bool:
    """Exercise only the optional SDK's local signing path with invented inputs."""
    try:
        from volcengine.auth.SignerV4 import SignerV4
        from volcengine.base.Request import Request
        from volcengine.Credentials import Credentials

        request = Request()
        request.method, request.path, request.host = 'POST', '/', 'sms.volcengineapi.com'
        request.query = {'Action': 'SendSms', 'Version': '2020-01-01'}
        request.headers = {'Host': request.host, 'Content-Type': 'application/json'}
        request.body = '{"offline_preflight":true}'
        SignerV4.sign(request, Credentials('offline-preflight-ak', 'offline-preflight-sk',
                                         'volcSMS', 'cn-north-1'))
        authorization = request.headers.get('Authorization')
        return isinstance(authorization, str) and bool(authorization.strip())
    except Exception:
        return False


def assess_sms(settings: Settings) -> list[dict[str, str]]:
    """Fixed diagnostics only; local readiness cannot certify provider approval."""
    checks: list[dict[str, str]] = []

    def add(ident: str, ok: bool, good: str, bad: str, action: str) -> None:
        checks.append(dict(id=ident, status='pass' if ok else 'blocked',
                           message=good if ok else bad, source='backend/app/core/config.py',
                           next_step=action))

    add('sms_provider_selection', settings.sms_provider == 'volcengine',
        '已选择火山短信候选适配', '仍使用模拟短信',
        '确认平台和批次后配置SMS_PROVIDER=volcengine；不由预检修改')
    add('sms_live_switch', settings.sms_live_enabled,
        '真实发送开关已配置', '真实发送开关关闭',
        '取得具体发送批次授权后再启用SMS_LIVE_ENABLED')
    for ident, value, label, field in (
        ('sms_access_key', settings.sms_access_key_id, '独立短信访问密钥', 'SMS_ACCESS_KEY_ID'),
        ('sms_secret_key', settings.sms_secret_access_key, '独立短信秘密密钥', 'SMS_SECRET_ACCESS_KEY'),
        ('sms_account', settings.sms_account, '短信消息组', 'SMS_ACCOUNT'),
        ('sms_sign', settings.sms_sign, '短信签名', 'SMS_SIGN'),
        ('sms_template', settings.sms_template_id, '短信模板', 'SMS_TEMPLATE_ID'),
    ):
        add(ident, bool(value.strip()), label + '已填写；未验证平台有效性', label + '未填写',
            '在本项目私有服务端配置填写' + field + '；不发送到聊天')
    add('sms_daily_limit', 0 < settings.sms_daily_limit <= 10000,
        '每日发送次数在保护范围内；不是费用预算', '每日发送次数未开放或超出保护范围',
        '按批准批次设置SMS_DAILY_LIMIT（1–10000），UTC日累计；另确认单价与费用上限')
    add('sms_timeout', math.isfinite(settings.sms_timeout_seconds)
        and 0 < settings.sms_timeout_seconds <= 15,
        '发送超时在保护范围内', '发送超时无效或超过15秒',
        '设置SMS_TIMEOUT_SECONDS为大于0且不超过15的有限数值')

    signature_ok = _synthetic_signature_available()
    checks.append(dict(id='sms_local_signer', status='pass' if signature_ok else 'blocked',
                       message='本地虚构凭证签名通过；未联网' if signature_ok
                       else '本地签名依赖缺失或签名失败',
                       source='backend/requirements-sms.txt',
                       next_step='使用本项目虚拟环境安装requirements-sms.txt并复跑；不输出签名头'))
    checks.append(dict(id='sms_provider', status='pending' if settings.sms_real_ready and signature_ok
                       else 'blocked',
                       message='本地配置与签名通过，真实短信仍待验' if settings.sms_real_ready and signature_ok
                       else '真实短信存在本地阻塞，请逐项查看sms检查',
                       source='backend/app/services/sms_readiness.py',
                       next_step='核实平台审核、模板code变量、单价与授权批次，再验证收信、登录及错码拒绝'))
    return checks
