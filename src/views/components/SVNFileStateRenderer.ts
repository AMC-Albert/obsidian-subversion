import { TFile, Notice, ButtonComponent } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';
import { CommitModal } from '../../modals';

export class SVNFileStateRenderer {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private onRefresh: () => void;

	constructor(plugin: ObsidianSvnPlugin, svnClient: SVNClient, onRefresh: () => void) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		this.onRefresh = onRefresh;
	}
	
	renderNotInSvn(container: HTMLElement, currentFile: TFile): void {
		container.empty();
		// Use setting-item structure for consistency
		const settingItem = container.createEl('div', { cls: 'setting-item' });
		const settingInfo = settingItem.createEl('div', { cls: 'setting-item-info' });
		settingInfo.createEl('div', {
			text: 'File not added to SVN',
			cls: 'setting-item-name'
		});
		settingInfo.createEl('div', {
			text: 'This file is not added to the SVN working copy yet.',
			cls: 'setting-item-description'
		});
		const settingControl = settingItem.createEl('div', { cls: 'setting-item-control' });
		new ButtonComponent(settingControl)
			.setButtonText('Add to SVN')
			.setClass('mod-cta')
			.onClick(async () => {
				try {
					await this.svnClient.addFile(currentFile.path);
					new Notice(`File ${currentFile.name} added to SVN`);
					this.onRefresh();
				} catch (error) {
					error('General', 'Failed to add file to SVN:', error);
					new Notice(`Failed to add file to SVN: ${error.message}`);
				}
			});
	}

	renderAddedButNotCommitted(container: HTMLElement, currentFile: TFile): void {
		container.empty();
		const settingItem = container.createEl('div', { cls: 'setting-item' });
		const settingInfo = settingItem.createEl('div', { cls: 'setting-item-info' });
		settingInfo.createEl('div', {
			text: 'File added but not committed',
			cls: 'setting-item-name'
		});
		settingInfo.createEl('div', {
			text: 'This file has been added to SVN but not yet committed.',
			cls: 'setting-item-description'
		});
		const settingControl = settingItem.createEl('div', { cls: 'setting-item-control' });
		new ButtonComponent(settingControl)
			.setButtonText('Commit')
			.setClass('mod-cta')
			.onClick(() => {
				const modal = new CommitModal(
					this.plugin.app,
					'Commit file',
					`Add ${currentFile.name}`,
					async (message: string) => {
						try {
							await this.svnClient.commitFile(currentFile.path, message);
							new Notice(`File ${currentFile.name} committed successfully`);
							this.onRefresh();
						} catch (error) {
							error('General', 'Failed to commit file:', error);
							new Notice(`Failed to commit: ${error.message}`);
						}
					}
				);
				modal.open();
			});
	}
}

