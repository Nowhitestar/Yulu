def pytest_configure(config):
    config.addinivalue_line("markers", "e2e: opt-in tests that require real mlx-whisper model")
    config.addinivalue_line("markers", "integration: tests that spawn the daemon process")
