import { ViewPlugin, ViewUpdate, EditorView } from "@codemirror/view";
import { Menu, MarkdownView } from "obsidian";
import { METADATA_SEPARATOR } from "utils/constants";
import { DateTime } from "luxon";
import type CommentsPlusPlus from "../main";

interface ParsedSubComment {
	name: string;
	content: string;
	timestamp: DateTime | undefined;
}

interface ParsedComment {
	name: string;
	content: string;
	timestamp: DateTime | undefined;
	id: string | undefined;
	from: number;
	to: number;
	children: ParsedSubComment[];
}

function parseMetadata(raw: string): { name: string; timestamp: DateTime | undefined; id: string | undefined } {
	let name = raw.trim();
	let timestamp: DateTime | undefined;
	let id: string | undefined;

	const sepIdx = name.indexOf(METADATA_SEPARATOR);
	if (sepIdx >= 0) {
		let date = name.slice(sepIdx + METADATA_SEPARATOR.length).trim();
		const idIdx = date.indexOf(METADATA_SEPARATOR);
		if (idIdx >= 0) {
			id = date.slice(idIdx + METADATA_SEPARATOR.length).trim();
			date = date.slice(0, idIdx).trim();
		}
		timestamp = DateTime.fromISO(date);
		name = name.slice(0, sepIdx).trim();
	}

	return { name, timestamp, id };
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

	constructor(
		private view: EditorView,
		private plugin: CommentsPlusPlus,
	) {
		this.marginEl = document.createElement("div");
		this.marginEl.className = "comment-margin-column";
		view.scrollDOM.appendChild(this.marginEl);
		view.dom.classList.add("has-margin-comments");

		this.comments = parseCommentsFromDoc(view.state.doc.toString());
		this.scheduleLayout();

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

	update(update: ViewUpdate) {
		if (update.docChanged) {
			this.comments = parseCommentsFromDoc(update.state.doc.toString());
			this.dirty = true;
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

	/** Attach hover + context menu listeners to a margin card */
	private attachCardEvents(card: HTMLElement, key: string) {
		card.addEventListener("mouseenter", () => {
			const anchor = this.anchors.find((a) => a.commentKey === key);
			if (!anchor) return;
			this.highlightAnchor(anchor.anchorLineFrom, card);
		});
		card.addEventListener("mouseleave", () => {
			this.clearHighlight();
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

	/**
	 * Highlight the anchor for a comment. Prefers <mark> elements (from ==text==);
	 * falls back to a left-border accent on the .cm-line.
	 */
	private highlightAnchor(anchorLineFrom: number, card: HTMLElement) {
		this.clearHighlight();

		const lineEl = this.getLineElementAt(anchorLineFrom);
		if (!lineEl) return;

		// Look for <mark> elements (rendered from ==highlighted text==)
		const marks = Array.from(lineEl.querySelectorAll("mark")) as HTMLElement[];

		if (marks.length > 0) {
			marks.forEach((m) => m.classList.add("comment-mark-highlight"));
			card.classList.add("margin-card-active");
			this.activeHighlight = {
				elements: marks,
				highlightClass: "comment-mark-highlight",
				card,
			};
		} else {
			// No marks — use a subtle left-border accent instead of painting the whole block
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

	private populateCard(card: HTMLElement, comment: ParsedComment) {
		card.textContent = "";

		const header = document.createElement("div");
		header.className = "margin-card-header";

		const nameEl = document.createElement("span");
		nameEl.className = "margin-card-name";
		nameEl.textContent = comment.name;
		header.appendChild(nameEl);

		if (comment.timestamp) {
			const dateEl = document.createElement("span");
			dateEl.className = "margin-card-date";
			dateEl.textContent = comment.timestamp.toLocaleString(DateTime.DATETIME_MED);
			header.appendChild(dateEl);
		}

		card.appendChild(header);

		const contentEl = document.createElement("div");
		contentEl.className = "margin-card-content";
		contentEl.textContent = comment.content;
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

				if (child.timestamp) {
					const replyDate = document.createElement("span");
					replyDate.className = "margin-card-date";
					replyDate.textContent = child.timestamp.toLocaleString(DateTime.DATETIME_MED);
					replyHeader.appendChild(replyDate);
				}

				replyEl.appendChild(replyHeader);

				const replyContent = document.createElement("div");
				replyContent.className = "margin-card-content";
				replyContent.textContent = child.content;
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

	destroy() {
		this.clearHighlight();
		this.resizeObserver.disconnect();
		if (this.editorMouseHandler) {
			this.view.contentDOM.removeEventListener("mouseover", this.editorMouseHandler);
			this.view.contentDOM.removeEventListener("mouseout", this.editorMouseHandler);
		}
		this.marginEl.remove();
		this.view.dom.classList.remove("has-margin-comments");
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
