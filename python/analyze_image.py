#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import http.client
import io
import ipaddress
import json
import mimetypes
import os
import re
import socket
import ssl
import sys
import urllib.parse
import urllib.request
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SUPPORTED_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".bmp",
    ".tif",
    ".tiff",
}

SUPPORTED_MIME_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
}

DEFAULT_PROMPT = (
    "Fully describe and explain everything visible in this image. Include visible text, people, "
    "objects, layout, colors, spatial relationships, important details, and any uncertainty."
)


class AnalyzeImageError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class PreparedImage:
    name: str
    mime: str
    data: bytes
    width: int = 0
    height: int = 0
    source_bytes: int = 0

    @property
    def data_url(self) -> str:
        encoded = base64.b64encode(self.data).decode("ascii")
        return f"data:{self.mime};base64,{encoded}"


@dataclass
class AnalysisResult:
    text: str
    used_reasoning: bool


def object_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump()
        if isinstance(dumped, dict):
            return dumped
    return {}


def get_value(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def string_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    return ""


def extract_text_blocks(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, list):
        return ""

    chunks: list[str] = []
    for block in value:
        block_type = get_value(block, "type", "")
        if block_type in {"text", "output_text"}:
            text = string_value(get_value(block, "text", ""))
            if text:
                chunks.append(text)
            continue

        text_value = get_value(block, "text", None)
        if isinstance(text_value, str) and text_value.strip():
            chunks.append(text_value.strip())
            continue
        if text_value is not None:
            nested = string_value(get_value(text_value, "value", ""))
            if nested:
                chunks.append(nested)
    return "\n".join(chunks).strip()


def extract_reasoning(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        chunks: list[str] = []
        for block in value:
            text = string_value(get_value(block, "thinking", ""))
            if not text:
                text = string_value(get_value(block, "text", ""))
            if not text:
                text = extract_text_blocks(get_value(block, "summary", []))
            if text:
                chunks.append(text)
        return "\n".join(chunks).strip()
    if value is not None:
        text = string_value(get_value(value, "text", ""))
        if text:
            return text
        return extract_text_blocks(get_value(value, "summary", []))
    return ""


def extract_chat_result(response: Any) -> AnalysisResult:
    choices = get_value(response, "choices", [])
    if not choices:
        raise AnalyzeImageError("empty_response", "The OpenAI chat response contained no choices.")
    message = get_value(choices[0], "message", {})
    content = extract_text_blocks(get_value(message, "content", ""))
    if content:
        return AnalysisResult(content, False)

    for key in ("reasoning_content", "reasoning", "thinking"):
        reasoning = extract_reasoning(get_value(message, key, None))
        if reasoning:
            return AnalysisResult(reasoning, True)

    extra = object_dict(get_value(message, "model_extra", {}))
    for key in ("reasoning_content", "reasoning", "thinking"):
        reasoning = extract_reasoning(extra.get(key))
        if reasoning:
            return AnalysisResult(reasoning, True)
    raise AnalyzeImageError("empty_response", "The OpenAI chat response contained no content or reasoning.")


def extract_responses_result(response: Any) -> AnalysisResult:
    output_text = string_value(get_value(response, "output_text", ""))
    if output_text:
        return AnalysisResult(output_text, False)

    reasoning_chunks: list[str] = []
    for item in get_value(response, "output", []) or []:
        item_type = get_value(item, "type", "")
        if item_type == "message":
            text = extract_text_blocks(get_value(item, "content", []))
            if text:
                return AnalysisResult(text, False)
        if item_type == "reasoning":
            reasoning = extract_reasoning(item)
            if reasoning:
                reasoning_chunks.append(reasoning)

    if reasoning_chunks:
        return AnalysisResult("\n".join(reasoning_chunks), True)

    extra = object_dict(get_value(response, "model_extra", {}))
    for key in ("reasoning_content", "reasoning", "thinking"):
        reasoning = extract_reasoning(extra.get(key))
        if reasoning:
            return AnalysisResult(reasoning, True)
    raise AnalyzeImageError("empty_response", "The OpenAI Responses result contained no content or reasoning.")


def extract_anthropic_result(message: Any) -> AnalysisResult:
    content = get_value(message, "content", []) or []
    visible: list[str] = []
    reasoning: list[str] = []
    for block in content:
        block_type = get_value(block, "type", "")
        if block_type == "text":
            text = string_value(get_value(block, "text", ""))
            if text:
                visible.append(text)
        elif block_type in {"thinking", "reasoning"}:
            text = extract_reasoning(block)
            if text:
                reasoning.append(text)
    if visible:
        return AnalysisResult("\n".join(visible), False)
    if reasoning:
        return AnalysisResult("\n".join(reasoning), True)
    raise AnalyzeImageError("empty_response", "The Anthropic response contained no content or reasoning.")


def expand_env(value: str) -> str:
    pattern = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}")

    def replace(match: re.Match[str]) -> str:
        name = match.group(1) or match.group(2)
        result = os.environ.get(name)
        if result is None:
            raise AnalyzeImageError("missing_environment", f"Environment variable {name} is not set.")
        return result

    return pattern.sub(replace, value)


def api_key(config: dict[str, Any]) -> str:
    direct = config.get("api_key")
    if isinstance(direct, str) and direct:
        return expand_env(direct)
    env_name = config.get("api_key_env")
    if not isinstance(env_name, str) or not env_name:
        raise AnalyzeImageError("missing_api_key", "api_key_env or api_key must be configured.")
    value = os.environ.get(env_name)
    if not value:
        raise AnalyzeImageError("missing_api_key", f"Environment variable {env_name} is not set.")
    return value


def default_headers(config: dict[str, Any]) -> dict[str, str]:
    raw = config.get("headers", {})
    if not isinstance(raw, dict):
        return {}
    return {str(key): expand_env(str(value)) for key, value in raw.items()}


def resolved_addresses(url: str, allow_private: bool) -> list[str]:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise AnalyzeImageError("unsupported_url", "Only HTTP and HTTPS image URLs are supported.")
    if not parsed.hostname:
        raise AnalyzeImageError("invalid_url", "Image URL has no hostname.")
    try:
        entries = socket.getaddrinfo(
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except OSError as error:
        raise AnalyzeImageError("url_resolution_failed", f"Cannot resolve image URL hostname: {error}") from error

    result: list[str] = []
    for entry in entries:
        address = ipaddress.ip_address(entry[4][0])
        if not allow_private and not address.is_global:
            raise AnalyzeImageError(
                "private_network_blocked",
                f"Image URL resolves to non-public address {address}. Set image.allow_private_network=true to allow it.",
            )
        value = str(address)
        if value not in result:
            result.append(value)
    if not result:
        raise AnalyzeImageError("url_resolution_failed", "Image URL did not resolve to a usable address.")
    return result


class PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, hostname: str, port: int, address: str, timeout: float):
        super().__init__(hostname, port, timeout=timeout)
        self.address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self.address, self.port), self.timeout)


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, port: int, address: str, timeout: float):
        super().__init__(hostname, port, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self) -> None:
        raw = socket.create_connection((self.address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def download_once(url: str, address: str, timeout: float) -> tuple[Any, Any]:
    parsed = urllib.parse.urlparse(url)
    hostname = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    connection: Any
    if parsed.scheme == "https":
        connection = PinnedHTTPSConnection(hostname, port, address, timeout)
    else:
        connection = PinnedHTTPConnection(hostname, port, address, timeout)
    path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
    host_header = hostname
    if parsed.port is not None:
        host_header = f"{hostname}:{parsed.port}"
    connection.request("GET", path, headers={"Host": host_header, "User-Agent": "opencode-analyze-image/0.1"})
    return connection, connection.getresponse()


def download_url(url: str, config: dict[str, Any]) -> tuple[bytes, str, str]:
    image_config = config.get("image", {})
    if not image_config.get("allow_remote_url", True):
        raise AnalyzeImageError("remote_url_disabled", "Remote image URLs are disabled by configuration.")
    allow_private = bool(image_config.get("allow_private_network", False))
    max_bytes = int(image_config.get("max_source_bytes", 25 * 1024 * 1024))
    timeout = float(config.get("timeout_seconds", 120))
    current = url
    for _ in range(6):
        addresses = resolved_addresses(current, allow_private)
        last_error: Exception | None = None
        for address in addresses:
            connection = None
            try:
                connection, response = download_once(current, address, timeout)
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location")
                    if not location:
                        raise AnalyzeImageError("image_download_failed", "Remote image redirect had no Location header.")
                    current = urllib.parse.urljoin(current, location)
                    break
                if response.status < 200 or response.status >= 300:
                    raise AnalyzeImageError(
                        "image_download_failed",
                        f"Remote image server returned HTTP {response.status}.",
                    )
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > max_bytes:
                    raise AnalyzeImageError("image_too_large", f"Remote image exceeds {max_bytes} bytes.")
                data = response.read(max_bytes + 1)
                if len(data) > max_bytes:
                    raise AnalyzeImageError("image_too_large", f"Remote image exceeds {max_bytes} bytes.")
                mime = response.headers.get_content_type() or "application/octet-stream"
                name = Path(urllib.parse.urlparse(current).path).name or "remote-image"
                return data, mime, name
            except AnalyzeImageError:
                raise
            except Exception as error:
                last_error = error
            finally:
                if connection is not None:
                    connection.close()
        else:
            raise AnalyzeImageError(
                "image_download_failed",
                f"Cannot download image URL: {last_error or 'connection failed'}",
            )
        continue
    raise AnalyzeImageError("image_download_failed", "Remote image exceeded the redirect limit.")


def parse_data_url(value: str, max_bytes: int) -> tuple[bytes, str, str]:
    match = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", value, re.DOTALL)
    if not match:
        raise AnalyzeImageError("invalid_data_url", "Invalid image data URL.")
    mime = match.group(1) or "application/octet-stream"
    if match.group(2) and len(match.group(3)) * 3 // 4 > max_bytes:
        raise AnalyzeImageError("image_too_large", f"Image data URL exceeds {max_bytes} bytes.")
    try:
        data = (
            base64.b64decode(match.group(3), validate=True)
            if match.group(2)
            else urllib.parse.unquote_to_bytes(match.group(3))
        )
    except Exception as error:
        raise AnalyzeImageError("invalid_data_url", f"Cannot decode image data URL: {error}") from error
    if len(data) > max_bytes:
        raise AnalyzeImageError("image_too_large", f"Image data URL exceeds {max_bytes} bytes.")
    extension = mimetypes.guess_extension(mime) or ".img"
    return data, mime, f"inline{extension}"


def image_paths(directory: Path, recursive: bool, maximum: int) -> list[Path]:
    paths: list[Path] = []
    for root, directories, files in os.walk(directory):
        directories.sort()
        files.sort()
        if not recursive:
            directories.clear()
        for filename in files:
            path = Path(root) / filename
            if path.is_symlink() or path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                continue
            paths.append(path)
            if len(paths) >= maximum:
                return paths
    if not paths:
        raise AnalyzeImageError("no_images_found", f"No supported images found in directory {directory}.")
    return paths


def read_local(path: Path, max_bytes: int) -> tuple[bytes, str, str]:
    try:
        size = path.stat().st_size
    except OSError as error:
        raise AnalyzeImageError("image_not_found", f"Cannot access image {path}: {error}") from error
    if size > max_bytes:
        raise AnalyzeImageError("image_too_large", f"Image {path.name} exceeds {max_bytes} bytes.")
    try:
        data = path.read_bytes()
    except OSError as error:
        raise AnalyzeImageError("image_read_failed", f"Cannot read image {path}: {error}") from error
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return data, mime, path.name


def resolve_sources(reference: str, cwd: str, config: dict[str, Any]) -> list[tuple[bytes, str, str]]:
    image_config = config.get("image", {})
    max_bytes = int(image_config.get("max_source_bytes", 25 * 1024 * 1024))
    max_total_source_bytes = int(image_config.get("max_total_source_bytes", 50 * 1024 * 1024))

    if reference.startswith("data:"):
        return [parse_data_url(reference, max_bytes)]
    if reference.startswith("http://") or reference.startswith("https://"):
        return [download_url(reference, config)]

    if reference.startswith("file:"):
        parsed = urllib.parse.urlparse(reference)
        path = Path(urllib.request.url2pathname(parsed.path))
    else:
        path = Path(os.path.expanduser(reference))
        if not path.is_absolute():
            path = Path(cwd) / path
    path = path.resolve()

    if path.is_dir():
        maximum = max(1, int(image_config.get("directory_max_images", 10)))
        recursive = bool(image_config.get("directory_recursive", True))
        sources: list[tuple[bytes, str, str]] = []
        total = 0
        for item in image_paths(path, recursive, maximum):
            source = read_local(item, max_bytes)
            total += len(source[0])
            if total > max_total_source_bytes:
                raise AnalyzeImageError(
                    "image_batch_too_large",
                    f"Images in directory exceed {max_total_source_bytes} total source bytes.",
                )
            sources.append(source)
        return sources
    if not path.is_file():
        raise AnalyzeImageError("image_not_found", f"Image path does not exist: {path}")
    return [read_local(path, max_bytes)]


def pillow() -> tuple[Any, Any]:
    try:
        from PIL import Image, ImageOps
    except ImportError as error:
        raise AnalyzeImageError(
            "missing_dependency",
            "Pillow is required. Install python/requirements.txt for this plugin.",
        ) from error
    return Image, ImageOps


def normalize_image(raw: bytes, mime_hint: str, name: str, config: dict[str, Any]) -> PreparedImage:
    Image, ImageOps = pillow()
    image_config = config.get("image", {})
    max_bytes = int(image_config.get("max_image_bytes", 10 * 1024 * 1024))
    max_dimension = max(1, int(image_config.get("max_dimension", 8000)))
    resize_target = max(256, int(image_config.get("resize_target", 2048)))
    Image.MAX_IMAGE_PIXELS = max_dimension * max_dimension

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as opened:
                opened.seek(0)
                image = ImageOps.exif_transpose(opened).copy()
                source_format = (opened.format or "").upper()
    except Exception as error:
        raise AnalyzeImageError("invalid_image", f"Cannot decode image {name}: {error}") from error

    width, height = image.size
    supported_format = source_format in {"PNG", "JPEG", "WEBP"}
    guessed_mime = Image.MIME.get(source_format, mime_hint)
    if (
        supported_format
        and guessed_mime in SUPPORTED_MIME_TYPES
        and len(raw) <= max_bytes
        and width <= max_dimension
        and height <= max_dimension
    ):
        return PreparedImage(
            name=name,
            mime=guessed_mime,
            data=raw,
            width=width,
            height=height,
            source_bytes=len(raw),
        )

    if max(width, height) > resize_target:
        image.thumbnail((resize_target, resize_target), Image.Resampling.LANCZOS)

    has_alpha = image.mode in {"RGBA", "LA"} or "transparency" in image.info
    if has_alpha:
        image = image.convert("RGBA")
        output_format = "PNG"
        output_mime = "image/png"
    else:
        image = image.convert("RGB")
        output_format = "JPEG"
        output_mime = "image/jpeg"

    quality = 88
    while True:
        buffer = io.BytesIO()
        if output_format == "JPEG":
            image.save(buffer, format=output_format, quality=quality, optimize=True)
        else:
            image.save(buffer, format=output_format, optimize=True)
        data = buffer.getvalue()
        if len(data) <= max_bytes:
            return PreparedImage(
                name=name,
                mime=output_mime,
                data=data,
                width=image.width,
                height=image.height,
                source_bytes=len(raw),
            )
        if min(image.size) <= 256:
            raise AnalyzeImageError("image_too_large", f"Image {name} cannot be reduced below {max_bytes} bytes.")
        image.thumbnail((max(256, int(image.width * 0.8)), max(256, int(image.height * 0.8))), Image.Resampling.LANCZOS)
        quality = max(60, quality - 5)


def prepare_images(reference: str, cwd: str, config: dict[str, Any]) -> list[PreparedImage]:
    return [normalize_image(data, mime, name, config) for data, mime, name in resolve_sources(reference, cwd, config)]


def prompt_text(config: dict[str, Any], instruction: str | None, images: list[PreparedImage]) -> str:
    prompt_config = config.get("prompt", {})
    template = prompt_config.get("template", DEFAULT_PROMPT)
    if not isinstance(template, str) or not template.strip():
        raise AnalyzeImageError("invalid_config", "prompt.template must not be empty.")
    focus = instruction.strip() if isinstance(instruction, str) and instruction.strip() else ""
    prompt = template.replace("{instruction}", focus).strip()
    if focus and "{instruction}" not in template:
        prompt = f"{prompt}\n\nPay particular attention to the following request:\n{focus}"
    if len(images) > 1:
        names = "\n".join(f"- Image {index + 1}: {image.name}" for index, image in enumerate(images))
        prompt = f"The following images were provided:\n{names}\n\n{prompt}"
    return prompt


def openai_client(config: dict[str, Any]) -> Any:
    try:
        from openai import OpenAI
    except ImportError as error:
        raise AnalyzeImageError(
            "missing_dependency",
            "The official openai Python SDK is not installed. Install python/requirements.txt.",
        ) from error

    kwargs: dict[str, Any] = {
        "api_key": api_key(config),
        "base_url": config["base_url"],
        "timeout": float(config.get("timeout_seconds", 120)),
        "max_retries": int(config.get("max_retries", 2)),
    }
    headers = default_headers(config)
    if headers:
        kwargs["default_headers"] = headers
    return OpenAI(**kwargs)


def analyze_openai_chat(config: dict[str, Any], images: list[PreparedImage], prompt: str) -> AnalysisResult:
    client = openai_client(config)
    detail = config.get("image", {}).get("detail", "auto")
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for index, image in enumerate(images):
        if len(images) > 1:
            content.append({"type": "text", "text": f"Image {index + 1}: {image.name}"})
        content.append(
            {
                "type": "image_url",
                "image_url": {
                    "url": image.data_url,
                    "detail": detail,
                },
            }
        )

    kwargs: dict[str, Any] = {
        "model": config["model"],
        "messages": [{"role": "user", "content": content}],
    }
    max_tokens = int(config.get("max_output_tokens", 4096))
    parameter = config.get("openai_chat", {}).get("max_tokens_parameter", "max_tokens")
    kwargs[parameter] = max_tokens
    if config.get("temperature") is not None:
        kwargs["temperature"] = float(config["temperature"])

    try:
        return extract_chat_result(client.chat.completions.create(**kwargs))
    except AnalyzeImageError:
        raise
    except Exception as error:
        raise AnalyzeImageError("provider_request_failed", f"OpenAI chat request failed: {error}") from error
    finally:
        client.close()


def analyze_openai_responses(config: dict[str, Any], images: list[PreparedImage], prompt: str) -> AnalysisResult:
    client = openai_client(config)
    detail = config.get("image", {}).get("detail", "auto")
    content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
    for image in images:
        content.append(
            {
                "type": "input_image",
                "image_url": image.data_url,
                "detail": detail,
            }
        )

    kwargs: dict[str, Any] = {
        "model": config["model"],
        "input": [{"role": "user", "content": content}],
        "max_output_tokens": int(config.get("max_output_tokens", 4096)),
    }
    if config.get("temperature") is not None:
        kwargs["temperature"] = float(config["temperature"])

    try:
        return extract_responses_result(client.responses.create(**kwargs))
    except AnalyzeImageError:
        raise
    except Exception as error:
        raise AnalyzeImageError("provider_request_failed", f"OpenAI Responses request failed: {error}") from error
    finally:
        client.close()


def analyze_anthropic(config: dict[str, Any], images: list[PreparedImage], prompt: str) -> AnalysisResult:
    try:
        from anthropic import Anthropic
    except ImportError as error:
        raise AnalyzeImageError(
            "missing_dependency",
            "The official anthropic Python SDK is not installed. Install python/requirements.txt.",
        ) from error

    kwargs: dict[str, Any] = {
        "api_key": api_key(config),
        "base_url": config["base_url"],
        "timeout": float(config.get("timeout_seconds", 120)),
        "max_retries": int(config.get("max_retries", 2)),
    }
    headers = default_headers(config)
    if headers:
        kwargs["default_headers"] = headers
    client = Anthropic(**kwargs)

    content: list[dict[str, Any]] = []
    for index, image in enumerate(images):
        if len(images) > 1:
            content.append({"type": "text", "text": f"Image {index + 1}: {image.name}"})
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image.mime,
                    "data": base64.b64encode(image.data).decode("ascii"),
                },
            }
        )
    content.append({"type": "text", "text": prompt})

    request: dict[str, Any] = {
        "model": config["model"],
        "max_tokens": int(config.get("max_output_tokens", 4096)),
        "messages": [{"role": "user", "content": content}],
    }
    if config.get("temperature") is not None:
        request["temperature"] = float(config["temperature"])

    try:
        return extract_anthropic_result(client.messages.create(**request))
    except AnalyzeImageError:
        raise
    except Exception as error:
        raise AnalyzeImageError("provider_request_failed", f"Anthropic request failed: {error}") from error
    finally:
        client.close()


