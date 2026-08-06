# opencode-analyze-image

让 OpenCode 中的文本模型获得图片理解能力。

配置完成后，正常使用 OpenCode 即可。当模型需要识别图片时，会使用 `analyze_image`，并将结果返回到当前对话。

## 安装

### 未发布版本

在插件源码目录执行：

```bash
npm install
npm run install:local
```

该命令会将本地插件入口安装到当前目录的 `.opencode/plugins/` 中。

### 已发布版本

将插件包加入现有 OpenCode 配置的 `plugin` 列表：

```json
{
  "plugin": [
    "opencode-analyze-image"
  ]
}
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
| `api_key` | 视觉模型 API Key。 |

`trigger_models` 使用精确匹配。模型 ID 自身包含斜杠时，保留完整名称即可。

### 可选字段

| 字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `timeout_seconds` | `120` | 请求超时时间。 |
| `max_retries` | `2` | 请求重试次数。 |
| `max_output_tokens` | `4096` | 最大输出长度。 |

图片相关限制配置可以直接沿用 `config.example.json` 中的默认值，只有需要调整时再修改 `image` 节点。

## 完整配置

完整字段清单见 [config.example.json](./config.example.json)。

## 许可证

MIT
