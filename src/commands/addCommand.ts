import { DateTime } from "luxon";
import CommentsPlusPlus from "main";
import { Editor, TFile } from "obsidian";
import { CommentPP } from "types";
import { promptForCommentContent, promptForCommentName } from "ui/textModals";
import { METADATA_SEPARATOR } from "utils/constants";
import { generateCommentId } from "utils/helpers";

export async function addCommentCommand(plugin: CommentsPlusPlus, file: TFile | null, editor: Editor, parentComment?: CommentPP) {
        if (!file) return;

        const cursorPos = editor.getCursor("to");
        const isInsideComment =
                parentComment ?? (await plugin.getComments(file)).find((c) => c.startPos.line - 1 <= cursorPos.line && cursorPos.line <= c.endPos.line - 1);
        let name = plugin.getName();
        if (!name) {
                const result = await promptForCommentName(plugin.app, plugin.settings.defaultName);
                if (!result) return;

                name = result.text;
        }

        const content = await promptForCommentContent(plugin.app, plugin.mentionRegistry);
        if (!content) return;

        const depth = isInsideComment ? ">>" : ">";
        const formattedContent = content.text
                .trim()
                .split("\n")
                .map((l) => `${depth} ${l}`)
                .join("\n");
        const timestamp = DateTime.now();
        const id = await generateCommentId(name, timestamp, content.text.trim());
        let text = `${depth} [!COMMENT++] ${name} ${METADATA_SEPARATOR} ${timestamp.toISO()} ${METADATA_SEPARATOR} ${id}\n${formattedContent}\n`;
        let line = cursorPos.line;
        if (isInsideComment) {
                line = isInsideComment.endPos.line - 1;
                text = "> \n" + text;
        } else {
                if (cursorPos.ch > 0) {
                        line += 1;
                }
                text += "\n";
        }
        editor.replaceRange(text, {
                line,
                ch: 0,
        });
        if (isInsideComment) {
                line += 1;
        }
        editor.setCursor({
                line: line + (text.match(/\n/g)?.length || 0),
                ch: 0,
        });
}

// TODO: add @person feature and command
