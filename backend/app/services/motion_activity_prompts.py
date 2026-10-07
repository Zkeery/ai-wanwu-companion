"""Fixed activity prompts; legacy walk text remains byte-for-byte unchanged."""
from app.services.motion_atlas_provider import AtlasProviderError
from app.services.motion_walk_openai import PROMPT as WALK_PROMPT

ACTIVITIES = ('rest', 'walk', 'observe')
_COMMON = """Edit the provided reference character into a 2 by 2 animation contact sheet.
Preserve exactly its identity, face, distinctive features, colors, material and existing limbs.
Four equally sized 512 by 512 cells, reading top-left, top-right, bottom-left,
bottom-right. One complete character centered in each cell, same scale, fixed
camera, same body position and ground baseline. Keep the feet planted while
allowing the face and head to express the specified activity.
"""
_ENDING = """Make a gentle loop including the transition from frame 4 to frame 1.
Keep the entire character inside each cell with clear empty margins.
Output actual transparent alpha around every character. Remove the reference
background. No ground plane, cast shadow, grid, dividers, text, frame numbers,
watermark or painted checkerboard. Do not draw new objects or extra limbs.
"""
PROMPTS = {
    'walk': WALK_PROMPT,
    'rest': _COMMON + """The character rests with BOTH EYES FULLY CLOSED in ALL FOUR frames.
This is peaceful closed-eye rest: eyelids stay shut throughout the entire loop.
Relax the shoulders and existing arms, keeping the expression calm and content.
Frame 1: both eyes fully closed, relaxed neutral breathing pose.
Frame 2: both eyes fully closed, gentle inhale with a very small upper-body rise.
Frame 3: both eyes fully closed, slow exhale, shoulders softly settle.
Frame 4: both eyes fully closed, return toward the first relaxed breathing pose.
Never open the eyes, peek, blink between open and closed, or display alert eyes.
No walking, dancing, exaggerated bounce, bed, chair or sleep symbols.
""" + _ENDING,
    'observe': _COMMON + """The character curiously observes its surroundings while staying in place.
Make the looking-around action clearly readable: turn the head AND shift the gaze.
Frame 1: head turned about 25 degrees toward screen-left, open eyes looking left.
Frame 2: head returns toward the front and tilts slightly up, open eyes looking up.
Frame 3: head turned about 25 degrees toward screen-right, open eyes looking right.
Frame 4: head returns toward the front and tilts slightly down, open eyes scanning down.
Keep the eyes open and curious in all frames. Use distinct, gentle head poses.
For a character without a separate neck, express the turn through its face and
upper body while keeping its feet planted. Preserve its identity and anatomy.
Do not merely move the pupils or rotate the whole image as a rigid cutout.
No walking, pointing at invented objects, dancing or added accessories.
""" + _ENDING,
}


def prompt_for(activity: str) -> str:
    if not isinstance(activity, str) or activity not in PROMPTS:
        raise AtlasProviderError('activity_invalid')
    return PROMPTS[activity]
