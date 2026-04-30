import CommentsPlusPlus from "main";
import { IconName, ItemView, MarkdownView, Menu, TFile, WorkspaceLeaf } from "obsidian";
import { AllComments, CommentPP, MentionItem, MouseButton, isInlineMention } from "types";
import { ICON_NAME, PLUGIN_NAME, VIEW_TYPE_COMMENT } from "utils/constants";
import { CommentsNotice, hideChildren, isHidden, toggleChildren } from "utils/helpers";
import { DateTime } from "luxon";

type ViewMode = "file" | "mentions";
type FilterMode = "open" | "resolved" | "all";
type MentionSortMode = "default" | "date-newest" | "date-oldest" | "a-z" | "z-a";

// TODO: Improve class in general lol x2
// Make a separate manager/storage class
// Make an actual Comment++ class or Thread + Reply classes
export class CommentsPPView extends ItemView {
	private comments: AllComments = {};
	private commentsEl: HTMLElement;
	private mentionData: Map<string, MentionItem[]> = new Map();
	private mode: ViewMode = "file";
	private filterMode: FilterMode = "open";
	private tabFileEl: HTMLElement;
	private tabMentionsEl: HTMLElement;
	private filterToggleEl: HTMLElement;
	private mentionSortMode: MentionSortMode = "default";
	private mentionSearchQuery: string = "";
	private mentionSearchEl: HTMLInputElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: CommentsPlusPlus) {
		super(leaf);
	}

	getIcon(): IconName {
		return ICON_NAME;
	}

	getViewType(): string {
		return VIEW_TYPE_COMMENT;
	}

	getDisplayText(): string {
		return PLUGIN_NAME;
	}

	setComments(comments: CommentPP[], fileName: string) {
		this.comments[fileName]?.forEach((prevComment) => {
			const newComment = comments.find(c => prevComment.id && c.id && c.id === prevComment.id);
			if (newComment) {
				newComment.childrenHiddenView = prevComment.childrenHiddenView;
				newComment.childrenHiddenEditor = prevComment.childrenHiddenEditor;
			}
		});

		this.comments[fileName] = comments;
		if (this.mode === "file") this.renderComments(fileName);
	}

	setMentionComments(mentions: Map<string, MentionItem[]>) {
		this.mentionData = mentions;
		this.updateMentionBadge();
		if (this.mode === "mentions") this.renderMentions();
	}

	private updateMentionBadge() {
		if (!this.tabMentionsEl) return;
		const total = Array.from(this.mentionData.values()).reduce((sum, arr) => sum + arr.length, 0);
		if (total > 0) {
			this.tabMentionsEl.textContent = `@Mentions (${total})`;
		} else {
			this.tabMentionsEl.textContent = "@Mentions";
		}
	}

	private switchMode(newMode: ViewMode) {
		this.mode = newMode;
		this.tabFileEl.classList.toggle("active", newMode === "file");
		this.tabMentionsEl.classList.toggle("active", newMode === "mentions");

		// Show/hide filter toggle — only relevant in file mode
		if (this.filterToggleEl) {
			this.filterToggleEl.style.display = newMode === "file" ? "" : "none";
		}

		if (newMode === "file") {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) this.renderComments(activeFile.name);
			else this.commentsEl.empty();
		} else {
			this.renderMentions();
		}
	}

	private cycleFilter() {
		const order: FilterMode[] = ["open", "resolved", "all"];
		const idx = order.indexOf(this.filterMode);
		this.filterMode = order[(idx + 1) % order.length]!;
		this.updateFilterLabel();

		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) this.renderComments(activeFile.name);
	}

	private updateFilterLabel() {
		if (!this.filterToggleEl) return;
		const labels: Record<FilterMode, string> = {
			open: "Open",
			resolved: "Resolved",
			all: "All",
		};
		this.filterToggleEl.textContent = labels[this.filterMode];
		this.filterToggleEl.setAttribute("aria-label", `Filter: ${labels[this.filterMode]} — click to cycle`);
	}

	renderComments(fileName: string) {
		this.commentsEl.empty();

		const allComments = this.comments[fileName] ?? [];

		// Apply filter
		const filtered = allComments.filter((comment) => {
			if (this.filterMode === "open") return !comment.resolved;
			if (this.filterMode === "resolved") return comment.resolved;
			return true; // "all"
		});

		if (filtered.length === 0) {
			const emptyMsg = this.filterMode === "resolved"
				? "No resolved comments."
				: this.filterMode === "open"
					? "No open comments."
					: "No comments in this file.";
			this.commentsEl.createEl("p", {
				text: emptyMsg,
				cls: "comment-empty-state",
			});
			return;
		}

		filtered.forEach((comment) => {
			const commentContainer = this.commentsEl.createDiv({
				cls: `comment-item-container${comment.resolved ? " comment-item-container--resolved" : ""}`,
			});

			const headerDiv = commentContainer.createDiv({
				cls: "comment-header",
			});

			const infoDiv = headerDiv.createDiv({
				cls: "comment-info",
			});
			infoDiv.createEl("b", {
				text: comment.name,
				cls: "comment-name",
			});
			infoDiv.createEl("i", {
				text: comment.timestamp?.toLocaleString(DateTime.DATETIME_MED),
				cls: "comment-item-date",
			});

			// Edited badge
			if (comment.edited) {
				infoDiv.createSpan({
					text: "(edited)",
					cls: "comment-edited-badge",
				});
			}

			// Resolved badge
			if (comment.resolved) {
				headerDiv.createSpan({
					text: "(resolved)",
					cls: "comment-resolved-badge",
				});
			}

			const minimizeEl = headerDiv.createEl("button", {
				text: comment.childrenHiddenView ? "+" : "-",
				cls: "comment-minimize",
			});
			headerDiv.createEl("b", {
				text: `Line ${comment.contentPos.line}`,
				cls: "comment-line",
			});

			// Anchor line text excerpt
			if (comment.anchorLineText) {
				const excerpt = comment.anchorLineText.length > 80
					? comment.anchorLineText.slice(0, 80) + "..."
					: comment.anchorLineText;
				commentContainer.createDiv({
					text: excerpt,
					cls: "comment-anchor-excerpt",
				});
			}

			const commentItem = commentContainer.createDiv({
				cls: "comment-item",
			});
			const p = commentItem.createEl("p", {
				cls: "comment-item-text",
			});
			comment.content.trim().split("\n").forEach((line, index, { length }) => {
				p.createSpan({ text: line });
				if (index === length - 1) return;

				p.createEl("br");
			});

			commentItem.onClickEvent((ev) => {
				if (ev.button === MouseButton.RIGHT.valueOf()) {
					this.showCommentOptions(ev, comment, false);
					return;
				}

				if (ev.button !== MouseButton.LEFT.valueOf()) return;

				const handler = async () => {
					await this.navigateToComment(comment);
					// Bridge: also focus the margin card
					if (comment.id) {
						this.plugin.activeMarginPlugin?.focusCommentById(comment.id);
					}
				};
				handler().catch((e) => new CommentsNotice(`${e}`, 0));
			});

			if (!comment.children.length) {
				minimizeEl.hide();
				minimizeEl.setAttr("hidden", true);
				return;
			}

			const childrenCommentsEl = commentContainer.createDiv({
				cls: "comment-children",
			});
			if (comment.childrenHiddenView) hideChildren(childrenCommentsEl);

			this.renderChildrenComments(comment.children, fileName, childrenCommentsEl);

			minimizeEl.onClickEvent((ev) => {
				if (ev.button !== MouseButton.LEFT.valueOf()) return;

				comment.childrenHiddenView = !comment.childrenHiddenView;
				toggleChildren(childrenCommentsEl);
				if (isHidden(childrenCommentsEl)) {
					minimizeEl.setText("+");
					return;
				}

				minimizeEl.setText("-");
			});
		});
	}

	private renderMentions() {
		this.commentsEl.empty();

		// Search bar
		const searchBar = this.commentsEl.createDiv({ cls: "mention-search-bar" });
		this.mentionSearchEl = searchBar.createEl("input", {
			type: "text",
			placeholder: "Filter mentions...",
			cls: "mention-search-input",
			value: this.mentionSearchQuery,
		});
		this.mentionSearchEl.addEventListener("input", (e) => {
			this.mentionSearchQuery = (e.target as HTMLInputElement).value;
			this.renderMentionEntries();
		});

		// Sort indicator (clickable to cycle)
		if (this.mentionSortMode !== "default") {
			const sortLabel = searchBar.createSpan({ cls: "mention-sort-label" });
			const labels: Record<MentionSortMode, string> = {
				"default": "",
				"date-newest": "Newest",
				"date-oldest": "Oldest",
				"a-z": "A\u2192Z",
				"z-a": "Z\u2192A",
			};
			sortLabel.textContent = labels[this.mentionSortMode];
			sortLabel.addEventListener("click", () => {
				this.mentionSortMode = "default";
				this.renderMentions();
			});
		}

		// Container for the actual mention entries (re-rendered on filter/sort without rebuilding search bar)
		this.commentsEl.createDiv({ cls: "mention-entries-container" });
		this.renderMentionEntries();
	}

	/** Render just the mention entries (called by search filter and sort without rebuilding the search bar) */
	private renderMentionEntries() {
		const container = this.commentsEl.querySelector(".mention-entries-container") as HTMLElement;
		if (!container) return;
		container.empty();

		if (this.mentionData.size === 0) {
			container.createEl("p", {
				text: "No pending @mentions.",
				cls: "mention-empty-state",
			});
			return;
		}

		const query = this.mentionSearchQuery.toLowerCase().trim();

		// Build sorted file entries
		let entries = Array.from(this.mentionData.entries());

		// Apply search filter
		if (query) {
			entries = entries.map(([filePath, items]) => {
				const fileName = (filePath.split("/").pop() ?? filePath).replace(/\.md$/, "").toLowerCase();
				// If file name matches, keep all items
				if (fileName.includes(query)) return [filePath, items] as [string, MentionItem[]];
				// Otherwise filter to items whose content matches
				const filtered = items.filter((item) => {
					if (isInlineMention(item)) {
						return item.contextText.toLowerCase().includes(query)
							|| item.handle.toLowerCase().includes(query);
					}
					return item.content.toLowerCase().includes(query)
						|| item.name.toLowerCase().includes(query);
				});
				return [filePath, filtered] as [string, MentionItem[]];
			}).filter(([, items]) => items.length > 0);
		}

		// Apply sort
		entries = this.sortMentionEntries(entries);

		if (entries.length === 0) {
			container.createEl("p", {
				text: query ? "No mentions match your search." : "No pending @mentions.",
				cls: "mention-empty-state",
			});
			return;
		}

		// Group by file
		for (const [filePath, items] of entries) {
			const fileName = filePath.split("/").pop() ?? filePath;
			const fileGroup = container.createDiv({ cls: "mention-file-group" });

			const fileHeader = fileGroup.createDiv({ cls: "mention-file-header" });
			fileHeader.createSpan({ text: fileName.replace(/\.md$/, ""), cls: "mention-file-name" });
			fileHeader.createSpan({ text: `${items.length}`, cls: "mention-file-count" });

			const fileComments = fileGroup.createDiv({ cls: "mention-file-comments" });

			for (const mention of items) {
				if (isInlineMention(mention)) {
					// Inline body-text mention
					const item = fileComments.createDiv({ cls: "mention-item mention-item--inline" });

					const itemHeader = item.createDiv({ cls: "mention-item-header" });
					itemHeader.createSpan({ text: `@${mention.handle}`, cls: "mention-inline-handle" });
					itemHeader.createSpan({ text: `line ${mention.line + 1}`, cls: "mention-inline-line" });

					const contentEl = item.createDiv({ cls: "mention-item-content" });
					contentEl.textContent = mention.contextText;

					item.onClickEvent((ev) => {
						if (ev.button !== MouseButton.LEFT.valueOf()) return;
						const handler = async () => {
							await this.navigateToLine(mention.file, mention.line);
						};
						handler().catch((e) => new CommentsNotice(`${e}`, 0));
					});
				} else {
					// COMMENT++ callout mention (existing behavior)
					const comment = mention;
					const item = fileComments.createDiv({ cls: "mention-item" });

					const itemHeader = item.createDiv({ cls: "mention-item-header" });
					itemHeader.createEl("b", { text: comment.name, cls: "comment-name" });
					if (comment.timestamp) {
						itemHeader.createEl("i", {
							text: comment.timestamp.toLocaleString(DateTime.DATETIME_MED),
							cls: "comment-item-date",
						});
					}

					const contentEl = item.createDiv({ cls: "mention-item-content" });
					const preview = comment.content.trim().slice(0, 120);
					contentEl.textContent = preview + (comment.content.trim().length > 120 ? "..." : "");

					item.onClickEvent((ev) => {
						if (ev.button === MouseButton.RIGHT.valueOf()) {
							this.showCommentOptions(ev, comment, false);
							return;
						}
						if (ev.button !== MouseButton.LEFT.valueOf()) return;
						const handler = async () => {
							await this.navigateToComment(comment);
							if (comment.id) {
								this.plugin.activeMarginPlugin?.focusCommentById(comment.id);
							}
						};
						handler().catch((e) => new CommentsNotice(`${e}`, 0));
					});
				}
			}

			// Collapse/expand on left click
			fileHeader.onClickEvent((ev) => {
				if (ev.button !== MouseButton.LEFT.valueOf()) return;
				const hidden = fileComments.style.display === "none";
				fileComments.style.display = hidden ? "block" : "none";
				fileHeader.classList.toggle("collapsed", !hidden);
			});

			// Context menu on right click
			fileHeader.addEventListener("contextmenu", (ev) => {
				ev.preventDefault();
				this.showMentionFileMenu(ev, filePath, fileComments);
			});
		}
	}

	/** Sort mention entries based on current sort mode */
	private sortMentionEntries(entries: [string, MentionItem[]][]): [string, MentionItem[]][] {
		switch (this.mentionSortMode) {
			case "a-z":
				return entries.sort(([a], [b]) => {
					const nameA = (a.split("/").pop() ?? a).toLowerCase();
					const nameB = (b.split("/").pop() ?? b).toLowerCase();
					return nameA.localeCompare(nameB);
				});
			case "z-a":
				return entries.sort(([a], [b]) => {
					const nameA = (a.split("/").pop() ?? a).toLowerCase();
					const nameB = (b.split("/").pop() ?? b).toLowerCase();
					return nameB.localeCompare(nameA);
				});
			case "date-newest":
				return entries.sort(([, aItems], [, bItems]) => {
					const aMax = this.getNewestTimestamp(aItems);
					const bMax = this.getNewestTimestamp(bItems);
					return bMax - aMax;
				});
			case "date-oldest":
				return entries.sort(([, aItems], [, bItems]) => {
					const aMin = this.getOldestTimestamp(aItems);
					const bMin = this.getOldestTimestamp(bItems);
					return aMin - bMin;
				});
			default:
				return entries;
		}
	}

	private getNewestTimestamp(items: MentionItem[]): number {
		let max = 0;
		for (const item of items) {
			if (!isInlineMention(item) && item.timestamp) {
				const ms = item.timestamp.toMillis();
				if (ms > max) max = ms;
			}
		}
		return max;
	}

	private getOldestTimestamp(items: MentionItem[]): number {
		let min = Infinity;
		for (const item of items) {
			if (!isInlineMention(item) && item.timestamp) {
				const ms = item.timestamp.toMillis();
				if (ms < min) min = ms;
			}
		}
		return min === Infinity ? 0 : min;
	}

	/** Right-click context menu for file headers in the mentions view */
	private showMentionFileMenu(ev: MouseEvent, filePath: string, fileCommentsEl: HTMLElement) {
		const menu = new Menu();

		// Open note
		menu.addItem((item) =>
			item
				.setTitle("Open note")
				.setIcon("file-text")
				.onClick(async () => {
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						await this.getEditorLeaf().openFile(file);
					}
				})
		);

		menu.addSeparator();

		// Sort options
		const sortOptions: { title: string; mode: MentionSortMode; icon: string }[] = [
			{ title: "Sort by date (newest)", mode: "date-newest", icon: "arrow-down-wide-narrow" },
			{ title: "Sort by date (oldest)", mode: "date-oldest", icon: "arrow-up-wide-narrow" },
			{ title: "Sort A \u2192 Z", mode: "a-z", icon: "arrow-down-a-z" },
			{ title: "Sort Z \u2192 A", mode: "z-a", icon: "arrow-up-a-z" },
		];

		for (const opt of sortOptions) {
			menu.addItem((item) => {
				item
					.setTitle(opt.title)
					.setIcon(opt.icon)
					.onClick(() => {
						this.mentionSortMode = opt.mode;
						this.renderMentions();
					});
				if (this.mentionSortMode === opt.mode) {
					item.setChecked(true);
				}
			});
		}

		if (this.mentionSortMode !== "default") {
			menu.addItem((item) =>
				item
					.setTitle("Clear sort")
					.setIcon("x")
					.onClick(() => {
						this.mentionSortMode = "default";
						this.renderMentions();
					})
			);
		}

		menu.addSeparator();

		// Collapse/expand all
		menu.addItem((item) =>
			item
				.setTitle("Collapse all")
				.setIcon("chevrons-up")
				.onClick(() => {
					const container = this.commentsEl.querySelector(".mention-entries-container");
					if (!container) return;
					container.querySelectorAll(".mention-file-comments").forEach((el) => {
						(el as HTMLElement).style.display = "none";
					});
					container.querySelectorAll(".mention-file-header").forEach((el) => {
						el.classList.add("collapsed");
					});
				})
		);
		menu.addItem((item) =>
			item
				.setTitle("Expand all")
				.setIcon("chevrons-down")
				.onClick(() => {
					const container = this.commentsEl.querySelector(".mention-entries-container");
					if (!container) return;
					container.querySelectorAll(".mention-file-comments").forEach((el) => {
						(el as HTMLElement).style.display = "block";
					});
					container.querySelectorAll(".mention-file-header").forEach((el) => {
						el.classList.remove("collapsed");
					});
				})
		);

		menu.addSeparator();

		// Focus search
		menu.addItem((item) =>
			item
				.setTitle("Search mentions...")
				.setIcon("search")
				.onClick(() => {
					this.mentionSearchEl?.focus();
				})
		);

		menu.showAtMouseEvent(ev);
	}

	renderChildrenComments(comments: CommentPP[], fileName: string, element: HTMLElement) {
		element.empty();

		comments.forEach((comment) => {
			const commentContainer = element.createDiv({
				cls: "comment-child-container",
			});
			commentContainer.createDiv({
				cls: "comment-child-separator",
			});

			const headerDiv = commentContainer.createDiv({
				cls: "comment-header",
			});

			const infoDiv = headerDiv.createDiv({
				cls: "comment-info",
			});
			infoDiv.createEl("b", {
				text: comment.name,
				cls: "comment-name",
			});
			infoDiv.createEl("i", {
				text: comment.timestamp?.toLocaleString(DateTime.DATETIME_MED),
				cls: "comment-child-date",
			});
			if (comment.edited) {
				infoDiv.createSpan({
					text: "(edited)",
					cls: "comment-edited-badge",
				});
			}

			const commentItem = commentContainer.createDiv({
				cls: "comment-child",
			});
			const p = commentItem.createEl("p", {
				cls: "comment-child-text",
			});
			comment.content.trim().split("\n").forEach((line, index, { length }) => {
				p.createSpan({ text: line });
				if (index === length - 1) return;

				p.createEl("br");
			});

			commentItem.onClickEvent((ev) => {
				if (ev.button === MouseButton.RIGHT.valueOf()) {
					this.showCommentOptions(ev, comment, true);
					return;
				}

				if (ev.button !== MouseButton.LEFT.valueOf()) return;

				const handler = async () => {
					await this.navigateToComment(comment);
					// Bridge: also focus the parent's margin card
					const parentId = comment.parent?.id ?? comment.id;
					if (parentId) {
						this.plugin.activeMarginPlugin?.focusCommentById(parentId);
					}
				};
				handler().catch((e) => new CommentsNotice(`${e}`, 0));
			});
		});
	}

	/** Get a leaf in the main editor area, not the sidebar. */
	private getEditorLeaf(): WorkspaceLeaf {
		return this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)
			?? this.app.workspace.getLeaf(false);
	}

	/** Resolve a potentially-stale TFile reference.
	 *  Returns the current vault TFile, or null if the file is gone. */
	private resolveFile(staleFile: TFile): TFile | null {
		// Fast path: file still exists at cached path
		const current = this.app.vault.getAbstractFileByPath(staleFile.path);
		if (current instanceof TFile) return current;

		// Fallback: search by filename anywhere in the vault
		const found = this.app.vault.getMarkdownFiles().find(f => f.name === staleFile.name);
		return found ?? null;
	}

	private async navigateToComment(comment: CommentPP) {
		const targetFile = this.resolveFile(comment.file);
		if (!targetFile) {
			new CommentsNotice(`File "${comment.file.name}" no longer exists in the vault`, 5);
			return;
		}
		// Update stale reference so subsequent clicks work
		if (targetFile !== comment.file) comment.file = targetFile;

		const leaf = this.getEditorLeaf();
		await leaf.openFile(targetFile);

		// Defer cursor/scroll to next frame — openFile resolves before
		// CodeMirror finishes layout, so immediate calls silently no-op.
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		if (!editor) return;

		editor.setCursor(comment.contentPos);
		editor.scrollIntoView(
			{
				from: comment.contentPos,
				to: comment.contentPos,
			},
			true
		);
	}

	private async navigateToLine(file: TFile, line: number) {
		const targetFile = this.resolveFile(file);
		if (!targetFile) {
			new CommentsNotice(`File "${file.name}" no longer exists in the vault`, 5);
			return;
		}

		const leaf = this.getEditorLeaf();
		await leaf.openFile(targetFile);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

		const editor = this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
		if (!editor) return;

		const pos = { line, ch: 0 };
		editor.setCursor(pos);
		editor.scrollIntoView({ from: pos, to: pos }, true);
	}

	private showSidebarContextMenu(ev: MouseEvent) {
		// Only meaningful in file mode — @Mentions has no parent/child collapse model.
		if (this.mode !== "file") return;

		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return;

		const comments = this.comments[activeFile.name] ?? [];
		const hasNestable = comments.some((c) => c.children.length > 0);
		if (!hasNestable) return;

		const allCollapsed = comments.every((c) => c.children.length === 0 || c.childrenHiddenView);
		const allExpanded = comments.every((c) => c.children.length === 0 || !c.childrenHiddenView);

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Expand all")
				.setIcon("chevrons-down")
				.setDisabled(allExpanded)
				.onClick(() => this.setAllExpanded(activeFile.name, true))
		);
		menu.addItem((item) =>
			item
				.setTitle("Collapse all")
				.setIcon("chevrons-up")
				.setDisabled(allCollapsed)
				.onClick(() => this.setAllExpanded(activeFile.name, false))
		);

		menu.showAtMouseEvent(ev);
	}

	private setAllExpanded(fileName: string, expanded: boolean) {
		const comments = this.comments[fileName] ?? [];
		this.applyChildrenHiddenRecursive(comments, !expanded);
		this.renderComments(fileName);
	}

	private applyChildrenHiddenRecursive(comments: CommentPP[], hidden: boolean) {
		for (const c of comments) {
			c.childrenHiddenView = hidden;
			if (c.children.length > 0) this.applyChildrenHiddenRecursive(c.children, hidden);
		}
	}

	private showCommentOptions(ev: MouseEvent, comment: CommentPP, child: boolean) {
		const menu = new Menu();
		let addTitle = "Add sub-comment";
		let removeTitle = "Remove entire comment";

		if (child) {
			addTitle = "Add follow-up sub-comment";
			removeTitle = "Remove sub-comment";
		}

		// Edit option — only for the current user's own comments
		const currentName = this.plugin.getName();
		if (currentName && comment.name === currentName) {
			menu.addItem((item) =>
				item
					.setTitle("Edit")
					.setIcon("pencil")
					.onClick(async () => await this.plugin.editComment(comment))
			);
		}

		menu.addItem((item) =>
			item
				.setTitle(addTitle)
				.setIcon("plus")
				.onClick(async () => await this.addComment(comment))
		);

		// Resolve / Reopen action
		if (!child) {
			if (comment.resolved) {
				menu.addItem((item) =>
					item
						.setTitle("Reopen")
						.setIcon("rotate-ccw")
						.onClick(async () => await this.reopenComment(comment))
				);
			} else {
				menu.addItem((item) =>
					item
						.setTitle("Resolve")
						.setIcon("check")
						.onClick(async () => await this.resolveComment(comment))
				);
			}
		}

		menu.addItem((item) =>
			item
				.setTitle(removeTitle)
				.setIcon("trash")
				.onClick(async () => await this.removeComment(comment))
		);

		// In mentions mode, offer a lightweight "dismiss" that only clears the cache
		if (this.mode === "mentions") {
			menu.addItem((item) =>
				item
					.setTitle("Dismiss from sidebar")
					.setIcon("x")
					.onClick(() => this.removeMentionFromCache(comment))
			);
		}

		menu.showAtMouseEvent(ev);
	}

	private async addComment(comment: CommentPP) {
		await this.plugin.addReply(comment);
	}

	private async removeComment(comment: CommentPP) {
		const resolvedFile = this.resolveFile(comment.file);
		if (resolvedFile) {
			if (resolvedFile !== comment.file) comment.file = resolvedFile;
			await this.plugin.removeComment(comment);
		} else {
			new CommentsNotice(`File "${comment.file.name}" no longer exists — removing from sidebar`, 5);
		}

		// Clean up from both the "This File" cache and the mention cache
		const fileComments = this.comments[comment.file.name];
		if (fileComments) {
			fileComments.remove(comment);
			if (this.mode === "file") this.renderComments(comment.file.name);
		}
		this.removeMentionFromCache(comment);
	}

	/** Remove a single mention item from the plugin's mention cache and refresh the sidebar */
	private removeMentionFromCache(comment: CommentPP) {
		const mentions = this.plugin.mentionComments.get(comment.file.path);
		if (!mentions) return;
		const idx = mentions.indexOf(comment);
		if (idx >= 0) mentions.splice(idx, 1);
		if (mentions.length === 0) {
			this.plugin.mentionComments.delete(comment.file.path);
		}
		this.mentionData = this.plugin.mentionComments;
		this.updateMentionBadge();
		if (this.mode === "mentions") this.renderMentions();
	}

	/** Resolve a comment from the sidebar by delegating to vault.process */
	private async resolveComment(comment: CommentPP) {
		if (!comment.id) return;
		const file = comment.file;
		if (!(file instanceof TFile)) return;

		const { METADATA_SEPARATOR } = await import("utils/constants");
		await this.plugin.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (line.includes("[!COMMENT++]") && line.includes(comment.id!)) {
					lines[i] = line.trimEnd() + ` ${METADATA_SEPARATOR} resolved`;
					break;
				}
			}
			return lines.join("\n");
		});
	}

	/** Reopen a resolved comment from the sidebar */
	private async reopenComment(comment: CommentPP) {
		if (!comment.id) return;
		const file = comment.file;
		if (!(file instanceof TFile)) return;

		await this.plugin.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (line.includes("[!COMMENT++]") && line.includes(comment.id!)) {
					lines[i] = line.replace(/\s*\|\s*resolved\s*$/, "");
					break;
				}
			}
			return lines.join("\n");
		});
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		if (!container) {
			new CommentsNotice("Container not found", 0);
			return;
		}

		container.empty();
		const commentContainer = container.createDiv();

		// Tab bar
		const tabBar = commentContainer.createDiv({ cls: "comments-tab-bar" });
		this.tabFileEl = tabBar.createEl("button", { text: "This File", cls: "comments-tab active" });
		this.tabMentionsEl = tabBar.createEl("button", { text: "@Mentions", cls: "comments-tab" });

		// Filter toggle (cycles Open → Resolved → All)
		this.filterToggleEl = tabBar.createEl("button", { cls: "comments-filter-toggle" });
		this.updateFilterLabel();
		this.filterToggleEl.addEventListener("click", () => this.cycleFilter());

		this.tabFileEl.onClickEvent(() => this.switchMode("file"));
		this.tabMentionsEl.onClickEvent(() => this.switchMode("mentions"));

		this.commentsEl = commentContainer.createDiv();

		// Sidebar background context menu — Expand all / Collapse all (file mode).
		// Bails when the right-click landed on an actionable element so the
		// per-item handler (showCommentOptions) keeps owning that case.
		commentContainer.addEventListener("contextmenu", (ev) => {
			const target = ev.target as HTMLElement | null;
			if (!target) return;
			if (
				target.closest(".comment-item-container") ||
				target.closest(".mention-item") ||
				target.closest(".mention-file-header") ||
				target.closest("button") ||
				target.closest("input") ||
				target.closest("textarea")
			) return;

			ev.preventDefault();
			this.showSidebarContextMenu(ev);
		});

		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) await this.plugin.updateComments(activeFile);

		// Update mention badge with current data
		this.mentionData = this.plugin.mentionComments;
		this.updateMentionBadge();
	}
}