def analyze(config: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    references = request.get("image_urls")
    if references is None and isinstance(request.get("image_url"), str):
        references = [request["image_url"]]
    instruction = request.get("instruction")
    cwd = request.get("cwd") or os.getcwd()
    if not isinstance(references, list) or not references:
        raise AnalyzeImageError("invalid_request", "At least one image source is required.")
    normalized = [item.strip() for item in references if isinstance(item, str) and item.strip()]
    if len(normalized) != len(references):
        raise AnalyzeImageError("invalid_request", "image_urls must contain only non-empty strings.")
    if instruction is not None and not isinstance(instruction, str):
        raise AnalyzeImageError("invalid_request", "instruction must be a string when provided.")

    maximum = max(1, int(config.get("image", {}).get("directory_max_images", 10)))
    image_config = config.get("image", {})
    max_total_source_bytes = int(image_config.get("max_total_source_bytes", 50 * 1024 * 1024))
    max_total_image_bytes = int(image_config.get("max_total_image_bytes", 25 * 1024 * 1024))
    max_total_pixels = int(image_config.get("max_total_pixels", 80_000_000))
    images: list[PreparedImage] = []
    total_source_bytes = 0
    total_image_bytes = 0
    total_pixels = 0
    for reference in normalized:
        for image in prepare_images(reference, str(cwd), config):
            total_source_bytes += image.source_bytes
            total_image_bytes += len(image.data)
            total_pixels += image.width * image.height
            if total_source_bytes > max_total_source_bytes:
                raise AnalyzeImageError(
                    "image_batch_too_large",
                    f"Image sources exceed {max_total_source_bytes} total source bytes.",
                )
            if total_image_bytes > max_total_image_bytes:
                raise AnalyzeImageError(
                    "image_batch_too_large",
                    f"Normalized images exceed {max_total_image_bytes} total bytes.",
                )
            if total_pixels > max_total_pixels:
                raise AnalyzeImageError(
                    "image_batch_too_large",
                    f"Images exceed {max_total_pixels} total pixels.",
                )
            images.append(image)
            if len(images) >= maximum:
                break
        if len(images) >= maximum:
            break
    prompt = prompt_text(config, instruction, images)
    api_format = config.get("api_format")
    if api_format == "openai_chat":
        result = analyze_openai_chat(config, images, prompt)
    elif api_format == "openai_responses":
        result = analyze_openai_responses(config, images, prompt)
    elif api_format == "anthropic_messages":
        result = analyze_anthropic(config, images, prompt)
    else:
        raise AnalyzeImageError("invalid_config", f"Unsupported api_format: {api_format}")

    return {
        "success": True,
        "analysis": result.text,
        "model": str(config.get("model", "")),
        "api_format": api_format,
        "source_count": len(images),
        "sources": [image.name for image in images],
        "used_reasoning": result.used_reasoning,
    }


def load_config(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except Exception as error:
        raise AnalyzeImageError("invalid_config", f"Cannot read config {path}: {error}") from error
    if not isinstance(config, dict):
        raise AnalyzeImageError("invalid_config", "Config root must be a JSON object.")
    for field in ("api_format", "base_url", "model"):
        if not isinstance(config.get(field), str) or not config[field]:
            raise AnalyzeImageError("invalid_config", f"{field} is required.")
    return config


def read_request() -> dict[str, Any]:
    try:
        value = json.load(sys.stdin)
    except Exception as error:
        raise AnalyzeImageError("invalid_request", f"Cannot parse worker input JSON: {error}") from error
    if not isinstance(value, dict):
        raise AnalyzeImageError("invalid_request", "Worker input must be a JSON object.")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze images for the OpenCode analyze_image plugin.")
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    try:
        output = analyze(load_config(args.config), read_request())
    except AnalyzeImageError as error:
        output = {
            "success": False,
            "error": {
                "code": error.code,
                "message": error.message,
            },
        }
    except Exception as error:
        output = {
            "success": False,
            "error": {
                "code": "unexpected_error",
                "message": str(error),
            },
        }

    json.dump(output, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
