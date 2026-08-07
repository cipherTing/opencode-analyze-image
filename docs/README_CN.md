# opencode-analyze-image

[English](../README.md) | [简体中文](README_CN.md)

> 这是一个独立的社区项目，并非 OpenCode 团队制作，也不隶属于 OpenCode 官方。

让 OpenCode 中的文本模型获得图片理解能力。

配置完成后，正常使用 OpenCode 即可。当模型需要识别图片时，会使用 `analyze_image`，并将结果返回到当前对话。

## 安装

选择以下任一种安装方式即可。

### npm 包

在 OpenCode 配置文件中将 `opencode-analyze-image` 加入 `plugin` 数组。配置文件通常位于 `~/.config/opencode/opencode.json`：

```json
{
  "plugin": [
    "opencode-analyze-image"
  ]
}
```

如果已有其他插件，请追加这个条目，不要覆盖原有数组。OpenCode 启动时会安装 npm 插件，不需要拉取源码。

### 预构建 JavaScript 文件

从对应版本的 GitHub Release 下载 `analyze_image.js`，放入 OpenCode 的全局插件目录：

```bash
mkdir -p ~/.config/opencode/plugins
curl -fL https://github.com/cipherTing/opencode-analyze-image/releases/download/v0.1.1/analyze_image.js \
  -o ~/.config/opencode/plugins/analyze_image.js
```

这种方式不需要克隆项目。如果设置了 `OPENCODE_CONFIG_DIR`，请用该目录替代 `~/.config/opencode`。

完成任一种安装后，重启 OpenCode，然后正常使用即可。当模型需要识别图片时，会调用 `analyze_image`，并将结果返回到当前对话。

## 配置

配置文件：

```text
~/.config/opencode/analyze_image/config.json
```

如果设置了 `OPENCODE_CONFIG_DIR`，则使用 `$OPENCODE_CONFIG_DIR/analyze_image/config.json`。

最小配置示例：

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

### 必填字段

| 字段 | 说明 |
| --- | --- |
| `trigger_models` | 允许使用插件的主模型列表，填写完整的 `provider/model`。 |
| `api_format` | 接口格式，可选 `openai_chat`、`openai_responses`、`anthropic_messages`。 |
| `base_url` | 视觉模型接口地址。 |
| `model` | 视觉模型 ID。 |
| `api_key` | 视觉模型 API Key，也可以使用 `{env:NAME}` 或 `{file:PATH}` 引用。 |

API Key 可以直接填写，也可以从环境变量或文件中读取：

```json
"api_key": "your-api-key"
```

```json
"api_key": "{env:ANALYZE_IMAGE_API_KEY}"
```

```json
"api_key": "{file:~/.secrets/analyze-image-key}"
```

相对文件路径会按 `config.json` 所在目录解析。

`trigger_models` 使用精确匹配。模型 ID 自身包含斜杠时，保留完整名称即可。

### 可选字段

| 字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `timeout_seconds` | `120` | 请求超时时间。 |
| `max_retries` | `2` | 请求重试次数。 |
| `max_output_tokens` | `4096` | 最大输出长度。 |

图片相关限制配置可以直接沿用 `config.example.json` 中的默认值，只有需要调整时再修改 `image` 节点。

## 完整配置

完整字段清单见 [config.example.json](../config.example.json)。

## 许可证

MIT
