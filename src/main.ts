import { debounce, EditorPosition, MarkdownView, MarkdownPostProcessorContext, Plugin, TAbstractFile, TFile, WorkspaceLeaf, Menu } from "obsidian";
import { DEFAULT_SETTINGS, CommentsPPSettings, CommentsPPSettingTab } from "./settings";
import { promptForCommentContent, promptForCommentName, promptForDefaultName, promptForEditComment } from "ui/textModals";
import { METADATA_SEPARATOR, ICON_NAME, PLUGIN_NAME, PLUGIN_PREFIX, VIEW_TYPE_COMMENT } from "utils/constants";
import { MouseButton, CommentPP, MentionEntry, MentionItem, InlineMention, isInlineMention, ActiveMarginPlugin } from "types";
import { CommentsPPView } from "ui/view";
import { DateTime } from "luxon";
import { CommentsNotice, generateCommentId, hideChildren, toggleChildren } from "utils/helpers";
import { addCommentCommand } from "commands/addCommand";
import { commentOnSelectionCommand } from "commands/commentOnSelection";
import { getRelayUsername, isRelayInstalled } from "integrations/relay";
import { createMarginCommentExtension } from "editor/marginPlugin";

export default class CommentsPlusPlus extends Plugin {
        static readonly REGISTRY_PATH = "6-reference/infrastructure/agents/mention-registry.md";

        settings: CommentsPPSettings;

        mdView: MarkdownView | null = null;
        statusBarItemEl: HTMLElement;

        mentionRegistry: MentionEntry[] = [];
        inlineScanFolders: string[] = [];
        mentionComments: Map<string, MentionItem[]> = new Map();
        activeMarginPlugin: ActiveMarginPlugin | null = null;

        debounceUpdate = debounce((file: TAbstractFile) => this.updateComments(file), 500, true);
        debounceMentionScan = debounce((file: TAbstractFile) => this.scanFileForMentions(file), 1000, true);

