import { debounce, EditorPosition, MarkdownView, MarkdownPostProcessorContext, Plugin, TAbstractFile, TFile, WorkspaceLeaf, Menu } from "obsidian";
import { DEFAULT_SETTINGS, CommentsPPSettings, CommentsPPSettingTab } from "./settings";
import { promptForCommentContent, promptForCommentName, promptForDefaultName } from "ui/textModals";
import { METADATA_SEPARATOR, ICON_NAME, PLUGIN_NAME, PLUGIN_PREFIX, VIEW_TYPE_COMMENT } from "utils/constants";
import { MouseButton, CommentPP } from "types";
import { CommentsPPView } from "ui/view";
import { DateTime } from "luxon";
import { CommentsNotice, generateCommentId, hideChildren, toggleChildren } from "utils/helpers";
import { addCommentCommand } from "commands/addCommand";
import { getRelayUsername, isRelayInstalled } from "integrations/relay";
import { createMarginCommentExtension } from "editor/marginPlugin";

export default class CommentsPlusPlus extends Plugin {
        settings: CommentsPPSettings;

        mdView: MarkdownView | null = null;
        statusBarItemEl: HTMLElement;

        debounceUpdate = debounce((file: TAbstractFile) => this.updateComments(file), 500, true);

        async onload() {
                await this.loadSettings();

                this.registerEditorExtension(createMarginCommentExtension(this));
                this.registerMarkdownPostProcessor(this.postProcessor.bind(this));

                this.addRibbonIcon(ICON_NAME, PLUGIN_NAME, () => this.activateView());
                this.registerView(VIEW_TYPE_COMMENT, (leaf) => new CommentsPPView(leaf, this));

                this.registerEvent(this.app.vault.on("modify", (file) => this.debounceUpdate(file)));
                this.registerEvent(
                        this.app.workspace.on("file-open", async (file) => {
                                if (file) await this.updateComments(file);
                        })
                );
                this.registerEvent(
                        this.app.workspace.on("editor-menu", (menu, editor, info) => {
                                menu.addItem(async (item) => {
                                        if (!info.file) return;

                                        const cursorPos = editor.getCursor("to");
                                        const parentComment = (await this.getComments(info.file)).find(
                                                (c) => c.startPos.line - 1 <= cursorPos.line && cursorPos.line <= c.endPos.line - 1
                                        );
                                        item.setTitle(!parentComment ? "Add comment" : "Add sub-comment")
                                                .setIcon(ICON_NAME)
                                                .onClick(async () => await addCommentCommand(this, info.file, editor, parentComment));
                                });
                        })
                );

                this.statusBarItemEl = this.addStatusBarItem();
                this.statusBarItemEl.setText("0 comments");
                this.statusBarItemEl.addClass("mod-clickable");
                this.statusBarItemEl.onClickEvent(async () => await this.activateView());

                this.addCommand({
                        id: "add-comment",
                        name: "Add comment at the current cursor position",
                        editorCallback: async (editor, ctx) => await addCommentCommand(this, ctx.file, editor),
                });

                this.addSettingTab(new CommentsPPSettingTab(this.app, this));

                this.app.workspace.onLayoutReady(() => {
                        if (!this.settings.defaultName && !isRelayInstalled(this.app)) {
                                promptForDefaultName(this.app).then(async (name) => {
                                        if (!name || !name.text) return;
                                        this.settings.defaultName = name.text;
                                        await this.saveSettings();
                                });
                        }
                });
        }

        getName(): string {
                if (!this.settings.useRelayFeatures) return this.settings.defaultName;

                if (!isRelayInstalled(this.app)) {
                        new CommentsNotice("Relay Plugin is not active", 30);
                        return "";
                }

                const relayName = getRelayUsername(this.app);
                if (!relayName) new CommentsNotice("Unable to retrieve Relay login name", 30);
                return relayName ?? "";
        }

        onunload() {}

