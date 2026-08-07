<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="./docs/assets/banner.png">
    <img src="./docs/assets/banner.png" alt="Eye of Horus" width="360">
  </picture>

  <h1>opencode-analyze-image</h1>

  <p>A cybernetic eye for text-only models: an external vision model that lets them see images.</p>

  <p>
    <a href="https://www.npmjs.com/package/opencode-analyze-image"><img src="https://img.shields.io/npm/v/opencode-analyze-image?style=flat-square&color=c9a227" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/opencode-analyze-image"><img src="https://img.shields.io/npm/dm/opencode-analyze-image?style=flat-square&color=8b7355" alt="npm downloads"></a>
    <a href="https://github.com/cipherTing/opencode-analyze-image/releases"><img src="https://img.shields.io/github/v/release/cipherTing/opencode-analyze-image?display_name=tag&style=flat-square&color=6f5aa8" alt="GitHub release"></a>
    <a href="https://github.com/cipherTing/opencode-analyze-image/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cipherTing/opencode-analyze-image?style=flat-square&color=3d7a78" alt="License"></a>
    <a href="https://github.com/cipherTing/opencode-analyze-image/issues"><img src="https://img.shields.io/github/issues/cipherTing/opencode-analyze-image?style=flat-square&color=6b7280" alt="GitHub issues"></a>
  </p>

  <p>
    <a href="./docs/README_CN.md">简体中文</a>
    ·
    <a href="https://github.com/cipherTing/opencode-analyze-image/issues">Report an issue</a>
  </p>
</div>

> "The reason is that this, most of all the senses, makes us know and brings to light many differences between things."
>
> — Aristotle, [*Metaphysics*, Book I, Part 1](https://classics.mit.edu/Aristotle/metaphysics.1.i.html)

This is an independent community plugin for OpenCode and is not built by or affiliated with the OpenCode team.

## In Action

<p align="center">
  <img src="./docs/assets/opencode-screenshot.png" alt="opencode-analyze-image running in the OpenCode terminal" width="820">
</p>

<p align="center"><sub>Image analysis running inside an OpenCode terminal session.</sub></p>

## Installation

### Prebuilt JavaScript file

Download `analyze_image.js` from the matching GitHub Release:

```bash
mkdir -p ~/.config/opencode/plugins
curl -fL https://github.com/cipherTing/opencode-analyze-image/releases/download/v0.1.2/analyze_image.js \
  -o ~/.config/opencode/plugins/analyze_image.js
```

OpenCode automatically loads JavaScript and TypeScript files from `~/.config/opencode/plugins/` at startup. Project-level local plugins use `.opencode/plugins/` instead.

When `OPENCODE_CONFIG_DIR` is set, use that directory instead of `~/.config/opencode`.

After installation, restart OpenCode and use it normally.

### Optional terminal status

The terminal status is an optional TUI surface. The image-analysis tool works without it. To show `· Vision ON` below the terminal input, configure the TUI entry separately.

For the prebuilt JavaScript installation, download the TUI file and add its path to `~/.config/opencode/tui.json`:

```bash
mkdir -p ~/.config/opencode/tui
curl -fL https://github.com/cipherTing/opencode-analyze-image/releases/download/v0.1.2/analyze_image_tui.js \
  -o ~/.config/opencode/tui/analyze_image_tui.js
```

```json
{
  "plugin": [
    "./tui/analyze_image_tui.js"
  ]
}
```

## Configuration

Create the configuration file at:

```text
~/.config/opencode/analyze_image/config.json
```

When `OPENCODE_CONFIG_DIR` is set, use `$OPENCODE_CONFIG_DIR/analyze_image/config.json` instead.

### Minimal configuration

```json
{
  "trigger_models": [
    "deepseek/deepseek-v4-flash"
  ],
  "api_format": "openai_chat",
  "base_url": "https://api.openai.com/v1",
  "model": "your-vision-model",
  "api_key": "your-api-key",
  "reasoning": {
    "effort": "medium",
    "adaptive": true
  }
}
```

### Required fields

| Field | Description |
| --- | --- |
| `trigger_models` | Primary models that can use the plugin. Use the full `provider/model` identifier. |
| `api_format` | `openai_chat`, `openai_responses`, or `anthropic_messages`. |
| `base_url` | Auxiliary vision model API endpoint. |
| `model` | Auxiliary vision model ID. |
| `api_key` | Vision model API key, or an `{env:NAME}` / `{file:PATH}` reference. |

### Optional fields

| Field | Default | Description |
| --- | ---: | --- |
| `reasoning.effort` | `medium` | Allowed values: `none`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `reasoning.adaptive` | `true` | Anthropic Messages only: `true` uses adaptive thinking; `false` uses budget-based thinking. |
| `timeout_seconds` | `120` | Request timeout. |
| `max_retries` | `2` | Number of request retries. |
| `max_output_tokens` | `4096` | Maximum visible output length. |

### API keys

The key may be written directly, read from an environment variable, or read from a file:

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

Image size and directory limits can use the defaults in [config.example.json](./config.example.json). Change the `image` section only when needed.

## Full Configuration

See [config.example.json](./config.example.json) for the complete field list.

## License

MIT
