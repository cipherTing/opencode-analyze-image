export type ApiFormat = "openai_chat" | "openai_responses" | "anthropic_messages"

export type OpenAIChatMaxTokensParameter = "max_tokens" | "max_completion_tokens"

export interface AnalyzeImageConfig {
  version: number
  trigger_models: string[]
  api_format: ApiFormat
  base_url: string
  model: string
  api_key_env: string
  timeout_seconds: number
  max_retries: number
  max_output_tokens: number
  temperature: number | null
  headers: Record<string, string>
  openai_chat: {
    max_tokens_parameter: OpenAIChatMaxTokensParameter
  }
  prompt: {
    template: string
  }
  image: {
    allow_remote_url: boolean
    allow_private_network: boolean
    max_source_bytes: number
    max_total_source_bytes: number
    max_image_bytes: number
    max_total_image_bytes: number
    max_total_pixels: number
    max_dimension: number
    resize_target: number
    directory_max_images: number
    directory_recursive: boolean
    detail: "auto" | "low" | "high"
  }
  runtime: {
    python_command: string
    python_args: string[]
    cache_directory?: string
    cache_ttl_minutes: number
    worker_timeout_seconds: number
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

export interface WorkerRequest {
  image_urls: string[]
  instruction?: string
  cwd: string
}

export interface WorkerSuccess {
  success: true
  analysis: string
}

export interface WorkerFailure {
  success: false
  error: {
    code: string
    message: string
  }
}

export type WorkerResult = WorkerSuccess | WorkerFailure
