import { DateTime } from "luxon";
import { App, EditorPosition, TFile } from "obsidian";

export interface CommentPP {
        id?: string;
        name: string;
        content: string;
        startPos: EditorPosition;
        endPos: EditorPosition;
        contentPos: EditorPosition;
        children: CommentPP[];
        parent?: CommentPP;
        file: TFile;
        timestamp?: DateTime;
        childrenHiddenView: boolean;
        childrenHiddenEditor: boolean;
        resolved: boolean;
        edited: boolean;
        /** The text of the line the comment is anchored to (the line before the callout) */
        anchorLineText?: string;
}

export interface AllComments {
        [key: string]: CommentPP[];
}

export interface GenericDict {
        [key: string]: unknown;
}

interface AppPlugins {
        plugins: GenericDict;
}

export interface FixedApp extends App {
        plugins: AppPlugins;
}

export interface MentionEntry {
        handle: string;
        display: string;
        type: string;
        color: string;
}

/** An @mention found in body text (outside COMMENT++ callouts) */
export interface InlineMention {
        type: "inline";
        handle: string;
        file: TFile;
        line: number;          // 0-based line number
        contextText: string;   // the line content, truncated
}

/** Union of items that can appear in the @Mentions sidebar */
export type MentionItem = CommentPP | InlineMention;

export function isInlineMention(item: MentionItem): item is InlineMention {
        return "type" in item && item.type === "inline";
}

/**
 * Public surface of the margin-column ViewPlugin instance, exposed so that
 * other plugin parts (sidebar, status bar, command callbacks) can drive it
 * without coupling to the ViewPlugin class itself.
 */
export interface ActiveMarginPlugin {
        focusCommentById(commentId: string): boolean;
        focusNext(): void;
        focusPrev(): void;
        focusNextMention(name: string): { current: number; total: number } | false;
        resolveFromKeyboard(): void;
        setMinimalMode(value: boolean): void;
}

export enum MouseButton {
        LEFT,
        MIDDLE,
        RIGHT,
        FOURTH,
        FIFTH,
}
