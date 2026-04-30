import { App, Modal, Setting } from "obsidian";
import { CommentsNotice } from "utils/helpers";
import type { MentionEntry } from "types";

interface ModalResult {
        text: string;
}

type ModalOptionsType = {
        header: string;
        description: string;
        initial?: ModalResult;
        canBeEmpty?: boolean;
        mentions?: MentionEntry[];
};

interface ModalOptions {
        header: string;
        description: DocumentFragment;
        initial: ModalResult;
        canBeEmpty: boolean;
        mentions: MentionEntry[];
}

class EnterTextModal extends Modal {
        input: ModalResult;
        options: ModalOptions;

        constructor(app: App, options: ModalOptionsType, public callback: (result: ModalResult) => unknown) {
                super(app);
                const df = new DocumentFragment();
                options.description.split("\n").forEach((line, index, { length }) => {
                        df.createSpan({
                                text: line,
                        });
                        if (index === length - 1) return;

                        df.createEl("br");
                });
                this.options = {
                        header: options.header,
                        description: df,
                        initial: options.initial || { text: "" },
                        canBeEmpty: options.canBeEmpty ?? true,
                        mentions: options.mentions ?? [],
                };
                this.input = this.options.initial;
        }

        onOpen() {
                this.setHeading();
                this.setField();
                this.setButtons();
        }

        onClose() {
                const { contentEl } = this;
                contentEl.empty();
        }

        protected setHeading() {
                new Setting(this.contentEl).setName(this.options.header).setHeading();
        }

        protected setField() {
                new Setting(this.contentEl)
                        .addText(
                                (text) =>
                                        (text.setValue(this.input.text).onChange((value) => {
                                                this.input.text = value;
                                        }).inputEl.onkeydown = (ev) => {
                                                if (ev.key !== "Enter") return;

                                                ev.preventDefault();
                                                this.onEnterHandler(ev);
                                        })
                        )
                        .setDesc(this.options.description);
        }

        protected setButtons() {
                new Setting(this.contentEl)
                        .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
                        .addButton((btn) =>
                                btn
                                        .setButtonText("OK")
                                        .setCta()
                                        .onClick((ev) => this.onEnterHandler(ev))
                        );
        }

        protected onEnterHandler(_ev: UIEvent) {
                if (!this.input.text.trim() && !this.options.canBeEmpty) {
                        new CommentsNotice("This field cannot be empty");
                        return;
                }

                this.close();
                this.callback(this.input);
        }
}

// TODO: Improve class in general lol
// Consider making an abstract class and/or make it more flexible/complex
class EnterTextAreaModal extends EnterTextModal {
        private dropdown: HTMLElement | null = null;
        private filteredMentions: MentionEntry[] = [];
        private selectedIndex = 0;

        protected setField() {
                const setting = new Setting(this.contentEl)
                        .addTextArea(
                                (text) =>
                                        (text.setValue(this.input.text).onChange((value) => {
                                                this.input.text = value;
                                        }).inputEl.onkeydown = (ev) => {
                                                if (this.dropdown && this.dropdown.style.display !== "none") {
                                                        if (this.handleDropdownKeys(ev)) return;
                                                }
                                                if (!ev.ctrlKey || ev.key !== "Enter") return;

                                                ev.preventDefault();
                                                this.onEnterHandler(ev);
                                        })
                        )
                        .setDesc(this.options.description)
                        .setClass("comment-bigger-input");

                if (this.options.mentions.length > 0) {
                        const textareaEl = setting.controlEl.querySelector("textarea");
                        if (textareaEl) this.setupMentionAutocomplete(textareaEl);
                }
        }

        private setupMentionAutocomplete(textareaEl: HTMLTextAreaElement) {
                this.dropdown = document.createElement("div");
                this.dropdown.className = "mention-autocomplete";
                this.dropdown.style.display = "none";
                textareaEl.parentElement?.appendChild(this.dropdown);

                textareaEl.addEventListener("input", () => this.updateDropdown(textareaEl));
        }

        private getAtQuery(textareaEl: HTMLTextAreaElement): string | null {
                const text = textareaEl.value;
                const pos = textareaEl.selectionStart;
                let i = pos - 1;
                while (i >= 0 && /\w/.test(text[i]!)) i--;
                if (i >= 0 && text[i] === "@") {
                        // Ensure @ is at start or after whitespace
                        if (i === 0 || /\s/.test(text[i - 1]!)) {
                                return text.slice(i + 1, pos).toLowerCase();
                        }
                }
                return null;
        }

