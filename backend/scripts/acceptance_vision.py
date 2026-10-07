"""Complete output contract for the isolated real website's vision request.

The original parser stays strict. Never repair provider JSON or resubmit it.
"""
import copy
import json

from app.services.model_client import ModelClient
from app.services.parsers import ParseError


EXAMPLE = [{
    'label': '照片主体的简短名称',
    'visual_features': '只描述照片中主体可见的颜色、形状、材质与标记',
    'category': 'unknown',
    'concept': {
        'name': '独特角色名',
        'persona': '符合主体特征的性格',
        'opening_line': '符合角色语气的一句话',
        'appearance_description': '保留照片特征的拟人化身体、表情、姿态与材质',
    },
}, {
    'label': '其他清晰的主要物品',
    'visual_features': '这个物品自己的可见特征',
    'category': 'unknown',
}]

CONTRACT = (
    '\n完整结构示例如下，示例只是字段结构，不是照片识别结果：'
    + json.dumps(EXAMPLE, ensure_ascii=False, separators=(',', ':'))
    + '\n请用照片中的真实对象替换示例内容。若只有一个主要对象，只输出一个元素。'
    '不要把背景地板、墙面列为主要对象。主体的visual_features必须位于concept外面，'
    '写照片中可见的特征；concept描述拟人化角色，不能替代照片特征。'
    '先闭合concept对象，再闭合主体对象，之后才可写下一候选。'
    '最后检查每个括号成对、所有字段完整，仅输出合法JSON数组。'
)


class AcceptanceVisionClient(ModelClient):
    def _post_chat_completions(self, payload, settings):
        if payload.get('model') == settings.vision_model and settings.character_bundle_enabled:
            payload = copy.deepcopy(payload)
            content = payload['messages'][0]['content']
            content[0]['text'] += CONTRACT
        return super()._post_chat_completions(payload, settings)

    def recognize(self, image_bytes):
        objects = super().recognize(image_bytes)
        from app.core.config import get_settings
        if get_settings().character_bundle_enabled:
            if not objects[0].visual_features or objects[0].concept is None:
                raise ParseError('主体缺少照片特征或完整角色构思')
        return objects
