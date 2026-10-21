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
from typing import Annotated, Any

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
# Score penalty applied per unit of clipped fraction beyond the tolerance.
_EXPOSURE_PENALTY_SCALE = 4.0
# Grayscale clip thresholds bounding the "well-exposed" range.
_CLIP_LO = 0.02
_CLIP_HI = 0.98
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


def blur_score(gray: NDArray[np.uint8]) -> float:
    """Normalized variance of the Laplacian, downscaled for stable statistics."""
    height, width = gray.shape[:2]
    scale = 512 / max(height, width)
    if scale < 1:
        gray = cv2.resize(gray, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_AREA)

    variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    return float(min(1.0, variance / _BLUR_VARIANCE_CEILING))


def exposure_score(gray: NDArray[np.uint8]) -> float:
    """1 minus the share of clipped pixels (beyond a small tolerance band)."""
    normalized = gray.astype(np.float32) / 255.0
    shadows = float(np.mean(normalized < _CLIP_LO))
    highlights = float(np.mean(normalized > _CLIP_HI))
    clipped = max(0.0, shadows + highlights - _EXPOSURE_TOLERANCE)
    return float(max(0.0, 1.0 - clipped * _EXPOSURE_PENALTY_SCALE))


def subject_score(faces: list[QualityFace], width: int, height: int) -> float:
    """Best-face score weighted by how much of the frame it occupies.

    The server sends bounding boxes in absolute pixel coordinates, so they are
    normalized by the frame dimensions before the fractional area comparison.
    """
    if not faces:
        return 0.5  # neutral: no detected subject is not a quality fault
    if width <= 0 or height <= 0:
        return 0.5

    best = 0.0
    for face in faces:
        box = face.bounding_box
        if len(box) == 4:
            area = abs((box[2] - box[0]) * (box[3] - box[1])) / (width * height)
        else:
            area = 0.0
        weight = min(1.0, area / _FACE_AREA_CEILING)
        best = max(best, face.score * (0.6 + 0.4 * weight))
    return float(min(1.0, best))


def assess_quality(image: NDArray[np.uint8], faces: list[QualityFace] | None = None) -> dict[str, Any]:
    height, width = image.shape[:2]
    gray = to_grayscale(image)  # computed once — blur and exposure share it
    return {
        "blurScore": round(blur_score(gray), 4),
        "exposureScore": round(exposure_score(gray), 4),
        "subjectScore": round(subject_score(faces or [], width, height), 4),
        "eyesOpenScore": None,
    }


def create_quality_router(run: Callable[[Callable[[], Any]], Any]) -> APIRouter:
    """Build the /quality router. `run` is the service's thread-pool runner
    (immich_ml.main.run) so image decoding stays off the event loop."""

    router = APIRouter()

    @router.post("/quality")
    async def score_quality(
        images: list[bytes] = File(),
        faces: str | None = Form(default=None),
    ) -> Any:
        """Score image quality signals for memory curation (FG-12).

        Batched: the server sends N previews in one request; the response is a
        list of QualityResponse aligned with the input order. `faces`, when
        present, is a JSON array of per-image face lists (same length).
        """
        if not images:
            raise HTTPException(400, "At least one image is required")

        parsed_faces: list[list[QualityFace] | None] | None = None
        if faces:
            try:
                parsed_faces = TypeAdapter(list[list[QualityFace] | None]).validate_json(faces)
            except ValidationError as e:
                raise HTTPException(422, f"Invalid faces payload: {e}") from e
            if len(parsed_faces) != len(images):
                raise HTTPException(422, "faces payload length must match the number of images")

        decoded: list[NDArray[np.uint8]] = []
        for index, image in enumerate(images):
            try:
                decoded_image = await run(lambda image=image: decode_pil(image))
            except Exception as e:
                raise HTTPException(400, f"Failed to decode image {index}: {e}") from e

            if decoded_image.width == 0 or decoded_image.height == 0:
                raise HTTPException(400, f"Image {index} has zero width or height")

            decoded.append(np.asarray(decoded_image))

        return [
            QualityResponse(**assess_quality(array, parsed_faces[index] if parsed_faces else None))
            for index, array in enumerate(decoded)
        ]

    return router
