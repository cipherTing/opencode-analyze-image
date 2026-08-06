from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image


PYTHON_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PYTHON_DIR))

import analyze_image as subject  # noqa: E402


class ExtractionTests(unittest.TestCase):
    def test_chat_prefers_visible_content(self) -> None:
        response = SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content="visible", reasoning_content="hidden reasoning")
                )
            ]
        )
        result = subject.extract_chat_result(response)
        self.assertEqual(result.text, "visible")
        self.assertFalse(result.used_reasoning)

    def test_chat_falls_back_to_reasoning(self) -> None:
        response = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="", reasoning_content="reasoned answer"))]
        )
        result = subject.extract_chat_result(response)
        self.assertEqual(result.text, "reasoned answer")
        self.assertTrue(result.used_reasoning)

    def test_responses_falls_back_to_reasoning_summary(self) -> None:
        response = SimpleNamespace(
            output_text="",
            output=[SimpleNamespace(type="reasoning", summary=[SimpleNamespace(type="text", text="summary")])],
        )
        result = subject.extract_responses_result(response)
        self.assertEqual(result.text, "summary")
        self.assertTrue(result.used_reasoning)


class ImageTests(unittest.TestCase):
    def test_directory_images_are_prepared(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (32, 32), color="red").save(root / "a.png")
            Image.new("RGB", (32, 32), color="blue").save(root / "b.jpg")
            config = {
                "image": {
                    "max_source_bytes": 1024 * 1024,
                    "max_image_bytes": 1024 * 1024,
                    "max_dimension": 8000,
                    "resize_target": 2048,
                    "directory_max_images": 10,
                    "directory_recursive": True,
                }
            }
            images = subject.prepare_images(str(root), str(root), config)
            self.assertEqual([item.name for item in images], ["a.png", "b.jpg"])
            self.assertTrue(all(item.mime.startswith("image/") for item in images))

    def test_private_network_opt_in_still_returns_pinned_addresses(self) -> None:
        with patch.object(
            subject.socket,
            "getaddrinfo",
            return_value=[
                (subject.socket.AF_INET, subject.socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80)),
            ],
        ):
            addresses = subject.resolved_addresses("http://localhost/image.png", allow_private=True)

        self.assertEqual(addresses, ["127.0.0.1"])

    def test_private_network_is_blocked_by_default(self) -> None:
        with patch.object(
            subject.socket,
            "getaddrinfo",
            return_value=[
                (subject.socket.AF_INET, subject.socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80)),
            ],
        ):
            with self.assertRaises(subject.AnalyzeImageError) as raised:
                subject.resolved_addresses("http://localhost/image.png", allow_private=False)

        self.assertEqual(raised.exception.code, "private_network_blocked")

    def test_prompt_uses_generic_description_without_instruction(self) -> None:
        image = subject.PreparedImage("a.png", "image/png", b"abc")
        prompt = subject.prompt_text(
            {"prompt": {"template": subject.DEFAULT_PROMPT}},
            None,
            [image],
        )
        self.assertIn("Fully describe and explain everything visible in this image", prompt)

    def test_prompt_appends_optional_instruction(self) -> None:
        image = subject.PreparedImage("a.png", "image/png", b"abc")
        prompt = subject.prompt_text(
            {"prompt": {"template": subject.DEFAULT_PROMPT}},
            "Read all visible text.",
            [image],
        )
        self.assertTrue(prompt.endswith("Read all visible text."))


class ProviderPayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = {
            "api_format": "openai_chat",
            "base_url": "https://example.test/v1",
            "model": "vision-test",
            "api_key": "test-key",
            "timeout_seconds": 30,
            "max_retries": 0,
            "max_output_tokens": 512,
            "temperature": None,
            "headers": {},
            "openai_chat": {"max_tokens_parameter": "max_tokens"},
            "image": {"detail": "auto"},
        }
        self.images = [subject.PreparedImage("a.png", "image/png", b"abc")]

    def test_openai_chat_uses_image_url_content(self) -> None:
        captured: dict[str, object] = {}

        class FakeOpenAI:
            def __init__(self, **kwargs: object) -> None:
                captured["client"] = kwargs
                self.chat = SimpleNamespace(
                    completions=SimpleNamespace(create=self.create_chat)
                )

            def create_chat(self, **kwargs: object) -> object:
                captured["request"] = kwargs
                return SimpleNamespace(
                    choices=[SimpleNamespace(message=SimpleNamespace(content="ok"))]
                )

            def close(self) -> None:
                pass

        with patch.dict(sys.modules, {"openai": SimpleNamespace(OpenAI=FakeOpenAI)}):
            result = subject.analyze_openai_chat(self.config, self.images, "question")

        self.assertEqual(result.text, "ok")
        content = captured["request"]["messages"][0]["content"]  # type: ignore[index]
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/png;base64,"))

    def test_openai_responses_uses_input_image_content(self) -> None:
        captured: dict[str, object] = {}

        class FakeOpenAI:
            def __init__(self, **kwargs: object) -> None:
                self.responses = SimpleNamespace(create=self.create_response)

            def create_response(self, **kwargs: object) -> object:
                captured["request"] = kwargs
                return SimpleNamespace(output_text="ok")

            def close(self) -> None:
                pass

        with patch.dict(sys.modules, {"openai": SimpleNamespace(OpenAI=FakeOpenAI)}):
            result = subject.analyze_openai_responses(self.config, self.images, "question")

        self.assertEqual(result.text, "ok")
        content = captured["request"]["input"][0]["content"]  # type: ignore[index]
        self.assertEqual(content[1]["type"], "input_image")

    def test_anthropic_uses_base64_image_source(self) -> None:
        captured: dict[str, object] = {}

        class FakeAnthropic:
            def __init__(self, **kwargs: object) -> None:
                self.messages = SimpleNamespace(create=self.create_message)

            def create_message(self, **kwargs: object) -> object:
                captured["request"] = kwargs
                return SimpleNamespace(
                    content=[SimpleNamespace(type="text", text="ok")]
                )

            def close(self) -> None:
                pass

        with patch.dict(
            sys.modules,
            {"anthropic": SimpleNamespace(Anthropic=FakeAnthropic)},
        ):
            result = subject.analyze_anthropic(self.config, self.images, "question")

        self.assertEqual(result.text, "ok")
        content = captured["request"]["messages"][0]["content"]  # type: ignore[index]
        image = content[0]
        self.assertEqual(image["type"], "image")
        self.assertEqual(image["source"]["type"], "base64")


if __name__ == "__main__":
    unittest.main()
