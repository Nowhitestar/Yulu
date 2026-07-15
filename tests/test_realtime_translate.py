import importlib

import pytest


def test_select_runtime_prefers_configured_cheap_model():
    module = importlib.import_module("realtime_translate")
    config = {
        "model": {"provider": "xai-oauth", "default": "grok-4.5"},
        "smart_model_routing": {"cheap_model": {"provider": "custom", "model": "fast-local"}},
    }

    assert module.select_runtime(config, {}) == {"provider": "custom", "model": "fast-local"}


def test_select_runtime_uses_available_xai_low_latency_model():
    module = importlib.import_module("realtime_translate")
    config = {"model": {"provider": "xai-oauth", "default": "grok-4.5"}}
    catalog = {"xai-oauth": {"models": ["grok-4.5", "grok-4.20-0309-non-reasoning"]}}

    assert module.select_runtime(config, catalog) == {
        "provider": "xai-oauth",
        "model": "grok-4.20-0309-non-reasoning",
    }


def test_select_runtime_falls_back_to_main_model():
    module = importlib.import_module("realtime_translate")
    config = {"model": {"provider": "custom", "default": "configured-model"}}

    assert module.select_runtime(config, {}) == {"provider": "custom", "model": "configured-model"}


def test_translate_rejects_missing_source_or_target_before_loading_runtime():
    module = importlib.import_module("realtime_translate")

    with pytest.raises(ValueError, match="sourceText and targetLanguage are required"):
        module.translate({"sourceText": "", "targetLanguage": "English"})
    with pytest.raises(ValueError, match="sourceText and targetLanguage are required"):
        module.translate({"sourceText": "你好", "targetLanguage": ""})


def test_translate_reports_missing_hermes_runtime(monkeypatch, tmp_path):
    module = importlib.import_module("realtime_translate")
    monkeypatch.setenv("YULU_HERMES_HOME", str(tmp_path))

    with pytest.raises(RuntimeError, match="Hermes Agent runtime is unavailable"):
        module.translate({"sourceText": "你好", "targetLanguage": "English"})


def test_yulu_hermes_home_takes_precedence(monkeypatch, tmp_path):
    module = importlib.import_module("realtime_translate")
    preferred = tmp_path / "preferred"
    fallback = tmp_path / "fallback"
    monkeypatch.setenv("YULU_HERMES_HOME", str(preferred))
    monkeypatch.setenv("HERMES_HOME", str(fallback))

    assert module.hermes_home() == preferred
