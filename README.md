# opencode-analyze-image

让 OpenCode 中的文本模型获得图片理解能力。

配置完成后，正常使用 OpenCode 即可。当模型需要识别图片时，会使用 `analyze_image`，并将结果返回到当前对话。

## 安装

将插件包加入现有 OpenCode 配置的 `plugin` 列表：

```json
{
  "plugin": [
    "opencode-analyze-image"
  ]
}
```

安装 Python 依赖：

```bash
python3 -m venv ~/.config/opencode/analyze_image/venv
~/.config/opencode/analyze_image/venv/bin/python -m pip install \
  "openai>=2.53.0,<3" \
  "anthropic>=0.120.2,<1" \
  "Pillow>=12.3.0,<13"
```

## 配置

项目配置文件：

```text
.opencode/analyze_image/config.json
```

也可以使用全局配置：

```text
~/.config/opencode/analyze_image/config.json
```

最小配置示例：

```json
{
  "version": 1,
  "trigger_models": [
    "deepseek/deepseek-v4-flash"
  ],
  "api_format": "openai_chat",
  "base_url": "https://api.openai.com/v1",
  "model": "your-vision-model",
  "api_key_env": "ANALYZE_IMAGE_API_KEY",
  "runtime": {
    "python_command": "~/.config/opencode/analyze_image/venv/bin/python"
  }
}
```

### 必填字段

| 字段 | 说明 |
| --- | --- |
| `trigger_models` | 允许使用插件的主模型列表，填写完整的 `provider/model`。 |
| `api_format` | 接口格式，可选 `openai_chat`、`openai_responses`、`anthropic_messages`。 |
| `base_url` | 视觉模型接口地址。 |
| `model` | 视觉模型 ID。 |
| `api_key_env` | API Key 对应的环境变量名。 |

`trigger_models` 使用精确匹配。模型 ID 自身包含斜杠时，保留完整名称即可。

设置 API Key：

```bash
export ANALYZE_IMAGE_API_KEY="your-api-key"
```

### 可选字段

| 字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `timeout_seconds` | `120` | 请求超时时间。 |
| `max_retries` | `2` | 请求重试次数。 |
| `max_output_tokens` | `4096` | 最大输出长度。 |
| `temperature` | `null` | 模型温度。 |
| `headers` | `{}` | 自定义请求头。 |
| `prompt.template` | 内置提示词 | 图片分析提示词。 |
| `openai_chat.max_tokens_parameter` | `max_tokens` | 可改为 `max_completion_tokens`。 |
| `runtime.python_command` | `python3` 或 `python` | Python 命令或路径。 |
| `runtime.python_args` | `[]` | Python 额外参数。 |
| `runtime.cache_directory` | 系统缓存目录 | 缓存目录。 |
| `runtime.cache_ttl_minutes` | `1440` | 缓存保留时间。 |
| `runtime.worker_timeout_seconds` | `150` | 单次任务最长运行时间。 |

图片相关限制配置可以直接沿用 `config.example.json` 中的默认值，只有需要调整时再修改 `image` 节点。

## 完整配置

完整字段清单见 [config.example.json](./config.example.json)。

## 许可证

MIT
