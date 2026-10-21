"""Image quality signals for memory curation (FG-12, HomeRoll).

Pure-numpy/OpenCV scoring — no ONNX model, no download, no new dependencies
(opencv-python-headless and numpy are already required by the OCR pipeline).
Exposed as a standalone `/quality` endpoint rather than a `/predict` pipeline
entry because the scorer has no model session; the pipeline machinery assumes
one.

Scores are floats in [0, 1] (higher is better):

- ``blurScore`` — normalized variance of the Laplacian. Sharp photos have high
  high-frequency energy; blurred ones collapse toward 0.
- ``exposureScore`` — fraction of well-exposed pixels after penalizing clipped
  shadows/highlights.
- ``subjectScore`` — derived from face-detection output forwarded by the server
  (max face score weighted by relative face area). Without faces the photo is
  assumed landscape/scene-oriented and scored neutrally.
- ``eyesOpenScore`` — reserved. The bundled SCRFD landmarks (5 points: 2 eyes,
  nose, 2 mouth corners) carry no eyelid geometry, so openness cannot be
  estimated honestly; the field is always ``None`` until a dedicated eyes-open
  model lands (see docs/research.md ADR-017).
"""

from collections.abc import Callable
from typing import Any

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from .models.transforms import decode_pil

# Laplacian variance saturates around this value for typical 512px previews.
_BLUR_VARIANCE_CEILING = 600.0
# Fraction of pixels allowed to be clipped before exposure starts dropping.
_EXPOSURE_TOLERANCE = 0.02
# A face covering more than this fraction of the frame dominates the subject score.
_FACE_AREA_CEILING = 0.25


class QualityFace(BaseModel):
    """Subset of the server's face payload needed for subject scoring."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    score: float = 0.0
    bounding_box: Annotated[list[float], Field(alias="boundingBox")]


_FACES_ADAPTER = TypeAdapter(list[QualityFace])


class QualityResponse(BaseModel):
    blur_score: Annotated[float, Field(alias="blurScore")]
    exposure_score: Annotated[float, Field(alias="exposureScore")]
    subject_score: Annotated[float, Field(alias="subjectScore")]
    eyes_open_score: Annotated[float | None, Field(alias="eyesOpenScore")]


def to_grayscale(image: NDArray[np.uint8]) -> NDArray[np.uint8]:
    if image.ndim == 2:
        return image
    return cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)


def blur_score(image: NDArray[np.uint8]) -> float:
    """Normalized variance of the Laplacian, downscaled for stable statistics."""
    gray = to_grayscale(image)
    height, width = gray.shape[:2]
    scale = 512 / max(height, width)
    if scale < 1:
        gray = cv2.resize(gray, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)

    variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return float(min(1.0, variance / _BLUR_VARIANCE_CEILING))


def exposure_score(image: NDArray[np.uint8]) -> float:
    """1 minus the share of clipped pixels (beyond a small tolerance band)."""
    gray = to_grayscale(image).astype(np.float32) / 255.0
    shadows = float(np.mean(gray < 0.02))
    highlights = float(np.mean(gray > 0.98))
    clipped = max(0.0, shadows + highlights - _EXPOSURE_TOLERANCE)
    return float(max(0.0, 1.0 - clipped * 4))


def subject_score(faces: list[QualityFace]) -> float:
    """Best-face score weighted by how much of the frame it occupies."""
    if not faces:
        return 0.5  # neutral: no detected subject is not a quality fault

    best = 0.0
    for face in faces:
        box = face.bounding_box
        if len(box) == 4:
            area = abs((box[2] - box[0]) * (box[3] - box[1]))
        else:
            area = 0.0
        weight = min(1.0, area / _FACE_AREA_CEILING)
        best = max(best, face.score * (0.6 + 0.4 * weight))
    return float(min(1.0, best))


def assess_quality(image: NDArray[np.uint8], faces: list[QualityFace] | None = None) -> dict[str, Any]:
    return {
        "blurScore": round(blur_score(image), 4),
        "exposureScore": round(exposure_score(image), 4),
        "subjectScore": round(subject_score(faces or []), 4),
        "eyesOpenScore": None,
    }


def create_quality_router(run: Callable[[Callable[[], Any]], Any]) -> APIRouter:
    """Build the /quality router. `run` is the service's thread-pool runner
    (immich_ml.main.run) so image decoding stays off the event loop."""

    router = APIRouter()

    @router.post("/quality")
    async def score_quality(
        image: bytes = File(),
        faces: str | None = Form(default=None),
    ) -> Any:
        """Score image quality signals for memory curation (FG-12)."""
        try:
            decoded = await run(lambda: decode_pil(image))
        except Exception as e:
            raise HTTPException(400, f"Failed to decode image: {e}") from e

        if decoded.width == 0 or decoded.height == 0:
            raise HTTPException(400, "Image has zero width or height")

        array = np.asarray(decoded)
        parsed_faces: list[QualityFace] | None = None
        if faces:
            try:
                parsed_faces = _FACES_ADAPTER.validate_json(faces)
            except ValidationError as e:
                raise HTTPException(422, f"Invalid faces payload: {e}") from e

        return QualityResponse(**assess_quality(array, parsed_faces))

    return router
