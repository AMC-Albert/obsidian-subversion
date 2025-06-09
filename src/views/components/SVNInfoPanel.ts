import { TFile } from 'obsidian';
import { join } from 'path';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';
import { debug, info, error, registerLoggerClass } from '@/utils/obsidian-logger';

export class SVNInfoPanel {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private panelElement: HTMLElement | null = null;
	constructor(plugin: ObsidianSvnPlugin, svnClient: SVNClient) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		registerLoggerClass(this, 'SVNInfoPanel');
	}

	setPanelElement(element: HTMLElement): void {
		this.panelElement = element;
	}

	toggle(): void {
		if (!this.panelElement) return;
		
		if (this.panelElement.style.display === 'none') {
			this.panelElement.style.display = 'block';
		} else {
			this.panelElement.style.display = 'none';
		}
	}

	hide(): void {
		if (!this.panelElement) return;
		this.panelElement.style.display = 'none';
	}

	show(): void {
		if (!this.panelElement) return;
		this.panelElement.style.display = 'block';
	}

	async render(currentFile: TFile | null): Promise<void> {
		if (!this.panelElement || !currentFile) return;

		this.panelElement.empty();
		
		try {
			const isWorkingCopy = await this.svnClient.isWorkingCopy(currentFile.path);
			if (!isWorkingCopy) {
				this.panelElement.createEl('p', { 
					text: 'File is not in an SVN working copy',
					cls: 'svn-info-warning'
				});
				return;
			}

			const isFileInSvn = await this.svnClient.isFileInSvn(currentFile.path);
			if (!isFileInSvn) {
				this.panelElement.createEl('p', { 
					text: 'File is not tracked by SVN',
					cls: 'svn-info-warning'
				});
				return;
			}      			// Get SVN info for the file
			const info = await this.svnClient.getInfo(currentFile.path);
			
			if (info) {
				// Add SVN information heading
				this.panelElement.createEl('h3', { 
					text: 'SVN Information',
					cls: 'svn-info-section-header'
				});
				
				const infoList = this.panelElement.createEl('ul', { cls: 'svn-info-list' });				if (info.lastChangedRev) {
					const item = infoList.createEl('li', { cls: 'svn-info-item' });
					item.createEl('strong', { text: 'Last Changed Rev: ' });
					item.createSpan({ text: String(info.lastChangedRev) });
				}
				
				if (info.lastChangedAuthor) {
					const item = infoList.createEl('li', { cls: 'svn-info-item' });
					item.createEl('strong', { text: 'Last Changed Author: ' });
					item.createSpan({ text: info.lastChangedAuthor });
				}
				
				if (info.lastChangedDate) {
					const date = new Date(info.lastChangedDate);
					const item = infoList.createEl('li', { cls: 'svn-info-item' });
					item.createEl('strong', { text: 'Last Changed: ' });
					item.createSpan({ text: date.toLocaleString() });
				}
				
				if (info.url) {
					const item = infoList.createEl('li', { cls: 'svn-info-item' });
					item.createEl('strong', { text: 'URL: ' });
					item.createSpan({ text: info.url, cls: 'svn-info-url' });
				}
				
				if (info.repositoryRoot) {
					const item = infoList.createEl('li', { cls: 'svn-info-item' });
					item.createEl('strong', { text: 'Repository Root: ' });
					item.createSpan({ text: info.repositoryRoot, cls: 'svn-info-url' });
				}
				
				if (info.repositoryUuid) {
					const item = infoList.createEl('li', { cls: 'svn-info-item' });
					item.createEl('strong', { text: 'Repository UUID: ' });
					item.createSpan({ text: info.repositoryUuid, cls: 'svn-info-prop' });
				}
				
			} else {
				this.panelElement.createEl('p', { 
					text: 'Unable to retrieve SVN information',
					cls: 'svn-info-error'
				});
			}
			
			// Add generic file information below SVN info
			await this.renderFileInfo(currentFile);
			
		} catch (error) {
			error(this, 'Error getting SVN info:', error);
			this.panelElement.createEl('p', { 
				text: `Error: ${error.message}`,
				cls: 'svn-info-error'
			});
			
			// Still show file info even if SVN info fails
			await this.renderFileInfo(currentFile);
		}
	}

	/**
	 * Render generic file information
	 */
	private async renderFileInfo(file: TFile): Promise<void> {
		if (!this.panelElement) return;

		// Add divider
		this.panelElement.createEl('hr', { cls: 'svn-info-divider' });
		
		// File info section header
		this.panelElement.createEl('h4', { 
			text: 'File Information',
			cls: 'svn-info-section-header'
		});

		const fileInfoList = this.panelElement.createEl('ul', { cls: 'svn-info-list' });

		// File name
		const nameItem = fileInfoList.createEl('li', { cls: 'svn-info-item' });
		nameItem.createEl('strong', { text: 'Name: ' });
		nameItem.createSpan({ text: file.name });
		// File path (absolute)
		const pathItem = fileInfoList.createEl('li', { cls: 'svn-info-item' });
		pathItem.createEl('strong', { text: 'Path: ' });
		const vaultPath = this.svnClient.getVaultPath();
		const absolutePath = vaultPath ? join(vaultPath, file.path) : file.path;
		pathItem.createSpan({ text: absolutePath, cls: 'svn-info-path' });

		// File extension
		if (file.extension) {
			const extItem = fileInfoList.createEl('li', { cls: 'svn-info-item' });
			extItem.createEl('strong', { text: 'Type: ' });
			extItem.createSpan({ text: file.extension.toUpperCase() + ' file' });
		}

		// File stats
		try {
			const stat = await this.plugin.app.vault.adapter.stat(file.path);
			if (stat) {
				// File size
				const sizeItem = fileInfoList.createEl('li', { cls: 'svn-info-item' });
				sizeItem.createEl('strong', { text: 'Size: ' });
				sizeItem.createSpan({ text: this.formatFileSize(stat.size) });

				// Creation time
				if (stat.ctime) {
					const ctimeItem = fileInfoList.createEl('li', { cls: 'svn-info-item' });
					ctimeItem.createEl('strong', { text: 'Created: ' });
					ctimeItem.createSpan({ text: new Date(stat.ctime).toLocaleString() });
				}

				// Modified time
				if (stat.mtime) {
					const mtimeItem = fileInfoList.createEl('li', { cls: 'svn-info-item' });
					mtimeItem.createEl('strong', { text: 'Modified: ' });
					mtimeItem.createSpan({ text: new Date(stat.mtime).toLocaleString() });
				}
			}
		} catch (error) {
			// If we can't get file stats, just add basic info
			error(this, 'Error getting file stats:', error);
		}

		// Vault-specific info
		const basename = file.basename;
		if (basename !== file.name.replace('.' + file.extension, '')) {
			const basenameItem = fileInfoList.createEl('li', { cls: 'svn-info-item' });
			basenameItem.createEl('strong', { text: 'Basename: ' });
			basenameItem.createSpan({ text: basename });
		}
	}

	/**
	 * Format file size in human readable format
	 */
	private formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 Bytes';
		
		const k = 1024;
		const sizes = ['Bytes', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	}
}






