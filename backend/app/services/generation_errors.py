"""Safe failure categories only; never expose exception text or provider bodies."""
import json
import logging

import httpx

from app.services.parsers import ParseError


def failure_details(error: Exception) -> dict:
    chain = []
    current = error
    while current is not None and len(chain) < 8 and all(current is not item for item in chain):
        chain.append(current)
        current = current.__cause__ or current.__context__
    for item in chain:
        if isinstance(item, httpx.HTTPStatusError):
            status = item.response.status_code
            if status in (401, 403):
                reason, message = "provider_auth", "生成服务的授权暂时不可用，请联系维护者检查配置。"
            elif status == 429:
                reason, message = "provider_busy", "生成服务暂时繁忙或额度受限，请稍后再试。"
            elif status >= 500:
                reason, message = "provider_unavailable", "生成服务暂时异常，请稍后再试。"
            else:
                reason, message = "provider_rejected", "生成服务未接受这次请求，请联系维护者检查。"
            return {"reason": reason, "message": message, "http_status": status}
        if isinstance(item, (httpx.ConnectTimeout, httpx.ConnectError, httpx.PoolTimeout)):
            return {"reason": "connection_failed", "message": "暂时连接不上生成服务，请稍后再试。"}
        if isinstance(item, httpx.TimeoutException):
            return {"reason": "response_timeout", "message": "生成服务响应超时，本次未能完成。"}
        if isinstance(item, httpx.RequestError):
            return {"reason": "connection_interrupted", "message": "与生成服务的连接中断，本次未能完成。"}
        if isinstance(item, ParseError):
            return {"reason": "invalid_output", "message": "生成内容未通过格式检查，本次没有保存为伙伴。"}
    return {"reason": "unknown", "message": "本次生成未完成，已保留你的选择。"}


def record_failure(stage: str, operation_id: str, error: Exception) -> dict:
    details = failure_details(error)
    # Fixed labels only: exception messages/URLs can contain user data or secrets.
    current, seen = error, set()
    transport_type = None
    parse_diagnostic = {}
    while current is not None and id(current) not in seen and len(seen) < 8:
        seen.add(id(current))
        if isinstance(current, ParseError):
            # Fixed labels and numeric positions only, never response content.
            codes = {
                '输出不是合法 JSON': 'json_syntax',
                '识别结果应为对象数组': 'root_type',
                '识别数组元素应为对象': 'candidate_type',
                '识别结果缺少有效的 label': 'label_invalid',
                '照片特征应为不超过500字的文字': 'features_invalid',
                '角色构思缺少形象设计描述': 'appearance_missing',
                '识别类别无效': 'category_invalid',
                '识别结果为空': 'empty_candidates',
                '角色输出超过长度限制': 'profile_length',
            }
            parse_diagnostic['parse_code'] = codes.get(str(current), 'schema_invalid')
            if isinstance(current.__cause__, json.JSONDecodeError):
                parse_diagnostic['json_position'] = current.__cause__.pos
        for cls, label in (
            (httpx.RemoteProtocolError, "remote_protocol"),
            (httpx.LocalProtocolError, "local_protocol"),
            (httpx.ProxyError, "proxy"),
            (httpx.ReadError, "read"),
            (httpx.WriteError, "write"),
            (httpx.ConnectError, "connect"),
            (httpx.TimeoutException, "timeout"),
        ):
            if isinstance(current, cls):
                transport_type = label
                break
        if transport_type:
            break
        current = current.__cause__ or current.__context__
    logging.getLogger("uvicorn.error").warning("generation_failure %s", json.dumps({
        "stage": stage, "operation_id": operation_id,
        "reason": details["reason"],
        **({"http_status": details["http_status"]} if "http_status" in details else {}),
        **({"transport_type": transport_type} if transport_type else {}),
        **parse_diagnostic,
    }))
    return details


def recognition_failure_message(reason: str) -> str:
    """Recognition has not created a character; describe only confirmed facts."""
    return {
        "connection_interrupted": "识别服务的连接中断了，本次未完成识别，请稍后重试。",
        "connection_failed": "暂时连接不上识别服务，请稍后重试。",
        "response_timeout": "识别服务响应超时，本次未完成识别，请稍后重试。",
        "provider_auth": "识别服务授权暂时不可用，请联系维护者检查配置。",
        "provider_busy": "识别服务暂时繁忙或额度受限，请稍后重试。",
        "provider_unavailable": "识别服务暂时异常，请稍后重试。",
        "provider_rejected": "识别服务未接受这次请求，请联系维护者检查。",
        "invalid_output": "识别结果格式异常，本次未完成识别，可以手动重试。",
    }.get(reason, "本次识别未完成，可以手动重试。")
