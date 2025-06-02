import { App, Modal, Setting, Notice } from "obsidian";
import type ObsidianSvnPlugin from "../main";

export class CreateRepoModal extends Modal {
	private plugin: ObsidianSvnPlugin;
	private onConfirm: (repoName: string) => Promise<void>;
	private onCancel: () => void;
	private defaultRepoName: string;

	constructor(app: App, plugin: ObsidianSvnPlugin, defaultRepoName: string, onConfirm: (repoName: string) => Promise<void>, onCancel: () => void) {
		super(app);
		this.plugin = plugin;
		this.defaultRepoName = defaultRepoName;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass('mod-svn-create-repo');
		
		const modalHeader = modalEl.querySelector('.modal-header');
		if (modalHeader) {
			modalHeader.createDiv('modal-title', el => {
				el.textContent = 'Create SVN Repository';
			});
		}

		let repoName = '';

		contentEl.createEl("p", { 
			text: "Create a new local SVN repository in your vault. The repository folder will be hidden from Obsidian (prefixed with dot), but the plugin will manage it." 
		});
		  const inputContainer = contentEl.createDiv('svn-input-container');
		const input = inputContainer.createEl('input', {
			type: 'text',
			placeholder: 'Enter the name for your repository',
			cls: 'svn-modal-input',
			value: this.defaultRepoName
		});

		const buttonRow = contentEl.createDiv('modal-button-container');
		new Setting(buttonRow)
			.addButton(btn => btn
				.setButtonText('Create repository')
				.setClass('mod-cta')
				.onClick(async () => {
					const inputValue = input.value.trim();
					if (!inputValue) {
						input.focus();
						return;
					}
					
					// Clean the repo name (strip any leading dots)
					const cleanRepoName = inputValue.replace(/^\.+/, '');
					if (!cleanRepoName) {
						new Notice('Repository name cannot be empty.');
						input.focus();
						return;
					}
					  // Check if directory already exists
					const hiddenRepoName = `.${cleanRepoName}`;
					
					try {
						const exists = await this.plugin.app.vault.adapter.exists(hiddenRepoName);
						if (exists) {
							new Notice(`Directory '${hiddenRepoName}' already exists.`);
							input.focus();
							return;
						}
					} catch (error) {
						// If we can't check, let the SVN creation handle it
					}
					
					// Save the repository name setting
					this.plugin.settings.repositoryName = cleanRepoName;
					await this.plugin.saveSettings();
					
					// Call the confirm handler
					await this.onConfirm(cleanRepoName);
					this.close();
				})
			)
			.addButton(btn => btn
				.setButtonText('Cancel')
				.setClass('mod-cancel')
				.onClick(() => {
					this.onCancel();
					this.close();
				})
			);

		input.addEventListener('input', (e) => {
			repoName = (e.target as HTMLInputElement).value;
		});        input.addEventListener('keydown', async (e) => {
			if (e.key === 'Enter') {
				const inputValue = input.value.trim();
				if (!inputValue) {
					input.focus();
					return;
				}
				
				// Clean the repo name (strip any leading dots)
				const cleanRepoName = inputValue.replace(/^\.+/, '');
				if (!cleanRepoName) {
					new Notice('Repository name cannot be empty.');
					input.focus();
					return;
				}
				
				// Check if directory already exists
				const hiddenRepoName = `.${cleanRepoName}`;
				
				try {
					const exists = await this.plugin.app.vault.adapter.exists(hiddenRepoName);
					if (exists) {
						new Notice(`Directory '${hiddenRepoName}' already exists.`);
						input.focus();
						return;
					}
				} catch (error) {
					// If we can't check, let the SVN creation handle it
				}
				
				// Save the repository name setting
				this.plugin.settings.repositoryName = cleanRepoName;
				await this.plugin.saveSettings();
				
				// Call the confirm handler
				await this.onConfirm(cleanRepoName);
				this.close();
			} else if (e.key === 'Escape') {
				this.onCancel();
				this.close();
			}
		});

		input.focus();
	}
}
