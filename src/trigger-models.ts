export function triggerModelDescription(triggerModels: readonly string[]): string {
  const policy =
    "Only call this tool when the active OpenCode model is listed in the configured trigger_models below. If the active model is not listed, do not call this tool. Use the active model's native image capability instead. Calling this tool with an unlisted model will return an error."

  if (!triggerModels.length) {
    return `${policy}\n\nNo trigger_models are configured. Do not call this tool.`
  }

  return `${policy}\n\nConfigured trigger_models:\n${triggerModels.map((model) => `- ${model}`).join("\n")}`
}

export function unlistedTriggerModelMessage(model: string): string {
  return `The active OpenCode model "${model}" is not included in trigger_models. Use the active model's native image capability instead of this tool.`
}
