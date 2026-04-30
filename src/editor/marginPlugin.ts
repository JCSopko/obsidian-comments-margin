import { ViewPlugin, ViewUpdate, EditorView } from "@codemirror/view";
import { Menu, MarkdownView } from "obsidian";
import { METADATA_SEPARATOR } from "utils/constants";
import { DateTime } from "luxon";
import type CommentsPlusPlus from "../main";
import type { MentionEntry } from "types";

interface ParsedSubComment {
	name: string;
	content: string;
	timestamp: DateTime | undefined;
	edited: boolean;
}

interface ParsedComment {
	name: string;
	content: string;
	timestamp: DateTime | undefined;
	id: string | undefined;
	from: number;
	to: number;
	children: ParsedSubComment[];
	resolved: boolean;
	edited: boolean;
}

function parseMetadata(raw: string): { name: string; timestamp: DateTime | undefined; id: string | undefined; resolved: boolean; edited: boolean } {
	let name = raw.trim();
	let timestamp: DateTime | undefined;
	let id: string | undefined;
	let resolved = false;
	let edited = false;

	const sepIdx = name.indexOf(METADATA_SEPARATOR);
	if (sepIdx >= 0) {
		const segments = name.slice(sepIdx + METADATA_SEPARATOR.length).split(METADATA_SEPARATOR).map(s => s.trim());
		name = name.slice(0, sepIdx).trim();
		// segments: [date, id, ...flags]
		if (segments.length >= 1) timestamp = DateTime.fromISO(segments[0]!);
		if (segments.length >= 2) id = segments[1];
		for (let fi = 2; fi < segments.length; fi++) {
			const flag = segments[fi]!.toLowerCase();
			if (flag === "resolved") resolved = true;
			if (flag === "edited") edited = true;
		}
	}

	return { name, timestamp, id, resolved, edited };
}

function parseSubComments(strippedContent: string): { mainContent: string; children: ParsedSubComment[] } {
	const children: ParsedSubComment[] = [];

	const firstSubIdx = strippedContent.indexOf("[!COMMENT++]");
	if (firstSubIdx < 0) {
		return { mainContent: strippedContent.trim(), children };
	}

	const mainContent = strippedContent.slice(0, firstSubIdx).trim();
	const subContent = strippedContent.slice(firstSubIdx);

	// Match each sub-comment: header line then content lines until next sub-comment or end
	const subRegex = /\[!COMMENT\+\+\] (.+?)(?:\n([\s\S]*?))?(?=\[!COMMENT\+\+\]|$)/gi;
	for (const match of subContent.matchAll(subRegex)) {
		const meta = parseMetadata(match[1]!);
		const content = match[2]?.trim() || "";
		children.push({
			name: meta.name,
			timestamp: meta.timestamp,
			content,
			edited: meta.edited,
		});
	}

	return { mainContent, children };
}

function parseCommentsFromDoc(docText: string): ParsedComment[] {
	const regex = /> \[!COMMENT\+\+\] (.+?)\n((?:> *.*\n?)+)/gi;
	const comments: ParsedComment[] = [];

	for (const match of docText.matchAll(regex)) {
		if (match.length < 3 || typeof match.index !== "number") continue;

		const meta = parseMetadata(match[1]!);

		const stripped = match[2]!
			.split("\n")
			.map((line) => line.replace(/^>+\s?/, ""))
			.join("\n")
			.trim();

		const { mainContent, children } = parseSubComments(stripped);

		comments.push({
			name: meta.name,
			content: mainContent,
			timestamp: meta.timestamp,
			id: meta.id,
			from: match.index,
			to: match.index + match[0].length,
			children,
			resolved: meta.resolved,
			edited: meta.edited,
		});
	}

	return comments;
}

/** Association between a card and its anchor line in the editor */
interface CardAnchor {
	card: HTMLElement;
	anchorLineFrom: number;
	commentKey: string;
	commentId: string | undefined;
}

/** Tracks which elements are currently highlighted */
interface HighlightState {
	elements: HTMLElement[];
	highlightClass: string;
	card: HTMLElement;
}

/** Minimum editor width (px) to show the margin column */
const MIN_WIDTH_FOR_MARGIN = 600;

