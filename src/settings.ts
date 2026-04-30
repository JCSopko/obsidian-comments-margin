import { App, PluginSettingTab, Setting } from "obsidian";
import CommentsPlusPlus from "./main";

export interface CommentsPPSettings {
        useRelayFeatures: boolean;
        defaultName: string;
        expandSubCommentsInView: boolean;
        expandCommentsInEditor: boolean;
        alignmentInEditor: string;
        minimalMode: boolean;
        // TODO: Add datetime format setting
}

export const DEFAULT_SETTINGS: CommentsPPSettings = {
        useRelayFeatures: false,
        defaultName: "",
        expandSubCommentsInView: true,
        expandCommentsInEditor: false,
        alignmentInEditor: "left",
        minimalMode: false,
};

export class CommentsPPSettingTab extends PluginSettingTab {
        plugin: CommentsPlusPlus;

        constructor(app: App, plugin: CommentsPlusPlus) {
                super(app, plugin);
                this.plugin = plugin;
        }

        display(): void {
                const { containerEl } = this;

                containerEl.empty();

                const nameEl = new Setting(containerEl)
                        .setName("Default name")
                        .setDesc("This name will be used by default in comments.")
                        .addText((text) =>
                                text
                                        .setPlaceholder("Enter your name")
                                        .setValue(this.plugin.settings.defaultName)
                                        .onChange(async (value) => {
                                                this.plugin.settings.defaultName = value.trim();
                                                await this.plugin.saveSettings();
                                        })
                        )
                        .setDisabled(this.plugin.settings.useRelayFeatures);

                const relayDescription = new DocumentFragment();
                relayDescription.createSpan({
                        text: "Enable Relay features (if the plugin is installed):",
                });
                relayDescription.createEl("br");
                relayDescription.createSpan({
                        text: "- Use Relay login name instead of Default name",
                });
                new Setting(containerEl)
                        .setName("Relay integration")
                        .setDesc(relayDescription)
                        .addToggle((toggle) =>
                                toggle.setValue(this.plugin.settings.useRelayFeatures).onChange((value) => {
                                        this.plugin.settings.useRelayFeatures = value;
                                        nameEl.setDisabled(value);
                                })
                        );

                new Setting(containerEl)
                        .setName("Sub comments mode in view")
                        .setDesc("Whether to expand or collapse the sub comments when rendering in the right view.")
                        .addDropdown((dropdown) =>
                                dropdown
                                        .addOption("0", "Collapsed")
                                        .addOption("1", "Expanded")
                                        .setValue(this.plugin.settings.expandSubCommentsInView ? "1" : "0")
                                        .onChange(async (value) => {
                                                this.plugin.settings.expandSubCommentsInView = !!parseInt(value);
                                                await this.plugin.saveSettings();
                                        })
                        );

                new Setting(containerEl)
                        .setName("Comments mode in editor")
                        .setDesc("Whether to expand or collapse the comments when rendering in the editor.")
                        .addDropdown((dropdown) =>
                                dropdown
                                        .addOption("0", "Collapsed")
                                        .addOption("1", "Expanded")
                                        .setValue(this.plugin.settings.expandCommentsInEditor ? "1" : "0")
                                        .onChange(async (value) => {
                                                this.plugin.settings.expandCommentsInEditor = !!parseInt(value);
                                                await this.plugin.saveSettings();
                                        })
                        );

                new Setting(containerEl)
                        .setName("Comments alignment in editor")
                        .setDesc("Whether to align the comments to the left or the right.")
                        .addDropdown((dropdown) =>
                                dropdown
                                        .addOption("left", "Left")
                                        .addOption("right", "Right")
                                        .setValue(this.plugin.settings.alignmentInEditor)
                                        .onChange(async (value) => {
                                                this.plugin.settings.alignmentInEditor = value;
                                                await this.plugin.saveSettings();
                                        })
                        );
        }
}
