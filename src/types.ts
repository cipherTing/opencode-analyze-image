export type ApiFormat = "openai_chat" | "openai_responses" | "anthropic_messages"

export interface AnalyzeImageConfig {
  trigger_models: string[]
  api_format: ApiFormat
  base_url: string
  model: string
  api_key: string
  timeout_seconds: number
  max_retries: number
  max_output_tokens: number
  image: {
    allow_remote_url: boolean
    max_source_bytes: number
    max_total_source_bytes: number
    directory_max_images: number
  }
}

export interface TextMessagePart {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface FileMessagePart {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: {
    type?: string
    path?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type MessagePart = TextMessagePart | FileMessagePart | Record<string, unknown>

export interface AnalyzeImageRequest {
  image_urls: string[]
  instruction?: string
  cwd: string
  signal: AbortSignal
}
