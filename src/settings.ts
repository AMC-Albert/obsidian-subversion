import { App, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianSvnPlugin from './main';
import { SvnPluginSettings } from '@/types';
import { loggerDebug, registerLoggerClass } from '@/utils/obsidian-logger';

export class SvnSettingTab extends PluginSettingTab {
	plugin: ObsidianSvnPlugin;

	constructor(app: App, plugin: ObsidianSvnPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		registerLoggerClass(this, 'SvnSettingTab');
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('SVN binary path')
			.setDesc('Path to your SVN binary executable. Leave as "svn" if it\'s in your PATH environment variable.')
			.addText(text => text
				.setPlaceholder('svn')
				.setValue(this.plugin.settings.svnBinaryPath)
				.onChange(async (value) => {
					this.plugin.settings.svnBinaryPath = value;
					await this.plugin.saveSettings();
				}));        new Setting(containerEl)
			.setName('Repository name')
			.setDesc('Default name for your SVN repository (without the dot prefix). This will be used as the default when creating a new repository.')
			.addText(text => {
				let saveTimeout: NodeJS.Timeout;
				
				return text
					.setPlaceholder('my-vault-repo')
					.setValue(this.plugin.settings.repositoryName || '')
					.onChange(async (value) => {
						//debug('Settings', Raw repository name input:', value);
						
						// Clear any existing timeout
						if (saveTimeout) {
							clearTimeout(saveTimeout);
						}
						
						// Debounce the save operation
						saveTimeout = setTimeout(async () => {
							// Strip any leading dots to ensure consistent handling
							const cleanValue = value.replace(/^\.+/, '');
							//debug('Settings', Cleaned repository name:', cleanValue);
							this.plugin.settings.repositoryName = cleanValue;
							await this.plugin.saveSettings();
							//debug('Settings', Saved settings:', this.plugin.settings);
						}, 500); // Wait 500ms after user stops typing
					});
			});

		new Setting(containerEl)
			.setName('Auto-commit')
			.setDesc('Automatically commit changes when files are saved')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoCommit)
				.onChange(async (value) => {
					this.plugin.settings.autoCommit = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default commit message')
			.setDesc('Default message for auto-commits')
			.addText(text => text
				.setPlaceholder('Auto-commit from Obsidian')
				.setValue(this.plugin.settings.commitMessage)
				.onChange(async (value) => {
					this.plugin.settings.commitMessage = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Pin checked out revision')
			.setDesc('Show the currently checked out revision in a separate pinned container at the top of the history.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.pinCheckedOutRevision)
				.onChange(async (value) => {
					this.plugin.settings.pinCheckedOutRevision = value;
					await this.plugin.saveSettings();
				}));
	}
}





