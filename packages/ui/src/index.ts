import { PdeDeviceChip, PdePrivacyLabel } from "./privacy.ts";

if (!customElements.get("pde-privacy-label")) customElements.define("pde-privacy-label", PdePrivacyLabel);
if (!customElements.get("pde-device-chip")) customElements.define("pde-device-chip", PdeDeviceChip);

export { PdePrivacyLabel, PdeDeviceChip };
export { PdeCapture } from "./capture.ts";
export { PdeCamera } from "./camera.ts";
export { PdeReview } from "./review.ts";
export { PdeSealConfirm } from "./seal.ts";
export { PdeNetworkPanel } from "./network-panel.ts";
export { PdeFlow, type Extractor, type FlowConfig } from "./flow.ts";
export { assistantPrompt, type AssistantPromptContext } from "./assistant-prompt.ts";
export { NetworkMonitor, type NetworkEntry, type NetworkMonitorOptions, type RequestKind } from "./network-monitor.ts";
export { DOC_LABELS, SOURCE_LABELS, checkLabel } from "./labels.ts";
