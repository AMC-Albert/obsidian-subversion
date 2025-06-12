import { TFile, Notice, ItemView } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';
import { CommitModal, ConfirmRevertModal, ConfirmRemoveModal, DiffModal } from '../../modals';
import { SVNInfoPanel } from './SVNInfoPanel';
import { SVNToolbar } from './SVNToolbar';
import { loggerError } from '@/utils/obsidian-logger';

export class SVNFileActions {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private infoPanel: HTMLElement | null = null;
	private infoPanelComponent: SVNInfoPanel | null = null;
	private onInfoToggle: ((isActive: boolean) => void) | null = null;
	private onRefresh: () => void;
	private toolbar: SVNToolbar | null = null;

	constructor(plugin: ObsidianSvnPlugin, svnClient: SVNClient, onRefresh: () => void) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		this.onRefresh = onRefresh;
	}
	setInfoPanel(infoPanel: HTMLElement | null, infoPanelComponent?: SVNInfoPanel): void {
		this.infoPanel = infoPanel;
		this.infoPanelComponent = infoPanelComponent || null;
	}	setInfoToggleCallback(callback: (isActive: boolean) => void): void {
		this.onInfoToggle = callback;
	}

	setToolbar(toolbar: SVNToolbar): void {
		this.toolbar = toolbar;
	}

	/**
	 * Update button states after a file operation
	 */
	private async updateButtonStates(currentFile: TFile | null): Promise<void> {
		if (this.toolbar) {
			await this.toolbar.updateButtonStates(currentFile);
		}
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
			async (message: string) => {
				try {
					await this.svnClient.commit([currentFile.path], message, { addParents: true });
					new Notice(`File ${currentFile.name} committed successfully.`);
					// Refresh the view immediately - debouncing is handled in FileHistoryView
					this.onRefresh();
					// Update button states after commit
					await this.updateButtonStates(currentFile);
				} catch (error) {
					loggerError(this, 'Failed to commit file:', error);
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
			loggerError(this, 'Failed to get diff:', error);
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
				await this.svnClient.revert([currentFile!.path]);
				
				// Reload the file content in the editor
				const content = await this.plugin.app.vault.adapter.read(currentFile!.path);
				const activeView = this.plugin.app.workspace.getActiveViewOfType(ItemView);
				if (activeView && 'editor' in activeView) {
					(activeView as any).editor.setValue(content);
				}				  new Notice(`File ${currentFile!.name} reverted to last committed version.`);
				
				// Refresh the view immediately - debouncing is handled in FileHistoryView
				this.onRefresh();
				// Update button states after revert
				await this.updateButtonStates(currentFile);
						} catch (error) {
				loggerError(this, 'Failed to revert file:', error);
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
				await this.svnClient.remove([currentFile!.path], { keepLocal: false });
				new Notice(`File removed from SVN: ${currentFile!.name}`);
				
				// Refresh the view to update status
				this.onRefresh();
				// Update button states since file is no longer tracked
				await this.updateButtonStates(currentFile);
			} catch (error: any) {
				loggerError(this, 'Error removing file from SVN:', error);
				new Notice(`Error: ${error.message || 'Failed to remove file from SVN.'}`);
			}
		});
		
		modal.open();
	}	async toggleInfoDisplay(): Promise<void> {
		if (!this.infoPanel || !this.infoPanelComponent) return;
		
		const currentFile = this.plugin.app.workspace.getActiveFile();
		
		// Toggle visibility
		if (this.infoPanel.style.display === 'none' || !this.infoPanel.style.display) {
			// Show the panel
			this.infoPanelComponent.show();
			await this.infoPanelComponent.render(currentFile);
			// Update toolbar button to active state
			if (this.onInfoToggle) {
				this.onInfoToggle(true);
			}
		} else {
			// Hide the panel
			this.infoPanelComponent.hide();
			// Update toolbar button to inactive state
			if (this.onInfoToggle) {
				this.onInfoToggle(false);
			}
		}
	}

	/**
	 * Check if the info panel is currently visible
	 */
	isInfoPanelVisible(): boolean {
		return this.infoPanel ? 
			(this.infoPanel.style.display !== 'none' && this.infoPanel.style.display !== '') : 
			false;
	}

	/**
	 * Hide the info panel and update button state
	 */
	hideInfoPanel(): void {
		if (this.infoPanelComponent) {
			this.infoPanelComponent.hide();
			// Update toolbar button to inactive state
			if (this.onInfoToggle) {
				this.onInfoToggle(false);
			}
		}
	}

	async addFile(currentFile: TFile | null): Promise<void> {
		if (!currentFile) {
			new Notice('No file selected.');
			return;
		}
		try {
			await this.svnClient.add(currentFile.path, { addParents: true });
			new Notice(`File ${currentFile.name} added to version control.`);
			this.onRefresh();
			// Update button states since file is now tracked
			await this.updateButtonStates(currentFile);
		} catch (error: any) {
			loggerError(this, 'Failed to add file:', error);
			new Notice(`Failed to add file: ${error.message}`);
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
		return !!this.svnClient;
	}
}






