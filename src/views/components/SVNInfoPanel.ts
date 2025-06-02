import { TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';

export class SVNInfoPanel {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private panelElement: HTMLElement | null = null;

	constructor(plugin: ObsidianSvnPlugin, svnClient: SVNClient) {
		this.plugin = plugin;
		this.svnClient = svnClient;
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
			}            // Get SVN info for the file
			const info = await this.svnClient.getInfo(currentFile.path);
			
			const infoContainer = this.panelElement.createEl('div', { cls: 'svn-info-container' });
			infoContainer.createEl('h3', { text: 'SVN Information' });            if (info) {
				const infoList = infoContainer.createEl('ul', { cls: 'svn-info-list' });
				
				if (info.lastChangedRev) {
					infoList.createEl('li').innerHTML = `<strong>Last Changed Rev:</strong> ${info.lastChangedRev}`;
				}
				
				if (info.lastChangedAuthor) {
					infoList.createEl('li').innerHTML = `<strong>Last Changed Author:</strong> ${info.lastChangedAuthor}`;
				}
				
				if (info.lastChangedDate) {
					const date = new Date(info.lastChangedDate);
					infoList.createEl('li').innerHTML = `<strong>Last Changed:</strong> ${date.toLocaleString()}`;
				}
				
				if (info.url) {
					infoList.createEl('li').innerHTML = `<strong>URL:</strong> ${info.url}`;
				}
				
				if (info.repositoryRoot) {
					infoList.createEl('li').innerHTML = `<strong>Repository Root:</strong> ${info.repositoryRoot}`;
				}
				
				if (info.repositoryUuid) {
					infoList.createEl('li').innerHTML = `<strong>Repository UUID:</strong> ${info.repositoryUuid}`;
				}
			} else {
				infoContainer.createEl('p', { 
					text: 'Unable to retrieve SVN information',
					cls: 'svn-info-error'
				});
			}
			
		} catch (error) {
			console.error('Error getting SVN info:', error);
			this.panelElement.createEl('p', { 
				text: `Error: ${error.message}`,
				cls: 'svn-info-error'
			});
		}
	}
}
