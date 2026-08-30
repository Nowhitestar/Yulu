"""Python access to Yulu's standard per-user path contract."""

from __future__ import annotations

from yulu_platform.macos.path_resolver import MacOSPathResolver


PATHS = MacOSPathResolver().application_paths()

DURABLE_DATA_DIR = PATHS.durable_data_dir
CONFIG_PATH = PATHS.config_file
CONFIG_READ_PATHS = PATHS.config_read_files
MODELS_DIR = PATHS.models_dir
CACHE_DIR = PATHS.cache_dir
IPC_DIR = PATHS.ipc_dir
LOGS_DIR = PATHS.logs_dir
MEDIA_LIBRARY_DIR = PATHS.media_library_dir
LEGACY_READ_ONLY_DATA_DIR = PATHS.legacy_read_only_data_dir
