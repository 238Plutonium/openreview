#!/usr/bin/env python3
import base64
import os
import time
from functools import lru_cache
from typing import Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


class TranscribeRequest(BaseModel):
    audioBase64: str = Field(..., min_length=1)
    sampleRate: int = 16000
    channels: int = 1
    sampleWidthBytes: int = 2
    language: Optional[str] = None
    durationSeconds: Optional[float] = None


class TranscribeResponse(BaseModel):
    text: str
    language: Optional[str]
    durationSeconds: float
    inferenceSeconds: float
    segments: list[dict]


app = FastAPI(title="ECHO ASR Service")


@lru_cache(maxsize=1)
def model():
    from faster_whisper import WhisperModel

    model_name = os.environ.get("ASR_MODEL", "large-v3")
    device = os.environ.get("ASR_DEVICE", "cuda")
    compute_type = os.environ.get("ASR_COMPUTE_TYPE", "float16")
    return WhisperModel(model_name, device=device, compute_type=compute_type)


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": os.environ.get("ASR_MODEL", "large-v3"),
        "device": os.environ.get("ASR_DEVICE", "cuda"),
        "computeType": os.environ.get("ASR_COMPUTE_TYPE", "float16"),
        "loaded": model.cache_info().currsize > 0,
    }


@app.post("/transcribe", response_model=TranscribeResponse)
def transcribe(request: TranscribeRequest):
    if request.sampleRate != 16000:
        raise HTTPException(status_code=400, detail="sampleRate must be 16000")
    if request.sampleWidthBytes != 2:
        raise HTTPException(status_code=400, detail="sampleWidthBytes must be 2")
    if request.channels < 1:
        raise HTTPException(status_code=400, detail="channels must be >= 1")

    try:
        raw = base64.b64decode(request.audioBase64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 audio: {exc}") from exc

    if len(raw) < 2:
        return TranscribeResponse(
            text="",
            language=None,
            durationSeconds=0,
            inferenceSeconds=0,
            segments=[],
        )

    audio = np.frombuffer(raw, dtype=np.int16)
    if request.channels > 1:
        trim = audio.size - (audio.size % request.channels)
        audio = audio[:trim].reshape((-1, request.channels)).mean(axis=1).astype(np.int16)

    audio_float = audio.astype(np.float32) / 32768.0
    duration = request.durationSeconds or float(audio_float.size / request.sampleRate)
    started = time.time()
    beam_size = int(os.environ.get("ASR_BEAM_SIZE", "1"))
    vad_filter = os.environ.get("ASR_VAD_FILTER", "false").lower() in {"1", "true", "yes", "on"}
    no_speech_threshold = float(os.environ.get("ASR_NO_SPEECH_THRESHOLD", "0.6"))
    initial_prompt = os.environ.get("ASR_INITIAL_PROMPT", "").strip() or None

    segments_iter, info = model().transcribe(
        audio_float,
        language=request.language or os.environ.get("ASR_LANGUAGE") or None,
        beam_size=beam_size,
        vad_filter=vad_filter,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt,
    )
    segments = []
    for segment in segments_iter:
        text = segment.text.strip()
        no_speech_prob = float(segment.no_speech_prob)
        if not text or no_speech_prob >= no_speech_threshold:
            continue

        segments.append(
            {
                "start": max(0.0, float(segment.start)),
                "end": min(duration, float(segment.end)),
                "text": text,
                "avgLogprob": float(segment.avg_logprob),
                "noSpeechProb": no_speech_prob,
            }
        )
    text = " ".join(segment["text"] for segment in segments if segment["text"]).strip()

    return TranscribeResponse(
        text=text,
        language=getattr(info, "language", None),
        durationSeconds=duration,
        inferenceSeconds=time.time() - started,
        segments=segments,
    )


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("ASR_HOST", "127.0.0.1")
    port = int(os.environ.get("ASR_PORT", "7001"))
    uvicorn.run(app, host=host, port=port)
