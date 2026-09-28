import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai/registry";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-tui/overlays/oauth-selector";

export const providerAuthUi = {
	PASTE_CODE_LOGIN_PROVIDERS,
	getOAuthProviders,
	LoginDialogComponent,
	LogoutAccountSelectorComponent,
	OAuthSelectorComponent,
} as const;

export type ProviderAuthUiModules = typeof providerAuthUi;
