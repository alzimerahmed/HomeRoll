"""Tests for the FG-12 image quality scoring endpoint (HomeRoll)."""

import io
import json
from typing import Any

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from immich_ml.quality import (
    QualityFace,
    assess_quality,
    blur_score,
    create_quality_router,
    exposure_score,
    subject_score,
)


def _image(size: int = 256) -> np.ndarray[Any, np.dtype[np.uint8]]:
    """A synthetic photo: gradient background + sharp geometric edges."""
    rng = np.random.default_rng(42)
    base = np.linspace(0, 255, size, dtype=np.float32)
    rows = np.tile(base, (size, 1))
    cols = np.tile(base[:, None], (1, size))
    image = ((rows + cols) / 2).astype(np.uint8)
    image[64:192, 64:192] = rng.integers(0, 255, (128, 128), dtype=np.uint8)
    return image


def _encode(image: np.ndarray[Any, np.dtype[np.uint8]]) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(image).save(buffer, format="JPEG")
    return buffer.getvalue()


class TestScorers:
    def test_blur_separates_sharp_from_blurred(self) -> None:
        sharp = _image()
        blurred = cv2.GaussianBlur(sharp, (31, 31), 0)

        assert blur_score(sharp) > 0.5
        assert blur_score(blurred) < blur_score(sharp) / 4

    def test_blur_is_bounded(self) -> None:
        noise = np.random.default_rng(0).integers(0, 255, (256, 256), dtype=np.uint8)
        assert 0.0 <= blur_score(noise) <= 1.0

    def test_exposure_penalizes_clipping(self) -> None:
        well_exposed = _image()
        blown_out = well_exposed.copy()
        blown_out[:128, :] = 255

        assert exposure_score(well_exposed) > exposure_score(blown_out)
        assert 0.0 <= exposure_score(blown_out) <= 1.0

    def test_subject_neutral_without_faces(self) -> None:
        assert subject_score([], 256, 256) == 0.5

    def test_subject_prefers_large_confident_faces(self) -> None:
        size = 256
        small = subject_score([QualityFace(score=0.9, boundingBox=[0, 0, 10, 10])], size, size)
        large = subject_score([QualityFace(score=0.9, boundingBox=[0, 0, 100, 100])], size, size)

        assert large > small
        assert 0.0 <= small <= 1.0

    def test_subject_normalizes_pixel_boxes(self) -> None:
        # the same fractional face area must score the same regardless of image size
        small_frame = subject_score([QualityFace(score=0.9, boundingBox=[0, 0, 50, 50])], 256, 256)
        large_frame = subject_score([QualityFace(score=0.9, boundingBox=[0, 0, 100, 100])], 512, 512)

        assert small_frame == pytest.approx(large_frame)

    def test_assess_quality_shape(self) -> None:
        result = assess_quality(_image())

        assert set(result) == {"blurScore", "exposureScore", "subjectScore", "eyesOpenScore"}
        assert result["eyesOpenScore"] is None
        for key in ("blurScore", "exposureScore", "subjectScore"):
            assert 0.0 <= result[key] <= 1.0


class TestEndpoint:
    @pytest.fixture()
    def client(self, mocker: Any) -> TestClient:
        from fastapi import FastAPI

        from immich_ml import main

        app = FastAPI()
        app.include_router(create_quality_router(main.run))
        return TestClient(app)

    def test_scores_encoded_image(self, client: TestClient) -> None:
        response = client.post("/quality", files=[("images", ("a.jpg", _encode(_image()), "image/jpeg"))])

        assert response.status_code == 200
        body = response.json()
        assert isinstance(body, list) and len(body) == 1
        assert 0.0 <= body[0]["blurScore"] <= 1.0
        assert 0.0 <= body[0]["exposureScore"] <= 1.0
        assert 0.0 <= body[0]["subjectScore"] <= 1.0
        assert body[0]["eyesOpenScore"] is None

    def test_accepts_faces_payload(self, client: TestClient) -> None:
        faces = [{"boundingBox": [0, 0, 100, 100], "score": 0.95}]
        response = client.post(
            "/quality",
            files=[("images", ("a.jpg", _encode(_image()), "image/jpeg"))],
            data={"faces": json.dumps([faces])},
        )

        assert response.status_code == 200
        assert response.json()[0]["subjectScore"] > 0.5

    def test_rejects_invalid_faces(self, client: TestClient) -> None:
        response = client.post(
            "/quality",
            files=[("images", ("a.jpg", _encode(_image()), "image/jpeg"))],
            data={"faces": "not-json"},
        )

        assert response.status_code == 422

    def test_rejects_garbage_image(self, client: TestClient) -> None:
        response = client.post("/quality", files=[("images", ("a.jpg", b"garbage", "image/jpeg"))])

        assert response.status_code == 400
