#!/usr/bin/env python3
"""Charon Momentum Random Forest V2 inference adapter (2026-07-15)."""

import json
import os
from pathlib import Path
import sys

FEATURES = [
    "price_change_1h",
    "price_change_5m",
    "price_change_1m",
    "smart_degen_count",
    "holder_count",
    "liquidity",
    "bundler_rate",
    "organic_score",
]


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("expected one JSON feature argument")
    payload = json.loads(sys.argv[1])
    missing = [name for name in FEATURES if name not in payload or payload[name] is None]
    if missing:
        raise RuntimeError(f"missing features: {','.join(missing)}")

    default_model = Path(__file__).resolve().parents[1] / "models" / "momentum_rf_v2.joblib"
    model_path = Path(os.environ.get("MOMENTUM_MODEL_PATH", default_model))
    if not model_path.is_file():
        raise RuntimeError(f"Momentum V2 artifact not found: {model_path}")

    import joblib

    model = joblib.load(model_path)
    artifact_features = list(getattr(model, "feature_names_in_", FEATURES))
    if artifact_features != FEATURES:
        raise RuntimeError(
            f"model feature schema mismatch: expected {FEATURES}, got {artifact_features}"
        )
    probabilities = model.predict_proba([[float(payload[name]) for name in FEATURES]])[0]
    classes = list(getattr(model, "classes_", range(len(probabilities))))
    runner_index = classes.index(1) if 1 in classes else classes.index("runner")
    print(json.dumps({
        "runner_probability": float(probabilities[runner_index]),
        "model": {
            "type": "Random Forest",
            "version": "V2",
            "dated": "2026-07-15",
            "artifact": str(model_path),
            "features": FEATURES,
        },
    }))


if __name__ == "__main__":
    main()
