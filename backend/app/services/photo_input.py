"""Decode bounded photo inputs and send only oriented pixels to the vision model."""
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

from app.core.errors import api_error
from app.core.config import get_settings

register_heif_opener()

MAX_EDGE = 4096
MAX_NORMALIZED_SIZE = 10 * 1024 * 1024
FORMATS = ("JPEG", "PNG", "WEBP", "HEIF")


def _check_image(image: Image.Image) -> None:
    if image.format not in FORMATS:
        raise api_error(400, "invalid_type", "仅支持 JPG/PNG/HEIC/WebP 图片")
    if min(image.size) < 1 or max(image.size) > MAX_EDGE:
        raise api_error(400, "image_dimensions", "图片长边不能超过 4096px，请缩小后重新选择")
    if image.format != "HEIF" and getattr(image, "is_animated", False):
        raise api_error(400, "animated_image", "请选择单张静态照片，暂不支持动画图片")


def normalize_photo(data: bytes) -> bytes:
    """No disk writes, original metadata, or model calls. HEIF opens its primary image."""
    try:
        with Image.open(BytesIO(data), formats=FORMATS) as image:
            _check_image(image)
            image.verify()
        with Image.open(BytesIO(data), formats=FORMATS) as image:
            _check_image(image)
            image.load()
            with ImageOps.exif_transpose(image) as oriented:
                with oriented.convert("RGBA") as pixels:
                    # A fresh canvas prevents accidental EXIF/GPS/XMP/ICC propagation.
                    with Image.new("RGB", pixels.size, "white") as clean:
                        with pixels.getchannel("A") as alpha:
                            clean.paste(pixels, mask=alpha)
                        edge = get_settings().vision_max_edge
                        clean.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                        output = BytesIO()
                        clean.save(output, format="JPEG", quality=90)
                        result = output.getvalue()
    except Image.DecompressionBombError:
        raise api_error(400, "image_dimensions", "图片长边不能超过 4096px，请缩小后重新选择")
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError):
        raise api_error(400, "invalid_image", "图片已损坏或无法读取，请重新导出或换一张照片")
    if len(result) > MAX_NORMALIZED_SIZE:
        raise api_error(400, "normalized_too_large", "图片转换后超过 10MB，请缩小后重新选择")
    return result
