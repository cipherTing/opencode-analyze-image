# opencode-analyze-image

[English](../README.md) | [简体中文](README_CN.md)

> 这是一个独立的社区项目，并非 OpenCode 团队制作，也不隶属于 OpenCode 官方。

让 OpenCode 中的文本模型获得图片理解能力。

配置完成后，正常使用 OpenCode 即可。当模型需要识别图片时，会使用 `analyze_image`，并将结果返回到当前对话。

## 使用

在插件源码目录执行：

```bash
cd /path/to/opencode-analyze-image
npm install
npm run install:local ~/.config/opencode
```

安装完成后，正常使用 OpenCode 即可。当模型需要识别图片时，会使用 `analyze_image`，并将结果返回到当前对话。

不传路径时，插件默认安装到 `~/.config/opencode`。需要指定其他 OpenCode 根目录时，直接把路径作为 `npm run install:local` 的参数传入。

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