        private updateDropdown(textareaEl: HTMLTextAreaElement) {
                if (!this.dropdown) return;
                const query = this.getAtQuery(textareaEl);
                if (query === null) {
                        this.dropdown.style.display = "none";
                        return;
                }

                this.filteredMentions = this.options.mentions.filter(
                        (m) => m.handle.startsWith(query) || m.display.toLowerCase().startsWith(query)
                );

                if (this.filteredMentions.length === 0) {
                        this.dropdown.style.display = "none";
                        return;
                }

                this.selectedIndex = 0;
                this.dropdown.empty();
                this.dropdown.style.display = "block";

                this.filteredMentions.forEach((m, i) => {
                        const item = document.createElement("div");
                        item.className = "mention-autocomplete-item";
                        if (i === this.selectedIndex) item.classList.add("selected");

                        const colorBar = document.createElement("span");
                        colorBar.className = "mention-autocomplete-color";
                        colorBar.style.backgroundColor = m.color;
                        item.appendChild(colorBar);

                        const label = document.createElement("span");
                        label.textContent = `@${m.handle}`;
                        item.appendChild(label);

                        const typeLabel = document.createElement("span");
                        typeLabel.className = "mention-autocomplete-type";
                        typeLabel.textContent = m.type;
                        item.appendChild(typeLabel);

                        item.addEventListener("mousedown", (ev) => {
                                ev.preventDefault();
                                this.insertMention(textareaEl, m);
                        });
                        this.dropdown!.appendChild(item);
                });
        }

        private insertMention(textareaEl: HTMLTextAreaElement, mention: MentionEntry) {
                const text = textareaEl.value;
                const pos = textareaEl.selectionStart;
                let i = pos - 1;
                while (i >= 0 && /\w/.test(text[i]!)) i--;
                if (i >= 0 && text[i] === "@") {
                        const before = text.slice(0, i);
                        const after = text.slice(pos);
                        textareaEl.value = `${before}@${mention.handle} ${after}`;
                        const newPos = i + mention.handle.length + 2;
                        textareaEl.selectionStart = newPos;
                        textareaEl.selectionEnd = newPos;
                        this.input.text = textareaEl.value;
                }
                if (this.dropdown) this.dropdown.style.display = "none";
                textareaEl.focus();
        }

        private handleDropdownKeys(ev: KeyboardEvent): boolean {
                if (!this.dropdown || this.filteredMentions.length === 0) return false;
                const textareaEl = ev.target as HTMLTextAreaElement;

                if (ev.key === "ArrowDown") {
                        ev.preventDefault();
                        this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredMentions.length - 1);
                        this.updateSelected();
                        return true;
                } else if (ev.key === "ArrowUp") {
                        ev.preventDefault();
                        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
                        this.updateSelected();
                        return true;
                } else if (ev.key === "Enter" && !ev.ctrlKey) {
                        ev.preventDefault();
                        const selected = this.filteredMentions[this.selectedIndex];
                        if (selected) this.insertMention(textareaEl, selected);
                        return true;
                } else if (ev.key === "Escape") {
                        this.dropdown.style.display = "none";
                        return true;
                }
                return false;
        }

        private updateSelected() {
                if (!this.dropdown) return;
                this.dropdown.querySelectorAll(".mention-autocomplete-item").forEach((el, i) => {
                        el.classList.toggle("selected", i === this.selectedIndex);
                });
        }
}

export const promptForText = (app: App, options: ModalOptionsType) => {
        return new Promise<ModalResult | void>((resolve) => {
                new EnterTextModal(app, options, (callback) => resolve(callback)).open();
        });
};

export const promptForTextArea = (app: App, options: ModalOptionsType) => {
        return new Promise<ModalResult | void>((resolve) => {
                new EnterTextAreaModal(app, options, (callback) => resolve(callback)).open();
        });
};

export const promptForDefaultName = (app: App) => {
        return promptForText(app, {
                header: "Enter your default name",
                description: "This name will be used by default in comments.",
        });
};

export const promptForCommentName = (app: App, text: string = "") => {
        return promptForText(app, {
                header: "Enter the comment name",
                description: "This name will be included in the comment.\nYou can skip this step by defining a default name in the plugin settings.",
                // canBeEmpty: false,
                initial: { text },
        });
};

export const promptForCommentContent = (app: App, mentions?: MentionEntry[]) => {
        return promptForTextArea(app, {
                header: "Enter the comment content",
                description: "",
                canBeEmpty: false,
                mentions,
        });
};

export const promptForEditComment = (app: App, existingText: string, mentions?: MentionEntry[]) => {
        return promptForTextArea(app, {
                header: "Edit comment",
                description: "",
                canBeEmpty: false,
                initial: { text: existingText },
                mentions,
        });
};
