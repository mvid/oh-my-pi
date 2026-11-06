import { Disclosure } from "../components/disclosure";
import { Text } from "../components/text";
import { expandKeyHint } from "../render/render-utils";
import { theme } from "../theme";
import type { Component } from "../tui";

/** Keep the earlier answer available without repeating it in the settled transcript. */
export function createSupersededAnswerDisclosure(body: () => Component): Disclosure {
	return new Disclosure({
		summary: () =>
			new Text(
				`Earlier answer superseded after advisor review ${theme.sep.dot.trim()} ${expandKeyHint()}`,
				1,
				0,
			).setStyleFn(text => theme.fg("dim", text)),
		body,
	});
}
