"""Complete the independent opening/image branches after persona validation."""
from concurrent.futures import ThreadPoolExecutor
from functools import partial

from app.services.character_images import remove_image_file
from app.services.model_client import CharacterResult, ModelClient
from app.services.parsers import Persona
from app.services.generation_timing import timed_call


def finish_character(client: ModelClient, label: str, persona: Persona, operation_id: str = "standalone", visual_features: str = "") -> tuple[CharacterResult, str]:
    appearance = {"appearance_description": persona.appearance_description} if persona.appearance_description else {}
    make_image = partial(client.generate_image, label, persona.name,
                         persona=persona.persona, visual_features=visual_features, **appearance)
    if persona.opening_line is not None:
        image_path = timed_call("image", operation_id, make_image)
        return CharacterResult(persona.name, persona.persona, persona.opening_line), image_path
    # Both branches own their HTTP clients; no database session crosses threads.
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="character-assets") as pool:
        image_future = pool.submit(timed_call, "image", operation_id, make_image)
        opening_future = pool.submit(timed_call, "opening", operation_id, client.generate_opening, persona)
        try:
            opening = opening_future.result()
            image_path = image_future.result()
        except BaseException:
            opening_future.cancel()
            image_future.cancel()
            # Running HTTP requests cannot be cancelled via Future.cancel(). Wait
            # for any late image before cleanup; never let it become an orphan.
            try:
                late_image = image_future.result()
            except BaseException:
                pass
            else:
                remove_image_file(late_image)
            raise
    return CharacterResult(persona.name, persona.persona, opening), image_path
