"""One bounded SMS request. SDK is used only for signing, never credentials or retries."""
from __future__ import annotations

import json
import re
import time
from typing import Callable

import httpx

from app.core.config import Settings
from app.services.sms import SmsError

HOST = 'sms.volcengineapi.com'
URL = f'https://{HOST}/?Action=SendSms&Version=2020-01-01'


class VolcengineSmsProvider:
    requires_budget = True

    def __init__(self, settings: Settings, client_factory: Callable = httpx.Client):
        self.settings = settings
        self.client_factory = client_factory

    def preflight(self):
        if not self.settings.sms_real_ready:
            raise SmsError('sms_unavailable', '短信服务暂未开放，请稍后再试')
        try:
            from volcengine.auth.SignerV4 import SignerV4  # noqa: F401
            from volcengine.base.Request import Request  # noqa: F401
            from volcengine.Credentials import Credentials  # noqa: F401
        except Exception:
            raise SmsError('sms_unavailable', '短信服务暂时不可用，请稍后再试') from None

    def send_code(self, phone: str, code: str) -> None:
        self.preflight()
        if not re.fullmatch(r'1[3-9][0-9]{9}', phone) or not re.fullmatch(r'[0-9]{6}', code):
            raise SmsError('sms_unavailable', '短信请求无效，请重新获取验证码')
        dispatched = False
        try:
            from volcengine.auth.SignerV4 import SignerV4
            from volcengine.base.Request import Request
            from volcengine.Credentials import Credentials
            settings = self.settings
            body = json.dumps({'SmsAccount': settings.sms_account, 'Sign': settings.sms_sign,
                               'TemplateID': settings.sms_template_id,
                               'TemplateParam': json.dumps({'code': code}), 'PhoneNumbers': phone},
                              ensure_ascii=False, separators=(',', ':'))
            request = Request()
            request.method, request.path, request.host = 'POST', '/', HOST
            request.query = {'Action': 'SendSms', 'Version': '2020-01-01'}
            request.headers = {'Host': HOST, 'Content-Type': 'application/json'}
            request.body = body
            SignerV4.sign(request, Credentials(settings.sms_access_key_id, settings.sms_secret_access_key,
                                             'volcSMS', 'cn-north-1'))
            timeout = settings.sms_timeout_seconds
            with self.client_factory(timeout=httpx.Timeout(timeout, connect=min(5, timeout)),
                                     follow_redirects=False, trust_env=False) as client:
                deadline = time.monotonic() + timeout
                dispatched = True
                with client.stream('POST', URL, content=body.encode('utf-8'), headers=request.headers) as response:
                    raw = bytearray()
                    for chunk in response.iter_bytes():
                        raw.extend(chunk)
                        if len(raw) > 65536 or time.monotonic() > deadline:
                            raise ValueError('invalid_sms_response')
                    if response.status_code != 200:
                        raise ValueError('unconfirmed_sms_response')
                    result = json.loads(raw)
                    metadata = result.get('ResponseMetadata')
                    if not isinstance(metadata, dict):
                        raise ValueError('missing_sms_metadata')
                    if metadata.get('Error'):
                        raise SmsError('sms_rejected', '短信未发送成功，请稍后重新获取')
                    messages = result.get('Result', {}).get('MessageID')
                    if (not isinstance(messages, list) or len(messages) != 1
                            or not isinstance(messages[0], str) or not messages[0].strip()):
                        raise ValueError('missing_sms_message_id')
        except SmsError:
            raise
        except Exception:
            if dispatched:
                raise SmsError('sms_unknown', '发送结果暂未确认，请等待一分钟；若已收到短信，可直接填写验证码登录') from None
            raise SmsError('sms_unavailable', '短信服务暂时不可用，请稍后再试') from None