class MarginCommentPlugin {
	private marginEl: HTMLElement;
	private cards = new Map<string, HTMLElement>();
	private comments: ParsedComment[] = [];
	private dirty = true;
	private anchors: CardAnchor[] = [];
	private activeHighlight: HighlightState | null = null;
	private editorMouseHandler: ((e: MouseEvent) => void) | null = null;
	private resizeObserver: ResizeObserver;
	private marginVisible = true;
	private showResolved = false;
	private focusedIndex = -1;
	private mentionNavIndex = -1;
	private minimalMode = false;
	private expandedIcons = new Set<string>();
	private collapsedCards = new Set<string>();

	constructor(
		private view: EditorView,
		private plugin: CommentsPlusPlus,
	) {
		this.minimalMode = plugin.settings.minimalMode;
		this.marginEl = document.createElement("div");
		this.marginEl.className = "comment-margin-column";
		this.createMarginControls();
		view.scrollDOM.appendChild(this.marginEl);
		view.dom.classList.add("has-margin-comments");

		// Margin-column background context menu — shows Expand all / Collapse all when
		// right-clicking off any individual card. Per-card right-clicks already call
		// stopPropagation so this listener is only reached for empty-area clicks.
		this.marginEl.addEventListener("contextmenu", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.showMarginAreaContextMenu(ev);
		});

		this.comments = parseCommentsFromDoc(view.state.doc.toString());
		this.scheduleLayout();

		// Register this instance on the main plugin so commands can reach us
		this.plugin.activeMarginPlugin = this;

		// Delegated hover handler on the editor content for text→card linking
		this.editorMouseHandler = (e: MouseEvent) => this.handleEditorHover(e);
		view.contentDOM.addEventListener("mouseover", this.editorMouseHandler);
		view.contentDOM.addEventListener("mouseout", this.editorMouseHandler);

