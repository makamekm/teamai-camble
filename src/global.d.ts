import type { PluginFrontendContext, PluginFrontendInstance } from "./types";

declare global {
  interface Window {
    TeamAIPluginHost?: {
      register(
        pluginId: string,
        definition: {
          apiVersion: 1;
          mount(container: HTMLElement, context: PluginFrontendContext): PluginFrontendInstance;
        },
      ): void;
    };
  }
}

export {};
