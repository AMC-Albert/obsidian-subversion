import { TFile, Notice, ItemView } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';
import { CommitModal, ConfirmRevertModal, ConfirmRemoveModal, DiffModal, BlameModal } from '../../modals';
import { SVNInfoPanel } from './SVNInfoPanel';

export class SVNFileActions {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private infoPanel: HTMLElement | null = null;
	private infoPanelComponent: SVNInfoPanel | null = null;
	private onRefresh: () => void;

	constructor(plugin: ObsidianSvnPlugin, svnClient: SVNClient, onRefresh: () => void) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		this.onRefresh = onRefresh;
	}

	setInfoPanel(infoPanel: HTMLElement | null, infoPanelComponent?: SVNInfoPanel): void {
		this.infoPanel = infoPanel;
		this.infoPanelComponent = infoPanelComponent || null;
	}

	async quickCommit(currentFile: TFile | null): Promise<void> {
		if (!currentFile) {
			new Notice('No file selected.');
			return;
		}

		const modal = new CommitModal(
			this.plugin.app,
			'Quick Commit',
			`Update ${currentFile.name}`,
			async (message: string) => {                try {
					await this.svnClient.commitFile(currentFile!.path, message);
					new Notice(`File ${currentFile!.name} committed successfully.`);
					// Refresh the view immediately - debouncing is handled in FileHistoryView
					this.onRefresh();
				} catch (error) {
					console.error('Failed to commit file:', error);
					new Notice(`Failed to commit: ${error.message}`);
				}
			}
		);
		modal.open();
	}

	async showCurrentDiff(currentFile: TFile | null): Promise<void> {
		if (!currentFile) {
			new Notice('No file selected.');
			return;
		}

		try {
			const diff = await this.svnClient.getDiff(currentFile.path);
			const modal = new DiffModal(this.plugin.app, currentFile.name, diff);
			modal.open();
		} catch (error) {
			console.error('Failed to get diff:', error);
			new Notice(`Failed to get diff: ${error.message}`);
		}
	}

	async revertFile(currentFile: TFile | null): Promise<void> {
		if (!currentFile) {
			new Notice('No file selected.');
			return;
		}

		const revertAction = async () => {
			try {
				await this.svnClient.revertFile(currentFile!.path);
				
				// Reload the file content in the editor
				const content = await this.plugin.app.vault.adapter.read(currentFile!.path);
				const activeView = this.plugin.app.workspace.getActiveViewOfType(ItemView);
				if (activeView && 'editor' in activeView) {
					(activeView as any).editor.setValue(content);
				}
				  new Notice(`File ${currentFile!.name} reverted to last committed version.`);
				
				// Refresh the view immediately - debouncing is handled in FileHistoryView
				this.onRefresh();
				
			} catch (error) {
				console.error('Failed to revert file:', error);
				new Notice(`Failed to revert: ${error.message}`);
			}
		};

		// For markdown files, skip the modal since changes can be undone in Obsidian
		if (currentFile.extension === 'md') {
			await revertAction();
		} else {
			// For non-markdown files, show confirmation modal since changes can't be undone
			const modal = new ConfirmRevertModal(
				this.plugin.app,
				currentFile.name,
				revertAction
			);
			modal.open();
		}
	}

	async removeFromSvn(currentFile: TFile | null): Promise<void> {
		if (!currentFile || !this.isSvnClientReady()) return;

		const modal = new ConfirmRemoveModal(this.plugin.app, currentFile.name, async () => {
			try {
				await this.svnClient.removeFile(currentFile!.path);
				new Notice(`File removed from SVN: ${currentFile!.name}`);
				
				// Refresh the view to update status
				this.onRefresh();
			} catch (error: any) {
				console.error('Error removing file from SVN:', error);
				new Notice(`Error: ${error.message || 'Failed to remove file from SVN.'}`);
			}
		});
		
		modal.open();
	}

	async showBlame(currentFile: TFile | null): Promise<void> {
		if (!currentFile || !this.isSvnClientReady()) return;

		try {
			// Check if file is in SVN
			const isWorkingCopy = await this.svnClient.isWorkingCopy(currentFile.path);
			if (!isWorkingCopy) {
				new Notice('File is not in an SVN working copy.');
				return;
			}

			const isFileInSvn = await this.svnClient.isFileInSvn(currentFile.path);
			if (!isFileInSvn) {
				new Notice('File is not tracked in SVN.');
				return;
			}

			// Get blame data
			const blameData = await this.svnClient.getBlame(currentFile.path);
			
			// Get current file content
			const fileContent = await this.plugin.app.vault.read(currentFile);
			const fileLines = fileContent.split('\n');

			// Open blame modal
			const modal = new BlameModal(this.plugin.app, this.plugin, currentFile, blameData, fileLines);
			modal.open();

		} catch (error: any) {
			console.error('Error getting blame data:', error);
			new Notice(`Error: ${error.message || 'Failed to get blame data.'}`);
		}
	}

	async toggleInfoDisplay(): Promise<void> {
		if (!this.infoPanel || !this.infoPanelComponent) return;
		
		const currentFile = this.plugin.app.workspace.getActiveFile();
		
		// Toggle visibility
		if (this.infoPanel.style.display === 'none' || !this.infoPanel.style.display) {
			// Show the panel
			this.infoPanelComponent.show();
			await this.infoPanelComponent.render(currentFile);
		} else {
			// Hide the panel
			this.infoPanelComponent.hide();
		}
	}

	private async loadInfoContent(infoPanel: HTMLElement): Promise<void> {
		const currentFile = this.plugin.app.workspace.getActiveFile();
		if (!currentFile) return;

		infoPanel.empty();
		infoPanel.createEl('div', { text: 'Loading file info...', cls: 'svn-loading-small' });

		try {
			const info = await this.svnClient.getInfo(currentFile.path);
			infoPanel.empty();
			
			if (!info) {
				infoPanel.createEl('div', { text: 'No SVN info available', cls: 'svn-info-item' });
				return;
			}

			// Create info items
			if (info.lastChangedAuthor) {
				infoPanel.createEl('div', { 
					text: `Last changed by: ${info.lastChangedAuthor}`,
					cls: 'svn-info-item'
				});
			}
			
			if (info.lastChangedRev) {
				infoPanel.createEl('div', { 
					text: `Last changed rev: ${info.lastChangedRev}`,
					cls: 'svn-info-item'
				});
			}
			
			if (info.lastChangedDate) {
				const date = new Date(info.lastChangedDate);
				infoPanel.createEl('div', { 
					text: `Last changed: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
					cls: 'svn-info-item'
				});
			}
			
			if (info.url) {
				infoPanel.createEl('div', { 
					text: `URL: ${info.url}`,
					cls: 'svn-info-item svn-info-url'
				});
			}

			// Get and display properties
			try {
				const properties = await this.svnClient.getProperties(currentFile.path);
				if (Object.keys(properties).length > 0) {
					const propHeader = infoPanel.createEl('div', { 
						text: 'Properties:',
						cls: 'svn-info-item svn-info-header'
					});
					propHeader.style.marginTop = 'var(--size-4-2)';
					propHeader.style.fontWeight = 'var(--font-weight-medium)';
					
					for (const [key, value] of Object.entries(properties)) {
						infoPanel.createEl('div', { 
							text: `  ${key}: ${value}`,
							cls: 'svn-info-item svn-info-prop'
						});
					}
				}
			} catch (propError) {
				// Properties are optional, don't show error for this
			}

		} catch (error: any) {
			infoPanel.empty();
			infoPanel.createEl('div', { 
				text: `Error: ${error.message || 'Failed to get file info'}`,
				cls: 'svn-info-item svn-error'
			});
		}
	}

	private isSvnClientReady(): boolean {
		return this.svnClient && 
			   this.plugin.svnClient && 
			   this.svnClient === this.plugin.svnClient &&
			   // Check if vault path is set (simple way to verify client is configured)
			   typeof this.svnClient.setVaultPath === 'function';
	}
}