		// Hide margin column when editor is too narrow
		this.resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const show = entry.contentRect.width >= MIN_WIDTH_FOR_MARGIN;
				if (show !== this.marginVisible) {
					this.marginVisible = show;
					this.marginEl.style.display = show ? "" : "none";
				}
			}
		});
		this.resizeObserver.observe(view.dom);
	}

	private minimalToggleBtn: HTMLElement | null = null;

	/** Create the sticky controls row at the top of the margin column */
	private createMarginControls() {
		const row = document.createElement("div");
		row.className = "margin-controls-row";

		const toggle = document.createElement("button");
		toggle.className = "margin-resolved-toggle";
		toggle.textContent = "Show resolved";
		toggle.addEventListener("click", () => {
			this.showResolved = !this.showResolved;
			toggle.classList.toggle("active", this.showResolved);
			toggle.textContent = this.showResolved ? "Hide resolved" : "Show resolved";
			this.dirty = true;
			this.scheduleLayout();
		});

		const minimalBtn = document.createElement("button");
		minimalBtn.className = "margin-minimal-toggle";
		minimalBtn.classList.toggle("active", this.minimalMode);
		minimalBtn.textContent = this.minimalMode ? "Expand all" : "Minimize";
		minimalBtn.addEventListener("click", async () => {
			this.minimalMode = !this.minimalMode;
			this.expandedIcons.clear();
			this.collapsedCards.clear();
			this.plugin.settings.minimalMode = this.minimalMode;
			await this.plugin.saveSettings();
			minimalBtn.classList.toggle("active", this.minimalMode);
			minimalBtn.textContent = this.minimalMode ? "Expand all" : "Minimize";
			this.dirty = true;
			this.scheduleLayout();
		});
		this.minimalToggleBtn = minimalBtn;

		row.appendChild(toggle);
		row.appendChild(minimalBtn);
		this.marginEl.appendChild(row);
	}

	update(update: ViewUpdate) {
		if (update.docChanged) {
			this.comments = parseCommentsFromDoc(update.state.doc.toString());
			this.dirty = true;
			this.mentionNavIndex = -1;
		}
		if (update.docChanged || update.viewportChanged || update.geometryChanged) {
			this.scheduleLayout();
		}
	}

	private scheduleLayout() {
		this.view.requestMeasure({
			key: "margin-comments-layout",
			read: (view) => {
				const contentTop = view.contentDOM.offsetTop;
				return this.comments.map((c) => {
					const doc = view.state.doc;
					const calloutLine = doc.lineAt(c.from);
					let anchorPos = c.from;
					if (calloutLine.number > 1) {
						const prevLine = doc.line(calloutLine.number - 1);
						anchorPos = prevLine.from;
					}
					const block = view.lineBlockAt(anchorPos);
					return {
						top: block.top + contentTop,
						height: block.height,
						anchorLineFrom: anchorPos,
					};
				});
			},
			write: (positions) => {
				this.renderCards(positions);
				this.hideInlineCallouts();
				this.dirty = false;
			},
		});
	}

	/** JS-based hiding of inline callouts as backup for CSS */
	private hideInlineCallouts() {
		const callouts = this.view.contentDOM.querySelectorAll(
			'.callout[data-callout="comment++"]'
		);
		callouts.forEach((calloutEl) => {
			const embedBlock = calloutEl.closest(".cm-embed-block");
			if (embedBlock) {
				(embedBlock as HTMLElement).style.display = "none";
			}
		});
	}

	private renderCards(positions: { top: number; height: number; anchorLineFrom: number }[]) {
		const activeKeys = new Set<string>();
		let lastBottom = -Infinity;
		const STACK_GAP = 8;
		this.anchors = [];

		for (let i = 0; i < this.comments.length; i++) {
			const comment = this.comments[i]!;
			const pos = positions[i];
			if (!pos) continue;

			// Skip resolved comments unless "show resolved" toggle is active
			if (comment.resolved && !this.showResolved) continue;

			const key = comment.id || `idx-${i}`;
			activeKeys.add(key);

			let card = this.cards.get(key);
			if (!card) {
				card = document.createElement("div");
				card.className = "margin-comment-card";
				this.marginEl.appendChild(card);
				this.cards.set(key, card);
				this.populateCard(card, comment);
				this.attachCardEvents(card, key);
			} else if (this.dirty) {
				this.populateCard(card, comment);
			}

			card.classList.toggle("margin-comment-card--resolved", comment.resolved);

			// Collapse to icon: global minimal mode (unless individually expanded) OR individually collapsed
			const isMinimal = (this.minimalMode && !this.expandedIcons.has(key)) || this.collapsedCards.has(key);
			card.classList.toggle("margin-comment-card--minimal", isMinimal);

			// Ensure count badge exists for minimal mode
			let badge = card.querySelector(".margin-card-count-badge") as HTMLElement | null;
			if (!badge) {
				badge = document.createElement("span");
				badge.className = "margin-card-count-badge";
				card.appendChild(badge);
			}
			const threadCount = 1 + comment.children.length;
			badge.textContent = String(threadCount);
			badge.style.display = isMinimal && threadCount > 1 ? "" : "none";

			card.dataset.commentKey = key;
			this.anchors.push({
				card,
				anchorLineFrom: pos.anchorLineFrom,
				commentKey: key,
				commentId: comment.id,
			});

			let top = pos.top;
			if (top < lastBottom + STACK_GAP) {
				top = lastBottom + STACK_GAP;
			}
			card.style.top = `${top}px`;
			lastBottom = top + card.offsetHeight;
		}

		for (const [key, card] of this.cards) {
			if (!activeKeys.has(key)) {
				card.remove();
				this.cards.delete(key);
			}
		}
	}

	/** Attach hover + context menu + click listeners to a margin card */
	private attachCardEvents(card: HTMLElement, key: string) {
		card.addEventListener("mouseenter", () => {
			const anchor = this.anchors.find((a) => a.commentKey === key);
			if (!anchor) return;
			this.highlightAnchor(anchor.anchorLineFrom, card);
		});
		card.addEventListener("mouseleave", () => {
			this.clearHighlight();
		});

		// Click to expand/collapse when card is minimal (global or individually collapsed)
		card.addEventListener("click", (ev) => {
			const isCollapsed = this.collapsedCards.has(key) || (this.minimalMode && !this.expandedIcons.has(key));
			if (!isCollapsed) return;
			// Don't intercept clicks on buttons or interactive children
			if ((ev.target as HTMLElement).closest("button, .margin-card-replies-toggle")) return;

			// Expand: clear individual collapse, add to expanded if in minimal mode
			this.collapsedCards.delete(key);
			if (this.minimalMode) {
				this.expandedIcons.add(key);
			}
			this.dirty = true;
			this.scheduleLayout();
		});

		card.addEventListener("contextmenu", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.showCardContextMenu(ev, key);
		});
	}

	/** Show context menu for a margin card */
	private showCardContextMenu(ev: MouseEvent, key: string) {
		const anchor = this.anchors.find((a) => a.commentKey === key);
		const commentId = anchor?.commentId;
		if (!commentId) return;

		const file =
			this.plugin.mdView?.file ??
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!file) return;

		const menu = new Menu();

		// Find the parsed comment for resolve context
		const parsedComment = this.comments.find((c) => c.id === commentId);

		// Edit option — only for the current user's own comments
		const currentName = this.plugin.getName();
		if (currentName && parsedComment && parsedComment.name === currentName) {
			menu.addItem((item) =>
				item
					.setTitle("Edit")
					.setIcon("pencil")
					.onClick(async () => {
						const comment = await this.plugin.getCommentById(commentId, file);
						if (!comment) return;
						await this.plugin.editComment(comment);
					})
			);
		}

		if (parsedComment?.resolved) {
			menu.addItem((item) =>
				item
					.setTitle("Reopen")
					.setIcon("rotate-ccw")
					.onClick(async () => {
						if (parsedComment) await this.reopenComment(parsedComment);
					})
			);

			menu.addItem((item) =>
				item
					.setTitle("Delete")
					.setIcon("trash")
					.onClick(async () => {
						if (parsedComment) await this.deleteComment(parsedComment);
					})
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("Resolve")
					.setIcon("check")
					.onClick(async () => {
						if (parsedComment) await this.resolveComment(parsedComment);
					})
			);
		}

		menu.addItem((item) =>
			item
				.setTitle("Add sub-comment")
				.setIcon("plus")
				.onClick(async () => {
					const comment = await this.plugin.getCommentById(commentId, file);
					if (!comment) return;
					await this.plugin.addReply(comment);
				})
		);

		// Collapse / Expand toggle
		const isCurrentlyCollapsed = this.collapsedCards.has(key) || (this.minimalMode && !this.expandedIcons.has(key));
		menu.addItem((item) =>
			item
				.setTitle(isCurrentlyCollapsed ? "Expand" : "Collapse")
				.setIcon(isCurrentlyCollapsed ? "maximize-2" : "minimize-2")
				.onClick(() => {
					if (isCurrentlyCollapsed) {
						this.collapsedCards.delete(key);
						if (this.minimalMode) this.expandedIcons.add(key);
					} else {
						this.collapsedCards.add(key);
						this.expandedIcons.delete(key);
					}
					this.dirty = true;
					this.scheduleLayout();
				})
		);

		this.addExpandCollapseAllItems(menu);

		menu.addItem((item) =>
			item
				.setTitle("Remove entire thread")
				.setIcon("trash")
				.onClick(async () => {
					const comment = await this.plugin.getCommentById(commentId, file);
					if (!comment) return;
					await this.plugin.removeComment(comment.parent ?? comment);
				})
		);

		menu.showAtMouseEvent(ev);
	}

	/** Right-click on the margin column off any card — shows global Expand/Collapse all. */
	private showMarginAreaContextMenu(ev: MouseEvent) {
		// Only meaningful when there are cards to act on.
		if (this.anchors.length === 0) return;

		const menu = new Menu();
		this.addExpandCollapseAllItems(menu);
		menu.showAtMouseEvent(ev);
	}

	/** Append "Expand all" / "Collapse all" entries to a menu, with disabled-state when already in that state. */
	private addExpandCollapseAllItems(menu: Menu) {
		const allExpanded = !this.minimalMode && this.collapsedCards.size === 0;
		const allCollapsed = this.minimalMode && this.expandedIcons.size === 0;

		menu.addItem((item) =>
			item
				.setTitle("Expand all")
				.setIcon("chevrons-down")
				.setDisabled(allExpanded)
				.onClick(() => this.applyExpandAll(true))
		);
		menu.addItem((item) =>
			item
				.setTitle("Collapse all")
				.setIcon("chevrons-up")
				.setDisabled(allCollapsed)
				.onClick(() => this.applyExpandAll(false))
		);
	}

	/** Force every card into the expanded or collapsed state and persist minimalMode. */
	private async applyExpandAll(expanded: boolean) {
		this.collapsedCards.clear();
		this.expandedIcons.clear();
		this.minimalMode = !expanded;
		this.plugin.settings.minimalMode = this.minimalMode;
		await this.plugin.saveSettings();

		if (this.minimalToggleBtn) {
			this.minimalToggleBtn.classList.toggle("active", this.minimalMode);
			this.minimalToggleBtn.textContent = this.minimalMode ? "Expand all" : "Minimize";
		}
		this.dirty = true;
		this.scheduleLayout();
	}

	/**
	 * Highlight the anchor for a comment. Looks for highlight markers
	 * (==text== renders as .cm-highlight in CM6 live preview, <mark> in reading view);
	 * falls back to a left-border accent on the .cm-line.
	 */
	private highlightAnchor(anchorLineFrom: number, card: HTMLElement) {
		this.clearHighlight();

		const lineEl = this.getLineElementAt(anchorLineFrom);
		if (!lineEl) return;

		// TODO: highlight detection needs debugging — enable these logs to inspect DOM:
		// console.debug("[Comments++] Anchor line innerHTML:", lineEl.innerHTML);
		// console.debug("[Comments++] Anchor line children:", Array.from(lineEl.querySelectorAll("*")).map(
		//   (el) => `<${el.tagName.toLowerCase()} class="${el.className}">`));

		// CM6 live preview: ==text== → expected .cm-highlight but not confirmed
		// Reading view / postProcessor: ==text== → <mark>
		// Broader selector catches various Obsidian versions
		const highlights = Array.from(
			lineEl.querySelectorAll(".cm-highlight, mark, [class*='highlight']")
		).filter((el) => {
			// Exclude formatting marks (the == delimiters) which are hidden
			const style = window.getComputedStyle(el);
			return style.display !== "none";
		}) as HTMLElement[];

		if (highlights.length > 0) {
			highlights.forEach((el) => el.classList.add("comment-mark-highlight"));
			card.classList.add("margin-card-active");
			this.activeHighlight = {
				elements: highlights,
				highlightClass: "comment-mark-highlight",
				card,
			};
		} else {
			// No highlights — use a subtle left-border accent instead of painting the whole block
			lineEl.classList.add("comment-line-highlight");
			card.classList.add("margin-card-active");
			this.activeHighlight = {
				elements: [lineEl],
				highlightClass: "comment-line-highlight",
				card,
			};
		}
	}

	/** Handle mouseover on editor content → emphasize corresponding card */
	private handleEditorHover(e: MouseEvent) {
		if (e.type === "mouseout") {
			if (this.activeHighlight) {
				const related = e.relatedTarget as Node | null;
				if (related) {
					// Check if still within highlighted elements or the card
					const stillInside =
						this.activeHighlight.elements.some((el) => el.contains(related)) ||
						this.activeHighlight.card.contains(related);
					if (stillInside) return;
				}
				this.clearHighlight();
			}
			return;
		}

		// mouseover — find the .cm-line ancestor
		const target = e.target as HTMLElement;
		const lineEl = target.closest(".cm-line") as HTMLElement | null;
		if (!lineEl) return;

		const pos = this.view.posAtDOM(lineEl);
		const anchor = this.anchors.find((a) => {
			const line = this.view.state.doc.lineAt(a.anchorLineFrom);
			return pos >= line.from && pos <= line.to;
		});

		if (!anchor) return;

		// Don't re-highlight the same pair
		if (this.activeHighlight?.card === anchor.card) return;

		this.highlightAnchor(anchor.anchorLineFrom, anchor.card);
	}

	private clearHighlight() {
		if (this.activeHighlight) {
			for (const el of this.activeHighlight.elements) {
				el.classList.remove(this.activeHighlight.highlightClass);
			}
			this.activeHighlight.card.classList.remove("margin-card-active");
			this.activeHighlight = null;
		}
	}

	/** Get the DOM element for a .cm-line at a given document position */
	private getLineElementAt(pos: number): HTMLElement | null {
		try {
			const domInfo = this.view.domAtPos(pos);
			const node = domInfo.node;
			const el = node instanceof HTMLElement ? node : node.parentElement;
			return el?.closest(".cm-line") as HTMLElement | null;
		} catch {
			return null;
		}
	}

	/** Resolve a comment by appending `| resolved` to its callout header line */
	private async resolveComment(comment: ParsedComment) {
		if (!comment.id) return;

		const file =
			this.plugin.mdView?.file ??
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!file) return;

		await this.plugin.app.vault.process(file, (content) => {
			// Find the callout header line containing this comment's ID
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (line.includes("[!COMMENT++]") && line.includes(comment.id!)) {
					// Append | resolved
					lines[i] = line.trimEnd() + ` ${METADATA_SEPARATOR} resolved`;
					break;
				}
			}
			return lines.join("\n");
		});
	}

	/** Delete a comment entirely — removes the callout block and any ==highlight== markers on the anchor line */
	private async deleteComment(comment: ParsedComment) {
		if (!comment.id) return;

		const file =
			this.plugin.mdView?.file ??
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!file) return;

		const pluginComment = await this.plugin.getCommentById(comment.id, file);
		if (!pluginComment) return;
		await this.plugin.removeComment(pluginComment.parent ?? pluginComment);
	}

	/** Reopen a resolved comment by removing `| resolved` from its callout header line */
	private async reopenComment(comment: ParsedComment) {
		if (!comment.id) return;

		const file =
			this.plugin.mdView?.file ??
			this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file;
		if (!file) return;

		await this.plugin.app.vault.process(file, (content) => {
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (line.includes("[!COMMENT++]") && line.includes(comment.id!)) {
					// Strip the trailing | resolved
					lines[i] = line.replace(/\s*\|\s*resolved\s*$/, "");
					break;
				}
			}
			return lines.join("\n");
		});
	}

	private populateCard(card: HTMLElement, comment: ParsedComment) {
		card.textContent = "";

		const header = document.createElement("div");
		header.className = "margin-card-header";

		const nameEl = document.createElement("span");
		nameEl.className = "margin-card-name";
		nameEl.textContent = comment.name;
		header.appendChild(nameEl);

		if (comment.edited) {
			const editedEl = document.createElement("span");
			editedEl.className = "comment-edited-badge";
			editedEl.textContent = "(edited)";
			header.appendChild(editedEl);
		}

		if (comment.timestamp) {
			const dateEl = document.createElement("span");
			dateEl.className = "margin-card-date";
			dateEl.textContent = comment.timestamp.toLocaleString(DateTime.DATETIME_MED);
			header.appendChild(dateEl);
		}

		// Resolve / Reopen / Delete buttons
		if (comment.id) {
			if (comment.resolved) {
				const reopenBtn = document.createElement("button");
				reopenBtn.className = "margin-card-reopen";
				reopenBtn.setAttribute("aria-label", "Reopen comment");
				reopenBtn.textContent = "\u21A9"; // ↩
				reopenBtn.addEventListener("click", (ev) => {
					ev.stopPropagation();
					this.reopenComment(comment);
				});
				header.appendChild(reopenBtn);

				const deleteBtn = document.createElement("button");
				deleteBtn.className = "margin-card-delete";
				deleteBtn.setAttribute("aria-label", "Delete comment");
				deleteBtn.textContent = "\u00D7"; // ×
				deleteBtn.addEventListener("click", (ev) => {
					ev.stopPropagation();
					this.deleteComment(comment);
				});
				header.appendChild(deleteBtn);
			} else {
				const resolveBtn = document.createElement("button");
				resolveBtn.className = "margin-card-resolve";
				resolveBtn.setAttribute("aria-label", "Resolve comment");
				resolveBtn.textContent = "\u2713"; // ✓
				resolveBtn.addEventListener("click", (ev) => {
					ev.stopPropagation();
					this.resolveComment(comment);
				});
				header.appendChild(resolveBtn);
			}
		}

		card.appendChild(header);

		const contentEl = document.createElement("div");
		contentEl.className = "margin-card-content";
		const hasMention = this.renderContentWithMentions(contentEl, comment.content);
		if (hasMention) card.classList.add("margin-comment-card--has-mention");
		card.appendChild(contentEl);

		// Render sub-comments if present
		if (comment.children.length > 0) {
			const repliesToggle = document.createElement("div");
			repliesToggle.className = "margin-card-replies-toggle";
			repliesToggle.textContent = `${comment.children.length} ${comment.children.length === 1 ? "reply" : "replies"}`;
			card.appendChild(repliesToggle);

			const repliesContainer = document.createElement("div");
			repliesContainer.className = "margin-card-replies";
			repliesContainer.style.display = "none";

			for (const child of comment.children) {
				const replyEl = document.createElement("div");
				replyEl.className = "margin-card-reply";

				const replyHeader = document.createElement("div");
				replyHeader.className = "margin-card-reply-header";

				const replyName = document.createElement("span");
				replyName.className = "margin-card-name";
				replyName.textContent = child.name;
				replyHeader.appendChild(replyName);

				if (child.edited) {
					const replyEdited = document.createElement("span");
					replyEdited.className = "comment-edited-badge";
					replyEdited.textContent = "(edited)";
					replyHeader.appendChild(replyEdited);
				}

				if (child.timestamp) {
					const replyDate = document.createElement("span");
					replyDate.className = "margin-card-date";
					replyDate.textContent = child.timestamp.toLocaleString(DateTime.DATETIME_MED);
					replyHeader.appendChild(replyDate);
				}

				replyEl.appendChild(replyHeader);

				const replyContent = document.createElement("div");
				replyContent.className = "margin-card-content";
				const replyHasMention = this.renderContentWithMentions(replyContent, child.content);
				if (replyHasMention && !card.classList.contains("margin-comment-card--has-mention")) {
					card.classList.add("margin-comment-card--has-mention");
				}
				replyEl.appendChild(replyContent);

				repliesContainer.appendChild(replyEl);
			}

			card.appendChild(repliesContainer);

			repliesToggle.addEventListener("click", (ev) => {
				ev.stopPropagation();
				const isHidden = repliesContainer.style.display === "none";
				repliesContainer.style.display = isHidden ? "block" : "none";
				repliesToggle.classList.toggle("expanded", isHidden);
				// Recalculate stacking after expand/collapse changes card height
				this.scheduleLayout();
			});
		}
	}

	/** Render text with @mention spans highlighted. Returns true if the current user is mentioned. */
	private renderContentWithMentions(container: HTMLElement, text: string): boolean {
		const registry = this.plugin.mentionRegistry;
		if (registry.length === 0) {
			container.textContent = text;
			return false;
		}

		const handles = registry.map((m: MentionEntry) => m.handle);
		const pattern = new RegExp(`@(${handles.join("|")})\\b`, "gi");
		const currentUser = this.plugin.settings.defaultName.toLowerCase();
		let hasMentionForCurrentUser = false;
		let lastIndex = 0;

		for (const match of text.matchAll(pattern)) {
			if (typeof match.index !== "number") continue;
			if (match.index > lastIndex) {
				container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
			}
			const handle = match[1]!.toLowerCase();
			const entry = registry.find((m: MentionEntry) => m.handle === handle);
			const span = document.createElement("span");
			span.className = "mention";
			span.textContent = `@${entry?.display ?? match[1]}`;
			if (entry?.color) span.style.color = entry.color;
			if (handle === currentUser) {
				span.classList.add("mention--current-user");
				hasMentionForCurrentUser = true;
			}
			container.appendChild(span);
			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < text.length) {
			container.appendChild(document.createTextNode(text.slice(lastIndex)));
		} else if (lastIndex === 0) {
			container.textContent = text;
		}

		return hasMentionForCurrentUser;
	}

	destroy() {
		this.clearHighlight();
		this.clearFocus();
		this.resizeObserver.disconnect();
		if (this.editorMouseHandler) {
			this.view.contentDOM.removeEventListener("mouseover", this.editorMouseHandler);
			this.view.contentDOM.removeEventListener("mouseout", this.editorMouseHandler);
		}
		this.marginEl.remove();
		this.view.dom.classList.remove("has-margin-comments");
		if (this.plugin.activeMarginPlugin === this) {
			this.plugin.activeMarginPlugin = null;
		}
	}

	// --- Keyboard navigation (Phase 3c) ---

	/** Get the list of visible (non-resolved unless showResolved) anchors in document order */
	private getVisibleAnchors(): CardAnchor[] {
		return this.anchors;
	}

	/** Clear the focused-comment visual indicator */
	private clearFocus() {
		if (this.focusedIndex >= 0) {
			const anchors = this.getVisibleAnchors();
			const anchor = anchors[this.focusedIndex];
			if (anchor) {
				anchor.card.classList.remove("margin-card-focused");
			}
		}
		this.focusedIndex = -1;
	}

	/** Apply focus visual to the comment at the given index and scroll into view */
	private applyFocus(index: number) {
		const anchors = this.getVisibleAnchors();
		if (index < 0 || index >= anchors.length) return;

		this.clearFocus();
		this.focusedIndex = index;
		const anchor = anchors[index]!;
		anchor.card.classList.add("margin-card-focused");

		// Scroll editor to bring the anchor line into view
		this.view.dispatch({
			effects: EditorView.scrollIntoView(anchor.anchorLineFrom, { y: "center" }),
		});

		// Also scroll the card into view in the margin column
		anchor.card.scrollIntoView({ block: "nearest", behavior: "smooth" });

		// Highlight the anchor text
		this.highlightAnchor(anchor.anchorLineFrom, anchor.card);
	}

	/** Navigate to the next comment (wraps around) */
	focusNext() {
		const anchors = this.getVisibleAnchors();
		if (anchors.length === 0) return;
		const next = this.focusedIndex < anchors.length - 1 ? this.focusedIndex + 1 : 0;
		this.applyFocus(next);
	}

	/** Navigate to the previous comment (wraps around) */
	focusPrev() {
		const anchors = this.getVisibleAnchors();
		if (anchors.length === 0) return;
		const prev = this.focusedIndex > 0 ? this.focusedIndex - 1 : anchors.length - 1;
		this.applyFocus(prev);
	}

	/** Resolve the currently focused comment */
	resolveFromKeyboard() {
		const anchors = this.getVisibleAnchors();
		if (this.focusedIndex < 0 || this.focusedIndex >= anchors.length) return;

		const anchor = anchors[this.focusedIndex]!;
		const comment = this.comments.find((c) => (c.id || `idx-${this.comments.indexOf(c)}`) === anchor.commentKey);
		if (!comment || comment.resolved) return;
		this.resolveComment(comment);
	}

	/** Navigate to the next unresolved comment mentioning the given handle. Returns true if any found. */
	focusNextMention(handle: string): { current: number; total: number } | false {
		const pattern = new RegExp(`@${handle}\\b`, "i");
		const mentionAnchors = this.anchors.filter((anchor) => {
			const comment = this.comments.find(
				(c) => (c.id || `idx-${this.comments.indexOf(c)}`) === anchor.commentKey
			);
			if (!comment || comment.resolved) return false;
			return pattern.test(comment.content) || comment.children.some((ch) => pattern.test(ch.content));
		});
		if (mentionAnchors.length === 0) return false;

		this.mentionNavIndex = (this.mentionNavIndex + 1) % mentionAnchors.length;
		const anchor = mentionAnchors[this.mentionNavIndex]!;
		const globalIndex = this.anchors.indexOf(anchor);
		this.applyFocus(globalIndex);
		return { current: this.mentionNavIndex + 1, total: mentionAnchors.length };
	}

	/** Set minimal mode from external command (toggle-minimal-mode) */
	setMinimalMode(enabled: boolean) {
		this.minimalMode = enabled;
		this.expandedIcons.clear();
		this.collapsedCards.clear();
		if (this.minimalToggleBtn) {
			this.minimalToggleBtn.classList.toggle("active", enabled);
			this.minimalToggleBtn.textContent = enabled ? "Expand all" : "Minimize";
		}
		this.dirty = true;
		this.scheduleLayout();
	}

	/**
	 * Focus the margin card for a comment by its ID (or key).
	 * Called from the sidebar when a comment entry is clicked.
	 * Returns true if the comment was found and focused.
	 */
	focusCommentById(commentId: string): boolean {
		const index = this.anchors.findIndex((a) => a.commentId === commentId || a.commentKey === commentId);
		if (index < 0) return false;
		this.applyFocus(index);
		return true;
	}
}

export function createMarginCommentExtension(plugin: CommentsPlusPlus) {
	return ViewPlugin.fromClass(
		class extends MarginCommentPlugin {
			constructor(view: EditorView) {
				super(view, plugin);
			}
		}
	);
}