        async loadSettings() {
                this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<CommentsPPSettings>);
        }

        async saveSettings() {
                await this.saveData(this.settings);
        }

        async updateComments(file: TAbstractFile) {
                if (!(file instanceof TFile)) return;

                const comments = await this.getComments(file);
                // console.debug(comments);
                // this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENT).forEach((leaf) => {
                //         if (leaf.view instanceof CommentsPPView) leaf.view.setComments(comments, file.name);
                // });
                for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENT)) {
                        if (leaf.view instanceof CommentsPPView) leaf.view.setComments(comments, file.name);
                }
                this.statusBarItemEl.setText(`${comments.length} comments`);
        }

        async getComments(file: TFile): Promise<CommentPP[]> {
                const content = await file.vault.cachedRead(file);
                return this.findComments(file, content, {
                        line: 0,
                        ch: 0,
                });
        }

        async findComments(file: TFile, fileContent: string, posOffset: EditorPosition, parentContentPos?: EditorPosition): Promise<CommentPP[]> {
                const comments: CommentPP[] = [];
                const regex = /> \[!COMMENT\+\+\] (.+?)\n((?:> *.*\n?)+)/gi;
                const matches = fileContent.matchAll(regex);

                for (const match of matches) {
                        if (match.length < 3) continue;

                        let name = match[1]!.trim();
                        let timestamp: DateTime | undefined;
                        let id: string | undefined;
                        let contentPos: EditorPosition;

                        if (typeof match.index !== "number" || match.index < 0) continue;

                        const separatorIndex = name.indexOf(METADATA_SEPARATOR);
                        if (separatorIndex >= 0) {
                                let date = name.slice(separatorIndex + METADATA_SEPARATOR.length).trim();
                                const idIndex = date.indexOf(METADATA_SEPARATOR);
                                if (idIndex >= 0) {
                                        id = date.slice(idIndex + METADATA_SEPARATOR.length).trim();
                                        date = date.slice(0, idIndex).trim();
                                }
                                timestamp = DateTime.fromISO(date);
                                name = name.slice(0, separatorIndex).trim();
                        }

                        let content = match[2]!
                                .split("\n")
                                .map((line) => line.replace(/^>/, "").trim())
                                .join("\n");

                        const startLine = (fileContent.slice(0, match.index).match(/\n/g)?.length || 0) + 1;
                        const endLine = (fileContent.slice(0, match.index + match[0].length).match(/\n/g)?.length || 0) + 1;
                        const startPos: EditorPosition = {
                                line: startLine + posOffset.line,
                                ch: 2 + posOffset.ch,
                        };
                        const endPos: EditorPosition = {
                                line: endLine + posOffset.line,
                                ch: 0,
                        };

                        contentPos = parentContentPos ?? {
                                line: startPos.line,
                                ch: startPos.ch,
                        };

                        const children = await this.findComments(file, content, { line: startPos.line, ch: startPos.ch }, contentPos);

                        const subCommentIndex = content.indexOf(">");
                        if (subCommentIndex >= 0) content = content.slice(0, subCommentIndex);

                        let comment: CommentPP = {
                                id,
                                name,
                                content,
                                startPos,
                                endPos,
                                children,
                                contentPos,
                                file,
                                timestamp,
                                childrenHiddenView: !this.settings.expandSubCommentsInView,
                                childrenHiddenEditor: !this.settings.expandCommentsInEditor,
                        };
                        if (!comment.id) {
                                comment.id = await this.regenerateCommentId(comment);
                        }
                        for (const c of children) {
                                c.parent = comment;
                        }
                        comments.push(comment);
                }

                return comments;
        }

        async regenerateCommentId(comment: CommentPP) {
                const id = await generateCommentId(comment.name, comment.timestamp, comment.content);
                await this.app.vault.process(comment.file, (fileContent) => {
                        const lines = fileContent.split("\n");
                        const oldMetadata = lines[comment.startPos.line - 1];
                        const regex = /^>+ \[!COMMENT\+\+\]/gi;
                        const match = oldMetadata?.match(regex);
                        if (!match) {
                                new CommentsNotice(`Metadata not found in ${oldMetadata}`, 30);
                                console.error(`Metadata not found in ${oldMetadata}`);
                                return fileContent;
                        }

                        lines.splice(
                                comment.startPos.line - 1,
                                1,
                                `${match[0]} ${comment.name} ${METADATA_SEPARATOR} ${comment.timestamp?.toISO()} ${METADATA_SEPARATOR} ${id}`
                        );
                        fileContent = lines.join("\n");
                        return fileContent;
                });
                return id;
        }

        async getCommentById(id: string, file: TFile) {
                const comments = await this.getComments(file);
                return comments.find((c) => c.id === id);
        }

        postProcessor(el: HTMLElement, _ctx: MarkdownPostProcessorContext) {
                if (!this.mdView) {
                        const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
                        if (!markdownView) {
                                console.error(`${PLUGIN_PREFIX} Could not get active markdown view`);
                                return;
                        }

                        this.mdView = markdownView;
                }
                const callouts = el.findAll(".callout").filter((c) => c.getAttribute("data-callout")?.toLowerCase() === "comment++");
                if (this.mdView.getMode() === "preview") {
                        callouts.forEach((c) => c.hide());
                        return;
                }

                callouts.forEach((calloutEl) => {
                        const codeblockEl = calloutEl.parentElement?.parentElement;

                        const contentEl = calloutEl.find(".callout-content") as HTMLDivElement;
                        const titleEl = calloutEl.find(".callout-title");
                        const titleInnerEl = calloutEl.find(".callout-title-inner");
                        let title = titleInnerEl.innerText;
                        const separatorIndex = title.indexOf(METADATA_SEPARATOR);
                        if (separatorIndex < 0) return;

                        let date = title.slice(separatorIndex + METADATA_SEPARATOR.length).trim();
                        const idIndex = date.indexOf(METADATA_SEPARATOR);
                        let id: string | undefined;
                        if (idIndex > 0) {
                                id = date.slice(idIndex + METADATA_SEPARATOR.length).trim();
                                date = date.slice(0, idIndex).trim();
                        }
                        const timestamp = DateTime.fromISO(date).toLocaleString(DateTime.DATETIME_MED);
                        title = title.slice(0, separatorIndex).trim();
                        titleInnerEl.setText(title);
                        titleInnerEl.createEl("br");
                        titleInnerEl.createSpan({ text: timestamp });

                        if (!codeblockEl || !codeblockEl.classList.contains("cm-callout")) return;

                        codeblockEl.addClass("comment-block", this.settings.alignmentInEditor);

                        if (!id) return;

                        const file = this.mdView?.file;
                        if (!file) {
                                new CommentsNotice("Unable to retrieve the actual file", 30);
                                return;
                        }

                        let tries = 20;
                        const eventsRegister = async () => {
                                if (tries < 1) {
                                        new CommentsNotice(`Unable to retrieve the comment with that ID ${id}`);
                                        return;
                                }

                                const comment = await this.getCommentById(id, file);
                                if (!comment) {
                                        tries -= 1;
                                        setTimeout(() => {
                                                const handler = async () => await eventsRegister();
                                                handler().catch((e) => new CommentsNotice(`${e}`, 0));
                                        }, 250);
                                        return;
                                }

                                calloutEl.onClickEvent((ev) => {
                                        if (ev.button !== MouseButton.RIGHT.valueOf()) return;

                                        this.patchCalloutContextMenu(ev, id);
                                });

                                if (comment.childrenHiddenEditor) hideChildren(contentEl);
                                titleEl.onClickEvent((ev) => {
                                        if (ev.button !== MouseButton.LEFT.valueOf()) return;

                                        ev.preventDefault();
                                        comment.childrenHiddenEditor = !comment.childrenHiddenEditor;
                                        toggleChildren(contentEl);
                                });
                        };
                        setTimeout(() => {
                                const handler = async () => await eventsRegister();
                                handler().catch((e) => new CommentsNotice(`${e}`, 0));
                        });
                });
        }

        async activateView() {
                const { workspace } = this.app;
                let leaf: WorkspaceLeaf | null = null;
                const leaves = workspace.getLeavesOfType(VIEW_TYPE_COMMENT);

                if (leaves.length > 0) {
                        leaf = leaves[0]!;
                } else {
                        leaf = workspace.getRightLeaf(false);
                        if (!leaf) return;

                        await leaf.setViewState({ type: VIEW_TYPE_COMMENT, active: true });
                }

                await workspace.revealLeaf(leaf);
        }

        private patchCalloutContextMenu(ev: MouseEvent, commentID: string) {
                const menu = document.querySelector(".menu.mod-no-icon");
                if (!menu) {
                        setTimeout(() => this.patchCalloutContextMenu(ev, commentID));
                        return;
                }

                menu.addClass("comment-hidden");
                this.showCalloutContextMenu(ev, commentID);
        }

        private showCalloutContextMenu(ev: MouseEvent, commentID: string) {
                const commonLogic = async () => {
                        const file = this.mdView?.file;
                        if (!file) {
                                new CommentsNotice("Unable to retrieve active file", 30);
                                return;
                        }

                        const comment = await this.getCommentById(commentID, file);
                        if (!comment) {
                                new CommentsNotice(`Unable to retrieve the comment with that ID ${commentID}`);
                                return;
                        }

                        return comment;
                }

                const menu = new Menu();

                menu.addItem((item) =>
                        item
                                .setTitle("Add sub-comment")
                                .setIcon("plus")
                                .onClick(async () => {
                                        const comment = await commonLogic();
                                        if (!comment) return;

                                        await this.addReply(comment)
                                })
                );

                menu.addItem((item) =>
                        item
                                .setTitle("Remove entire thread")
                                .setIcon("trash")
                                .onClick(async () => {
                                        const comment = await commonLogic();
                                        if (!comment) return;

                                        await this.removeComment(comment.parent ?? comment)
                                })
                );

                menu.showAtMouseEvent(ev);
        }

        async addReply(commentToReply: CommentPP) {
                let name: string = this.getName();
                if (!name) {
                        const result = await promptForCommentName(this.app, this.settings.defaultName);
                        if (!result) return;

                        name = result.text;
                }
                const content = await promptForCommentContent(this.app);
                if (!content) return;

                const formattedContent = content.text
                        .trim()
                        .split("\n")
                        .map((l) => `>> ${l.trim()}`);
                // console.debug("Answering to:", comment);
                // if (!commentToReply.parent) {
                //         formattedContent.push("");
                // }
                const timestamp = DateTime.now();
                const id = await generateCommentId(name, timestamp, content.text.trim());

                await this.app.vault.process(commentToReply.file, (fileContent) => {
                        const lines = fileContent.split("\n");
                        lines.splice(
                                (commentToReply.parent?.endPos.line ?? commentToReply.endPos.line) - 1,
                                0,
                                "> ",
                                `>> [!COMMENT++] ${name} ${METADATA_SEPARATOR} ${timestamp.toISO()} ${METADATA_SEPARATOR} ${id}`,
                                ...formattedContent
                        );
                        fileContent = lines.join("\n");
                        return fileContent;
                });
        }

        async removeComment(comment: CommentPP) {
                await this.app.vault.process(comment.file, (content) => {
                        const lines = content.split("\n");
                        lines.splice(comment.startPos.line - 1, comment.endPos.line - comment.startPos.line + (comment.parent ? 0 : 1));
                        content = lines.join("\n");
                        return content;
                });
        }
}
