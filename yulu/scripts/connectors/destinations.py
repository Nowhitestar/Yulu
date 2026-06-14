"""List selectable output destinations for connected services."""

from __future__ import annotations

import json
import os
import ssl
import sys
from configparser import ConfigParser
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CONFIG_PATH = Path(os.environ.get("YULU_CONFIG_FILE", Path.home() / ".config" / "yulu" / "config.json"))
NOTION_API_BASE = "https://api.notion.com/v1"
NOTION_VERSION = "2026-03-11"
ZULIP_TRANSIENT_ATTEMPTS = 3


def _load_config() -> dict[str, Any]:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _output_config(config: dict[str, Any], channel: str) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    connectors = config.get("connectors", {})
    if isinstance(connectors, dict):
        connector_config = connectors.get(channel, {})
        if isinstance(connector_config, dict):
            merged.update(connector_config)
    output = config.get("output", {})
    if isinstance(output, dict):
        channel_config = output.get(channel, {})
        if isinstance(channel_config, dict):
            merged.update(channel_config)
    return merged


def _ok(channel: str, identity: dict[str, str] | None, destinations: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "ok": True,
        "channel": channel,
        "identity": identity,
        "destinations": destinations,
    }


def _err(channel: str, error: str) -> dict[str, Any]:
    return {
        "ok": False,
        "channel": channel,
        "identity": None,
        "destinations": [],
        "error": error,
    }


def _plain_text(items: Any) -> str:
    if not isinstance(items, list):
        return ""
    return "".join(str(item.get("plain_text", "")) for item in items if isinstance(item, dict)).strip()


def _notion_database_label(item: dict[str, Any]) -> str:
    title = _plain_text(item.get("title"))
    return title or str(item.get("id", "Untitled database"))


def _notion_page_label(item: dict[str, Any]) -> str:
    properties = item.get("properties", {})
    if isinstance(properties, dict):
        for prop in properties.values():
            if not isinstance(prop, dict):
                continue
            if prop.get("type") == "title" or isinstance(prop.get("title"), list):
                title = _plain_text(prop.get("title"))
                if title:
                    return title
    return str(item.get("id", "Untitled page"))


def _notion_search(client: Any, object_type: str) -> list[dict[str, Any]]:
    response = client.search(
        filter={"value": object_type, "property": "object"},
        sort={"direction": "descending", "timestamp": "last_edited_time"},
        page_size=50,
    )
    results = response.get("results", []) if isinstance(response, dict) else []
    return [item for item in results if isinstance(item, dict)]


def _notion_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _notion_get_json(url: str, api_key: str) -> dict[str, Any]:
    request = Request(url, headers=_notion_headers(api_key), method="GET")
    try:
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Notion API returned {exc.code}: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"Notion API request failed: {exc.reason}") from exc


def _notion_post_json(url: str, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=_notion_headers(api_key),
        method="POST",
    )
    try:
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Notion API returned {exc.code}: {body}") from exc
    except URLError as exc:
        raise RuntimeError(f"Notion API request failed: {exc.reason}") from exc


def _notion_search_rest(api_key: str, object_type: str) -> list[dict[str, Any]]:
    response = _notion_post_json(
        f"{NOTION_API_BASE}/search",
        api_key,
        {
            "filter": {"value": object_type, "property": "object"},
            "sort": {"direction": "descending", "timestamp": "last_edited_time"},
            "page_size": 50,
        },
    )
    results = response.get("results", []) if isinstance(response, dict) else []
    return [item for item in results if isinstance(item, dict)]


def _notion_identity(me: dict[str, Any]) -> dict[str, str]:
    name = str(me.get("name") or "")
    person = me.get("person", {}) if isinstance(me, dict) else {}
    email = str(person.get("email") or "") if isinstance(person, dict) else ""
    return {"label": name or email or "Notion", "detail": email}


def _notion_destinations_from_rest(api_key: str) -> dict[str, Any]:
    destinations: list[dict[str, str]] = []
    me = _notion_get_json(f"{NOTION_API_BASE}/users/me", api_key)
    for item in _notion_search_rest(api_key, "database"):
        destinations.append({
            "id": str(item.get("id", "")),
            "type": "database",
            "label": _notion_database_label(item),
            "detail": str(item.get("url") or ""),
        })
    for item in _notion_search_rest(api_key, "page"):
        destinations.append({
            "id": str(item.get("id", "")),
            "type": "page",
            "label": _notion_page_label(item),
            "detail": str(item.get("url") or ""),
        })
    return _ok("notion", _notion_identity(me), [dest for dest in destinations if dest["id"]])


def _read_zuliprc(path: str) -> dict[str, str]:
    rc_path = Path(path).expanduser()
    parser = ConfigParser()
    if not rc_path.exists():
        raise FileNotFoundError(f"zuliprc not found at {rc_path}")
    parser.read(rc_path, encoding="utf-8")
    if not parser.has_section("api"):
        raise ValueError("zuliprc missing [api] section")
    api = parser["api"]
    email = (api.get("email") or "").strip()
    key = (api.get("key") or "").strip()
    site = (api.get("site") or "").strip().rstrip("/")
    if not email or not key or not site:
        raise ValueError("zuliprc missing email, key, or site")
    return {"email": email, "key": key, "site": site}


