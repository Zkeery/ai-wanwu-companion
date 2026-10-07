"""Explicitly enabled reply adapter using the existing configured chat provider."""
from app.core.config import get_settings
from app.services.model_client import ModelClient, ModelError

VOICE_DIALOGUE_STYLE_VERSION = 'v4'
VOICE_DIALOGUE_STYLE_V2 = (
    '\n这是一段会被读出来的私人语音聊天。请用这个伙伴自己的说话习惯，'
    '接住用户刚说的具体事情或词，像当面聊天一样自然、有情绪，而不是客服式安慰。'
    '少用“我在呢”“我陪着你”“想说多少都可以”“今天辛苦了”这类可套在任何人的固定句；'
    '不要重复心情标签来代替回应。可以有短句和停顿，不必每次提问或给建议。'
    '用户明确只想被听见、不要建议或不想回答问题时，只回应，不建议、不追问。'
    '通常一到三句；需要直接回答的事实问题先答事实，再保留一点角色口吻。'
    '继续遵守已有角色、心情纠正、私人记忆与场景确认规则；不知道的经历不编，'
    '未由用户确认的场景动作不能说已经完成。'
)
VOICE_DIALOGUE_STYLE_V3 = (
    '\n这是一段会被读出来的私人语音聊天。像熟悉的朋友平常说话那样，'
    '先顺着用户眼前这句话回应，再决定要不要多说一句。'
    '用简单、暖一点的口语；用户说累了且没有拒绝建议时，'
    '可以轻轻关心、建议歇会儿或邀请聊两句，但不要每次照搬同一句话。'
    '不要写成文案：少用诗意比喻、长段安慰、空泛的陪伴承诺和连续追问；'
    '没有自然需要时，不必提问，也不必强调自己一直在听或一直记着。'
    '用户明确只想被听见、不要建议或不想回答问题时，只回应，不建议、不追问。'
    '事实问题先直接答事实，不知道的经历不编、不夸大记忆；'
    '保留伙伴自己的性格，但不表演亲密或编造此前互动。'
    '继续遵守已有心情纠正、私人记忆与场景确认规则；'
    '未由用户确认的场景动作不能说已经完成。通常一到两句。'
)
VOICE_DIALOGUE_STYLE_V4 = VOICE_DIALOGUE_STYLE_V3 + (
    '回复开头如果需要语气词，可以按语境自然用“嗯嗯”“好的”“好呢”等，'
    '也可以直接接话；不要只用单字“嗯”开场，也不要每句都塞相同的语气词。'
)
VOICE_DIALOGUE_STYLES = {
    'v2': VOICE_DIALOGUE_STYLE_V2,
    'v3': VOICE_DIALOGUE_STYLE_V3,
    'v4': VOICE_DIALOGUE_STYLE_V4,
}


def voice_dialogue_messages(messages, *, style_version=None):
    selected_style = VOICE_DIALOGUE_STYLE_VERSION if style_version is None else style_version
    if (not isinstance(messages, list) or not messages or not isinstance(messages[0], dict)
            or messages[0].get('role') != 'system'
            or not isinstance(messages[0].get('content'), str)
            or not all(isinstance(item, dict) and item.get('role') in {'system', 'user', 'assistant'}
                       and isinstance(item.get('content'), str) for item in messages)
            or messages[-1]['role'] != 'user'
            or not isinstance(selected_style, str) or selected_style not in VOICE_DIALOGUE_STYLES):
        raise ModelError('语音回复上下文格式无效')
    prepared = [dict(item) for item in messages]
    prepared[0]['content'] += VOICE_DIALOGUE_STYLES[selected_style]
    return prepared


def reply_mode():
    settings = get_settings()
    if settings.app_env == 'test' or settings.use_mock:
        return 'offline_fixture'
    return 'configured_model' if settings.voice_live_reply_enabled else 'disabled'


def configured_reply(messages, *, style_version=None, settings=None, max_payload_bytes=None):
    settings = settings or get_settings()
    if not settings.voice_live_reply_enabled or settings.use_mock or settings.app_env == 'test':
        raise ModelError('语音正式回复未启用')
    bounded = settings.model_copy(update={
        'model_max_retries': 0, 'model_timeout_seconds': min(30.0, settings.model_timeout_seconds),
    })
    client = ModelClient()
    selected_style = VOICE_DIALOGUE_STYLE_VERSION if style_version is None else style_version
    payload = {'model': settings.chat_model, 'messages': voice_dialogue_messages(messages, style_version=selected_style),
        'temperature': 0.8,
        'max_tokens': 1024, 'stream': False}
    payload.update(client._text_options(bounded))
    if max_payload_bytes is not None:
        import json
        if len(json.dumps(payload, ensure_ascii=False).encode()) > max_payload_bytes:
            raise ModelError('语音上下文超过本次授权范围')
    result = client._post_chat_completions(payload, bounded)
    if not isinstance(result, str) or not result.strip() or len(result) > 4000:
        raise ModelError('语音回复为空或超出长度限制')
    reply = result.strip()
    if selected_style == 'v4':
        if reply == '嗯':
            return '嗯嗯'
        if len(reply) > 1 and reply[0] == '嗯' and reply[1] in '，,。':
            return '嗯嗯' + reply[1:]
    return reply