        async onload() {
                await this.loadSettings();
                this.loadMentionRegistry();

                this.registerEditorExtension(createMarginCommentExtension(this));
                this.registerMarkdownPostProcessor(this.postProcessor.bind(this));

                this.addRibbonIcon(ICON_NAME, PLUGIN_NAME, () => this.activateView());
                this.registerView(VIEW_TYPE_COMMENT, (leaf) => new CommentsPPView(leaf, this));

                this.registerEvent(
                        this.app.vault.on("modify", (file) => {
                                this.debounceUpdate(file);
                                this.debounceMentionScan(file);
                        })
                );

                // Keep mention bookkeeping consistent across renames.
                this.registerEvent(
                        this.app.vault.on("rename", (file, oldPath) => {
                                if (!(file instanceof TFile) || file.extension !== "md") return;

                                const items = this.mentionComments.get(oldPath);
                                if (items) {
                                        this.mentionComments.delete(oldPath);
                                        for (const item of items) {
                                                if (isInlineMention(item)) {
                                                        item.file = file;
                                                } else {
                                                        item.file = file;
                                                        for (const child of item.children) child.file = file;
                                                }
                                        }
                                        this.mentionComments.set(file.path, items);
                                        this.updateMentionCount();
                                        this.updateMentionViews();
                                }
                                this.debounceMentionScan(file);
                        })
                );

                this.registerEvent(
                        this.app.vault.on("delete", (file) => {
                                if (file instanceof TFile && this.mentionComments.has(file.path)) {
                                        this.mentionComments.delete(file.path);
                                        this.updateMentionCount();
                                        this.updateMentionViews();
                                }
                        })
                );

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
                                        item.setSection("action")
                                                .setTitle(parentComment ? "Add sub-comment" : "Add comment")
                                                .setIcon(ICON_NAME)
                                                .onClick(async () => await addCommentCommand(this, info.file, editor, parentComment));
                                });
                        })
                );

                this.statusBarItemEl = this.addStatusBarItem();
                this.statusBarItemEl.setText("0 comments");
                this.statusBarItemEl.addClass("mod-clickable");
                this.statusBarItemEl.onClickEvent(async () => {
                        const name = this.settings.defaultName.toLowerCase();
                        if (name) {
                                const result = this.activeMarginPlugin?.focusNextMention(name);
                                if (result) {
                                        this.statusBarItemEl.setText(`@${this.settings.defaultName} (${result.current} of ${result.total})`);
                                        return;
                                }
                        }
                        await this.activateView();
                });

                this.addCommand({
                        id: "add-comment",
                        name: "Add comment at the current cursor position",
                        editorCallback: async (editor, ctx) => await addCommentCommand(this, ctx.file, editor),
                });

                this.addCommand({
                        id: "comment-on-selection",
                        name: "Comment on selected text",
                        hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "m" }],
                        editorCallback: async (editor, ctx) => await commentOnSelectionCommand(this, ctx.file, editor),
                });

                this.addCommand({
                        id: "open-panel",
                        name: "Open comments panel",
                        callback: () => this.activateView(),
                });

                this.addCommand({
                        id: "next-comment",
                        name: "Go to next comment",
                        hotkeys: [{ modifiers: ["Alt"], key: "j" }],
                        callback: () => this.activeMarginPlugin?.focusNext(),
                });

                this.addCommand({
                        id: "prev-comment",
                        name: "Go to previous comment",
                        hotkeys: [{ modifiers: ["Alt"], key: "k" }],
                        callback: () => this.activeMarginPlugin?.focusPrev(),
                });

                this.addCommand({
                        id: "resolve-focused-comment",
                        name: "Resolve focused comment",
                        hotkeys: [{ modifiers: ["Alt"], key: "e" }],
                        callback: () => this.activeMarginPlugin?.resolveFromKeyboard(),
                });

                this.addCommand({
                        id: "toggle-minimal-mode",
                        name: "Toggle minimal mode",
                        callback: async () => {
                                this.settings.minimalMode = !this.settings.minimalMode;
                                await this.saveSettings();
                                this.activeMarginPlugin?.setMinimalMode(this.settings.minimalMode);
                        },
                });

                this.addSettingTab(new CommentsPPSettingTab(this.app, this));

                this.registerEvent(
                        this.app.metadataCache.on("changed", (file) => {
                                if (file.path === CommentsPlusPlus.REGISTRY_PATH) this.loadMentionRegistry();
                        })
                );

                this.app.workspace.onLayoutReady(async () => {
                        this.loadMentionRegistry();
                        await this.scanAllFilesForMentions();
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

        // ---------- Mention registry & scanning ----------

        loadMentionRegistry() {
                const file = this.app.vault.getAbstractFileByPath(CommentsPlusPlus.REGISTRY_PATH);
                if (!(file instanceof TFile)) return;

                const cache = this.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;
                const mentions = fm?.mentions;
                if (Array.isArray(mentions)) {
                        this.mentionRegistry = mentions.filter(
                                (m: unknown): m is MentionEntry =>
                                        typeof m === "object" && m !== null && "handle" in m && typeof (m as MentionEntry).handle === "string"
                        );
                }

                const folders = fm?.inlineScanFolders;
                this.inlineScanFolders = Array.isArray(folders)
                        ? folders.filter((f: unknown): f is string => typeof f === "string").map((f) => (f.endsWith("/") ? f : f + "/"))
                        : [];
        }

        async scanFileForMentions(file: TAbstractFile) {
                if (!(file instanceof TFile) || file.extension !== "md") return;

                const name = this.settings.defaultName.toLowerCase();
                if (!name) return;

                const content = await file.vault.cachedRead(file);
                const comments = await this.findComments(file, content, { line: 0, ch: 0 });
                const mentioning = this.filterMentioningComments(comments, name);
                const inline = this.shouldInlineScan(file) ? this.findInlineMentions(file, content, name) : [];
                const all: MentionItem[] = [...mentioning, ...inline];

                if (all.length > 0) this.mentionComments.set(file.path, all);
                else this.mentionComments.delete(file.path);

                this.updateMentionCount();
                this.updateMentionViews();
        }

        async scanAllFilesForMentions() {
                const name = this.settings.defaultName.toLowerCase();
                if (!name) return;

                const files = this.app.vault.getMarkdownFiles();
                for (const file of files) {
                        const content = await file.vault.cachedRead(file);
                        const comments = await this.findComments(file, content, { line: 0, ch: 0 });
                        const mentioning = this.filterMentioningComments(comments, name);
                        const inline = this.shouldInlineScan(file) ? this.findInlineMentions(file, content, name) : [];
                        const all: MentionItem[] = [...mentioning, ...inline];
                        if (all.length > 0) this.mentionComments.set(file.path, all);
                }

                this.updateMentionCount();

                const total = Array.from(this.mentionComments.values()).reduce((sum, arr) => sum + arr.length, 0);
                if (total > 0) {
                        const notice = new CommentsNotice(
                                `You have ${total} unresolved @${name} mention${total === 1 ? "" : "s"} — tap to navigate`,
                                8
                        );
                        notice.noticeEl.style.cursor = "pointer";
                        notice.noticeEl.addEventListener("click", () => {
                                const result = this.activeMarginPlugin?.focusNextMention(name);
                                if (result) {
                                        notice.noticeEl.textContent = `@${name} mention ${result.current} of ${result.total} — tap for next`;
                                } else {
                                        this.activateView().catch(() => {});
                                }
                        });
                }
        }

        hasActiveMention(text: string, name: string): boolean {
                const mentionRe = new RegExp(`@${name}\\b`, "gi");
                const struckRe = new RegExp(`~~[^~]*@${name}\\b[^~]*~~`, "gi");
                const mentions = text.match(mentionRe) ?? [];
                const struck = text.match(struckRe) ?? [];
                return mentions.length > struck.length;
        }

        filterMentioningComments(comments: CommentPP[], name: string): CommentPP[] {
                return comments.filter((c) => {
                        if (c.resolved) return false;
                        if (this.hasActiveMention(c.content, name)) return true;
                        return c.children.some((child) => !child.resolved && this.hasActiveMention(child.content, name));
                });
        }

        shouldInlineScan(file: TFile): boolean {
                if (this.inlineScanFolders.length === 0) return false;
                return this.inlineScanFolders.some((f) => file.path.startsWith(f));
        }

        findInlineMentions(file: TFile, content: string, name: string): InlineMention[] {
                const out: InlineMention[] = [];
                const lines = content.split("\n");
                const codeBlocks = CommentsPlusPlus.findCodeBlockRanges(content);
                const mentionRe = new RegExp(`@${name}\\b`, "gi");

                // Skip frontmatter --- ... ---
                let frontmatterEnd = -1;
                if (lines[0]?.trimEnd() === "---") {
                        for (let i = 1; i < lines.length; i++) {
                                if (lines[i]?.trimEnd() === "---") {
                                        frontmatterEnd = i;
                                        break;
                                }
                        }
                }

                // Mark every line that's part of a COMMENT++ callout block as excluded
                const excluded = new Set<number>();
                const calloutHeader = /^>+ \[!COMMENT\+\+\]/i;
                for (let i = 0; i < lines.length; i++) {
                        if (calloutHeader.test(lines[i]!)) {
                                excluded.add(i);
                                for (let j = i + 1; j < lines.length && /^>/.test(lines[j]!); j++) {
                                        excluded.add(j);
                                }
                        }
                }

                let offset = 0;
                for (let i = 0; i < lines.length; i++) {
                        const line = lines[i]!;
                        if (i <= frontmatterEnd) {
                                offset += line.length + 1;
                                continue;
                        }
                        if (excluded.has(i)) {
                                offset += line.length + 1;
                                continue;
                        }
                        if (CommentsPlusPlus.isInsideCodeBlock(offset, codeBlocks)) {
                                offset += line.length + 1;
                                continue;
                        }
                        const trimmed = line.trim();
                        if (/^%%/.test(trimmed) || /%%\s*$/.test(trimmed)) {
                                offset += line.length + 1;
                                continue;
                        }

                        // Strip HTML comments and inline-code spans before testing
                        const stripped = line.replace(/<!--[\s\S]*?-->/g, "").replace(/`[^`]+`/g, "");
                        if (mentionRe.test(stripped)) {
                                mentionRe.lastIndex = 0;
                                if (this.hasActiveMention(stripped, name)) {
                                        const ctx = trimmed.length > 120 ? trimmed.slice(0, 120) + "..." : trimmed;
                                        out.push({ type: "inline", handle: name, file, line: i, contextText: ctx });
                                }
                        }
                        mentionRe.lastIndex = 0;
                        offset += line.length + 1;
                }

                return out;
        }

        updateMentionCount() {
                const total = Array.from(this.mentionComments.values()).reduce((sum, arr) => sum + arr.length, 0);
                const activeFile = this.app.workspace.getActiveFile();
                // The bundled JS reads this but only writes the same status text, leaving unused.
                // Preserved for future per-file badge.
                void activeFile;

                const existing = this.statusBarItemEl.getText().match(/^(\d+) comment/);
                const count = existing?.[1] ?? "0";
                if (total > 0) {
                        this.statusBarItemEl.setText(`${count} comments | ${total} @mentions`);
                } else {
                        this.statusBarItemEl.setText(`${count} comments`);
                }
        }

        updateMentionViews() {
                for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENT)) {
                        if (leaf.view instanceof CommentsPPView) leaf.view.setMentionComments(this.mentionComments);
                }
        }

        // ---------- Comment parsing ----------

        async updateComments(file: TAbstractFile) {
                if (!(file instanceof TFile)) return;

                const comments = await this.getComments(file);
                for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COMMENT)) {
                        if (leaf.view instanceof CommentsPPView) leaf.view.setComments(comments, file.name);
                }
                this.statusBarItemEl.setText(`${comments.length} comments`);
        }

        async getComments(file: TFile): Promise<CommentPP[]> {
                const content = await file.vault.cachedRead(file);
                return this.findComments(file, content, { line: 0, ch: 0 });
        }

        static findCodeBlockRanges(text: string): Array<[number, number]> {
                const ranges: Array<[number, number]> = [];
                const fenceRe = /^(`{3,}|~{3,})/gm;
                let openIndex: number | null = null;
                let openFence: string | null = null;
                let m: RegExpExecArray | null;
                while ((m = fenceRe.exec(text)) !== null) {
                        if (openIndex === null) {
                                openIndex = m.index;
                                openFence = m[1]![0]!.repeat(m[1]!.length);
                        } else if (m[1]!.startsWith(openFence![0]!) && m[1]!.length >= openFence!.length) {
                                ranges.push([openIndex, m.index + m[0].length]);
                                openIndex = null;
                                openFence = null;
                        }
                }
                if (openIndex !== null) ranges.push([openIndex, text.length]);
                return ranges;
        }

        static isInsideCodeBlock(pos: number, ranges: Array<[number, number]>): boolean {
                return ranges.some(([start, end]) => pos >= start && pos <= end);
        }

        async findComments(
                file: TFile,
                fileContent: string,
                posOffset: EditorPosition,
                parentContentPos?: EditorPosition
        ): Promise<CommentPP[]> {
                const comments: CommentPP[] = [];
                // Top-level invocation skips code-block content. Recursive calls don't (they're already inside an extracted comment body).
                const codeBlocks = parentContentPos ? [] : CommentsPlusPlus.findCodeBlockRanges(fileContent);
                const regex = /> \[!COMMENT\+\+\] (.+?)\n((?:> *.*\n?)+)/gi;
                const matches = fileContent.matchAll(regex);

                for (const match of matches) {
                        if (match.length < 3) continue;
                        if (typeof match.index !== "number" || match.index < 0) continue;
                        if (CommentsPlusPlus.isInsideCodeBlock(match.index, codeBlocks)) continue;

                        let name = match[1]!.trim();
                        let timestamp: DateTime | undefined;
                        let id: string | undefined;
                        let resolved = false;
                        let edited = false;

                        const separatorIndex = name.indexOf(METADATA_SEPARATOR);
                        if (separatorIndex >= 0) {
                                const fields = name
                                        .slice(separatorIndex + METADATA_SEPARATOR.length)
                                        .split(METADATA_SEPARATOR)
                                        .map((f) => f.trim());
                                name = name.slice(0, separatorIndex).trim();
                                if (fields.length >= 1 && fields[0]) timestamp = DateTime.fromISO(fields[0]);
                                if (fields.length >= 2 && fields[1]) id = fields[1];
                                for (let k = 2; k < fields.length; k++) {
                                        const flag = fields[k]!.toLowerCase();
                                        if (flag === "resolved") resolved = true;
                                        else if (flag === "edited") edited = true;
                                }
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

                        const contentPos: EditorPosition = parentContentPos ?? {
                                line: startPos.line,
                                ch: startPos.ch,
                        };

                        // Anchor line text — only meaningful at top level (the line above the callout).
                        let anchorLineText: string | undefined;
                        if (!parentContentPos) {
                                const allLines = fileContent.split("\n");
                                const anchorIdx = startLine - 2; // line just before the callout (0-based)
                                if (anchorIdx >= 0 && anchorIdx < allLines.length) {
                                        const trimmed = allLines[anchorIdx]?.trim();
                                        if (trimmed) anchorLineText = trimmed;
                                }
                        }

                        const children = await this.findComments(file, content, { line: startPos.line, ch: startPos.ch }, contentPos);

                        const subCommentIndex = content.indexOf(">");
                        if (subCommentIndex >= 0) content = content.slice(0, subCommentIndex);

                        const comment: CommentPP = {
                                id,
                                name,
                                content,
                                startPos,
                                endPos,
                                children,
                                contentPos,
                                file,
                                timestamp,
                                resolved,
                                edited,
                                anchorLineText,
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

        // ---------- Reading-mode post-processing ----------

        postProcessor(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
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

                        // Resolve via context's sourcePath rather than active mdView — fixes stale
                        // navigation when files have been moved.
                        const af = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
                        const file = af instanceof TFile ? af : null;
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

                                const comment = await this.getCommentById(id!, file);
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
                                        this.patchCalloutContextMenu(ev, id!);
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

        // ---------- Reading-mode context menu ----------

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
                };

                const menu = new Menu();

                menu.addItem((item) =>
                        item
                                .setTitle("Add sub-comment")
                                .setIcon("plus")
                                .onClick(async () => {
                                        const comment = await commonLogic();
                                        if (!comment) return;
                                        await this.addReply(comment);
                                })
                );

                menu.addItem((item) =>
                        item
                                .setTitle("Remove entire thread")
                                .setIcon("trash")
                                .onClick(async () => {
                                        const comment = await commonLogic();
                                        if (!comment) return;
                                        await this.removeComment(comment.parent ?? comment);
                                })
                );

                menu.showAtMouseEvent(ev);
        }

        // ---------- Comment mutations ----------

        async addReply(commentToReply: CommentPP) {
                let name: string = this.getName();
                if (!name) {
                        const result = await promptForCommentName(this.app, this.settings.defaultName);
                        if (!result) return;
                        name = result.text;
                }
                const content = await promptForCommentContent(this.app, this.mentionRegistry);
                if (!content) return;

                const formattedContent = content.text
                        .trim()
                        .split("\n")
                        .map((l) => `>> ${l.trim()}`);
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

        async editComment(comment: CommentPP) {
                const oldText = comment.content.trim();
                const result = await promptForEditComment(this.app, oldText, this.mentionRegistry);
                if (!result || result.text.trim() === oldText) return;

                const isReply = !!comment.parent;
                const prefix = isReply ? ">> " : "> ";

                await this.app.vault.process(comment.file, (fileContent) => {
                        const lines = fileContent.split("\n");
                        const headerIdx = comment.startPos.line - 1;
                        const headerLine = lines[headerIdx];
                        if (!headerLine || !headerLine.includes("[!COMMENT++]")) return fileContent;

                        // Tag the header with `| edited` (preserving any trailing `| resolved`).
                        if (!headerLine.includes(`${METADATA_SEPARATOR} edited`)) {
                                const trailingResolvedRe = new RegExp(`\\s*\\${METADATA_SEPARATOR}\\s*resolved\\s*$`);
                                if (trailingResolvedRe.test(headerLine)) {
                                        lines[headerIdx] = headerLine.replace(
                                                trailingResolvedRe,
                                                ` ${METADATA_SEPARATOR} edited ${METADATA_SEPARATOR} resolved`
                                        );
                                } else {
                                        lines[headerIdx] = headerLine.trimEnd() + ` ${METADATA_SEPARATOR} edited`;
                                }
                        }

                        // Replace the body lines until we hit a non-comment line or the next callout header.
                        const bodyStart = headerIdx + 1;
                        let bodyEnd = bodyStart;
                        const replyHeaderRe = /^>\s*>\s*\[!COMMENT\+\+\]/;
                        while (bodyEnd < lines.length) {
                                const line = lines[bodyEnd]!;
                                if (!line.startsWith(prefix.trimEnd())) break;
                                if (!isReply && replyHeaderRe.test(line)) break;
                                if (isReply && bodyEnd > bodyStart && line.includes("[!COMMENT++]")) break;
                                bodyEnd++;
                        }

                        const replacement = result.text
                                .trim()
                                .split("\n")
                                .map((l) => `${prefix}${l.trim()}`);

                        lines.splice(bodyStart, bodyEnd - bodyStart, ...replacement);
                        return lines.join("\n");
                });
        }
}