def _is_transient_zulip_error(exc: URLError) -> bool:
    reason = exc.reason
    text = str(reason)
    return (
        isinstance(reason, ssl.SSLError)
        or "UNEXPECTED_EOF_WHILE_READING" in text
        or "EOF occurred in violation" in text
    )


def _zulip_get_json(url: str, email: str, api_key: str) -> dict[str, Any]:
    import base64

    auth = base64.b64encode(f"{email}:{api_key}".encode("utf-8")).decode("ascii")
    request = Request(url, headers={"Authorization": f"Basic {auth}", "Accept": "application/json"})
    for attempt in range(ZULIP_TRANSIENT_ATTEMPTS):
        try:
            with urlopen(request, timeout=10) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Zulip API returned {exc.code}: {body}") from exc
        except URLError as exc:
            if attempt + 1 < ZULIP_TRANSIENT_ATTEMPTS and _is_transient_zulip_error(exc):
                continue
            raise RuntimeError(f"Zulip API request failed: {exc.reason}") from exc
    raise RuntimeError("Zulip API request failed")


def _zulip_destinations_from_rest(config_file: str) -> dict[str, Any]:
    channel = "zulip"
    creds = _read_zuliprc(config_file)
    profile = _zulip_get_json(f"{creds['site']}/api/v1/users/me", creds["email"], creds["key"])
    if isinstance(profile, dict) and profile.get("result") == "success":
        label = str(profile.get("full_name") or profile.get("email") or "Zulip")
        detail = str(profile.get("email") or creds["email"])
    else:
        label = creds["email"]
        detail = creds["email"]

    subscriptions = _zulip_get_json(f"{creds['site']}/api/v1/users/me/subscriptions", creds["email"], creds["key"])
    if not isinstance(subscriptions, dict) or subscriptions.get("result") != "success":
        return _err(channel, str(subscriptions))

    destinations: list[dict[str, str]] = []
    for item in subscriptions.get("subscriptions", []):
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        stream_id = str(item.get("stream_id") or name)
        if not name:
            continue
        destinations.append({
            "id": stream_id,
            "type": "channel",
            "label": name,
            "detail": str(item.get("description") or ""),
        })
    return _ok(channel, {"label": label, "detail": detail}, destinations)


def notion_destinations(config: dict[str, Any]) -> dict[str, Any]:
    channel = "notion"
    api_key_env = str(config.get("api_key_env") or "NOTION_API_KEY")
    api_key = os.environ.get(api_key_env, "")
    if not api_key and api_key_env == "NOTION_API_KEY":
        api_key = os.environ.get("NOTION_TOKEN", "")
    if not api_key:
        return _err(channel, "Notion destination discovery is not authorized yet")

    try:
        from notion_client import Client
    except ImportError:
        try:
            return _notion_destinations_from_rest(api_key)
        except Exception as exc:
            return _err(channel, str(exc))

    try:
        client = Client(auth=api_key)
        me = client.users.me()
        identity = _notion_identity(me)

        destinations: list[dict[str, str]] = []
        for item in _notion_search(client, "database"):
            destinations.append({
                "id": str(item.get("id", "")),
                "type": "database",
                "label": _notion_database_label(item),
                "detail": str(item.get("url") or ""),
            })
        for item in _notion_search(client, "page"):
            destinations.append({
                "id": str(item.get("id", "")),
                "type": "page",
                "label": _notion_page_label(item),
                "detail": str(item.get("url") or ""),
            })
        return _ok(channel, identity, [dest for dest in destinations if dest["id"]])
    except Exception as exc:
        return _err(channel, str(exc))


def zulip_destinations(config: dict[str, Any]) -> dict[str, Any]:
    channel = "zulip"
    config_file = str(config.get("zuliprc") or "~/.zuliprc")
    try:
        import zulip
    except ImportError:
        try:
            return _zulip_destinations_from_rest(config_file)
        except Exception as exc:
            return _err(channel, str(exc))

    try:
        client = zulip.Client(config_file=config_file)
        profile = client.get_profile()
        if isinstance(profile, dict) and profile.get("result") == "success":
            label = str(profile.get("full_name") or profile.get("email") or "Zulip")
            detail = str(profile.get("email") or getattr(client, "email", "") or "")
        else:
            label = str(getattr(client, "email", "") or "Zulip")
            detail = str(getattr(client, "email", "") or "")

        subscriptions = client.get_subscriptions()
        if not isinstance(subscriptions, dict) or subscriptions.get("result") != "success":
            return _err(channel, str(subscriptions))

        destinations: list[dict[str, str]] = []
        for item in subscriptions.get("subscriptions", []):
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            stream_id = str(item.get("stream_id") or name)
            if not name:
                continue
            destinations.append({
                "id": stream_id,
                "type": "channel",
                "label": name,
                "detail": str(item.get("description") or ""),
            })
        return _ok(channel, {"label": label, "detail": detail}, destinations)
    except Exception as exc:
        return _err(channel, str(exc))


def destinations_for(channel: str, config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = _load_config() if config is None else config
    channel_config = _output_config(cfg, channel)
    if channel == "notion":
        return notion_destinations(channel_config)
    if channel == "zulip":
        return zulip_destinations(channel_config)
    return _err(channel, f"unsupported output connector: {channel}")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(json.dumps(_err("", "usage: python -m connectors.destinations <notion|zulip>")))
        return 2
    print(json.dumps(destinations_for(argv[1]), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
