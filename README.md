# opencode-analyze-image

[English](README.md) | [简体中文](docs/README_CN.md)

> This is an independent community project. It is not built by or affiliated with the OpenCode team.

Give text-only models in OpenCode the ability to understand images.

After configuration, use OpenCode normally. When the model needs to inspect an image, it can call `analyze_image` and receive the result in the current conversation.

## Installation

Choose one of the following installation methods.

### npm package

Add `opencode-analyze-image` to the `plugin` array in your OpenCode configuration, usually `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "opencode-analyze-image"
  ]
}
```

Append it to an existing array instead of replacing your other plugins. OpenCode installs npm plugins when it starts. No source checkout is required.

### Prebuilt JavaScript file

Download `analyze_image.js` from the GitHub Release that matches the version you want, then place it in the global OpenCode plugins directory:

```bash
mkdir -p ~/.config/opencode/plugins
curl -fL https://github.com/cipherTing/opencode-analyze-image/releases/download/v0.1.1/analyze_image.js \
  -o ~/.config/opencode/plugins/analyze_image.js
```

This method does not require cloning the repository. When `OPENCODE_CONFIG_DIR` is set, use that directory instead of `~/.config/opencode`.

After either installation method, restart OpenCode and use it normally. When the model needs to inspect an image, it can call `analyze_image` and return the result to the current conversation.

## Configuration

Configuration file:

```text
~/.config/opencode/analyze_image/config.json
```

When `OPENCODE_CONFIG_DIR` is set, use `$OPENCODE_CONFIG_DIR/analyze_image/config.json` instead.

Minimal configuration:

```json
{
  "trigger_models": [
    "deepseek/deepseek-v4-flash"
  ],
  "api_format": "openai_chat",
  "base_url": "https://api.openai.com/v1",
  "model": "your-vision-model",
  "api_key": "your-api-key"
}
```

### Required fields

| Field | Description |
| --- | --- |
| `trigger_models` | Primary models that can use the plugin. Use the full `provider/model` identifier. |
| `api_format` | API format: `openai_chat`, `openai_responses`, or `anthropic_messages`. |
| `base_url` | Vision model API endpoint. |
| `model` | Vision model ID. |
| `api_key` | Vision model API key, or an `{env:NAME}` / `{file:PATH}` reference. |

The API key can be written directly, read from an environment variable, or read from a file:

```json
"api_key": "your-api-key"
```

```json
"api_key": "{env:ANALYZE_IMAGE_API_KEY}"
```

```json
"api_key": "{file:~/.secrets/analyze-image-key}"
```

Relative file paths are resolved relative to `config.json`.

`trigger_models` uses exact matching. Keep the complete identifier when a model ID contains additional slashes.

### Optional fields

| Field | Default | Description |
| --- | ---: | --- |
| `timeout_seconds` | `120` | Request timeout. |
| `max_retries` | `2` | Number of request retries. |
| `max_output_tokens` | `4096` | Maximum output length. |

Image size and directory limits can use the defaults in [config.example.json](./config.example.json). Change the `image` section only when needed.

## Full configuration

See [config.example.json](./config.example.json) for the complete field list.

## License

MIT
