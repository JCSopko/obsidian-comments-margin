import { DateTime } from "luxon";
import CommentsPlusPlus from "main";
import { Editor, TFile } from "obsidian";
import { promptForCommentContent, promptForCommentName } from "ui/textModals";
import { METADATA_SEPARATOR } from "utils/constants";
import { generateCommentId } from "utils/helpers";

/**
 * Ctrl+Shift+M — Comment on the current text selection.
 * Wraps selected text in ==highlights==, inserts a COMMENT++ callout
 * on the line below with author + timestamp + generated ID.
 */
export async function commentOnSelectionCommand(
	plugin: CommentsPlusPlus,
	file: TFile | null,
	editor: Editor,
) {
	if (!file) return;

	let name = plugin.getName();
	if (!name) {
		const result = await promptForCommentName(plugin.app, plugin.settings.defaultName);
		if (!result) return;
		name = result.text;
	}

	const content = await promptForCommentContent(plugin.app, plugin.mentionRegistry);
	if (!content) return;

	const timestamp = DateTime.now();
	const id = await generateCommentId(name, timestamp, content.text.trim());

	const selection = editor.getSelection();
	const fromPos = editor.getCursor("from");
	const toPos = editor.getCursor("to");

	// Build the callout block
	const formattedContent = content.text
		.trim()
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	const calloutBlock = `> [!COMMENT++] ${name} ${METADATA_SEPARATOR} ${timestamp.toISO()} ${METADATA_SEPARATOR} ${id}\n${formattedContent}\n`;

	if (selection) {
		// Wrap selected text in ==highlights== and insert callout below
		const highlighted = `==${selection}==`;

		// Find the end-of-line position for the line containing the selection end
		const endLine = toPos.line;
		const endLineText = editor.getLine(endLine);
		const eolPos = { line: endLine, ch: endLineText.length };

		// Replace selection with highlighted version
		editor.replaceRange(highlighted, fromPos, toPos);

		// Insert callout on a new line after the selection's line.
		// After replacing, the end-of-line shifted by the added == markers.
		const shiftedEolCh = endLineText.length + (highlighted.length - selection.length);
		editor.replaceRange(
			"\n" + calloutBlock,
			{ line: endLine, ch: shiftedEolCh },
		);
	} else {
		// No selection — insert block-level comment on the current line
		const cursorLine = fromPos.line;
		const lineText = editor.getLine(cursorLine);
		editor.replaceRange(
			"\n" + calloutBlock,
			{ line: cursorLine, ch: lineText.length },
		);
	}
}
