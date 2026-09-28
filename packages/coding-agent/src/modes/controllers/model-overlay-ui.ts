import { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { ModelPickerComponent } from "@oh-my-pi/pi-tui/overlays/model-picker";

export const modelOverlayUi = {
	ModelHubComponent,
	ModelPickerComponent,
} as const;

export type ModelOverlayModules = typeof modelOverlayUi;
