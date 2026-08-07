/** @jsxImportSource @opentui/solid */

import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiPromptRef,
} from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"

type PromptRef = (ref: TuiPromptRef | undefined) => void

interface SessionPromptProps {
  session_id: string
  visible?: boolean
  disabled?: boolean
  on_submit?: () => void
  ref?: PromptRef
}

function VisionStatus(props: { api: TuiPluginApi }): JSX.Element {
  return (
    <box flexDirection="row" justifyContent="flex-end">
      <text fg={props.api.theme.current.success} wrapMode="none">
        · Vision ON
      </text>
    </box>
  )
}

function SessionPromptWithVisionStatus(
  props: SessionPromptProps & { api: TuiPluginApi },
): JSX.Element {
  return (
    <box gap={0}>
      <props.api.ui.Prompt
        sessionID={props.session_id}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={props.on_submit}
        ref={props.ref}
      />
      <VisionStatus api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 90,
    slots: {
      session_prompt(_context, props: SessionPromptProps) {
        return <SessionPromptWithVisionStatus api={api} {...props} />
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: "analyze_image_tui",
  tui,
}

export default plugin
