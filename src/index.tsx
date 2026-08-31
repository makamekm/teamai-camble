import { createRoot, type Root } from "react-dom/client";

import { CambleReleaseConsole } from "./camble-release-console";
import "./camble-release-console.css";
import type { PluginFrontendContext, PluginFrontendInstance } from "./types";

const PLUGIN_ID = "camble-release";

function render(root: Root, context: PluginFrontendContext) {
  root.render(
    <CambleReleaseConsole
      detail={context.detail}
      agents={context.agents}
      agentIds={context.agentIds}
      runningAction={context.runningAction}
      hasRunningOperation={context.hasRunningOperation}
      canRun={context.canRun}
      supportsAction={context.supportsAction}
      onAgent={context.setAgent}
      onRun={context.runAction}
    />,
  );
}

if (!window.TeamAIPluginHost) throw new Error("TeamAI plugin frontend host is unavailable");
window.TeamAIPluginHost.register(PLUGIN_ID, {
  apiVersion: 1,
  mount(container: HTMLElement, context: PluginFrontendContext): PluginFrontendInstance {
    const root = createRoot(container);
    render(root, context);
    return {
      update(nextContext) {
        render(root, nextContext);
      },
      unmount() {
        root.unmount();
      },
    };
  },
});
