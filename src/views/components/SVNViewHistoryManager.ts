import { TFile, setTooltip } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SVNFileData } from '../../services/SVNDataStore';
import { SvnStatusCode } from '@/types';
import { UIState } from '../SVNUIController';
import { SVNHistoryRenderer, SVNFileStateRenderer, SVNRepositoryHandler } from '.';
import type ObsidianSvnPlugin from '../../main';
import { debug, info, error, registerLoggerClass } from '@/utils/obsidian-logger';

/**
 * Manages history rendering and content display for the FileHistoryView
 * Extracted from FileHistoryView to reduce complexity
 */
export class SVNViewHistoryManager {
	private svnClient: SVNClient;
	private plugin: ObsidianSvnPlugin;
	private historyRenderer: SVNHistoryRenderer;
	private fileStateRenderer: SVNFileStateRenderer;
	private repositoryHandler: SVNRepositoryHandler;

	constructor(
		svnClient: SVNClient, 
		plugin: ObsidianSvnPlugin,
		historyRenderer: SVNHistoryRenderer,
		fileStateRenderer: SVNFileStateRenderer,
		repositoryHandler: SVNRepositoryHandler
	) {
		this.svnClient = svnClient;
		this.plugin = plugin;
		this.historyRenderer = historyRenderer;
		this.fileStateRenderer = fileStateRenderer;
		this.repositoryHandler = repositoryHandler;
	}

	/**
	 * Render history content with state
	 */
	renderHistoryContentWithState(container: HTMLElement, state: UIState, currentFile: TFile | null): void {
		if (state.showLoading) {
			container.createEl('p', { 
				text: 'Loading SVN data...', 
				cls: 'svn-loading' 
			});
			return;
		}

		if (state.error) {
			container.createEl('p', { 
				text: `Error: ${state.error}`,
				cls: 'mod-warning'
			});
			return;
		}

		// If there's no current file selected in the Obsidian view itself
		if (!currentFile) {
			container.createEl('p', { 
				text: 'No file selected or file is not active.', // More descriptive
				cls: 'svn-no-file' // Existing class
			});
			return;
		}
        
        // If a file is selected, but we don't have its SVN data yet (and not in loading/error state)
		if (!state.data) { 
			// This state implies currentFile is set, but SVNDataStore hasn't returned data yet,
			// and it's not an error, and not explicitly loading.
			// This can happen if SVNUIController initializes with currentFile but data is pending,
			// and the initial render happens before showLoading is true or data arrives.
			container.createEl('p', { 
				text: 'Waiting for file data...', 
				cls: 'svn-waiting-for-data' // New class for specific state
			});
			return;
		}

		const data = state.data;
		// Handle different file states based on loaded data
		if (!data.isWorkingCopy) {
			this.repositoryHandler.renderRepositorySetup(container, currentFile);
			return;
		}
		if (!data.isFileInSvn) {
			// Show interactive file state UI in content area since status area only shows status
			this.fileStateRenderer.renderNotInSvn(container, currentFile);
			return;
		}		// Check if file is added but not committed
		const isAddedNotCommitted = data.status.some((s: any) => s.status === SvnStatusCode.ADDED);
		if (isAddedNotCommitted) {
			// Show interactive file state UI in content area since status area only shows status
			this.fileStateRenderer.renderAddedButNotCommitted(container, currentFile);
			return;
		}

		// Render history if we have it
		if (data.history.length === 0) {
			container.createEl('p', { 
				text: 'No history found for this file',
				cls: 'svn-no-history'
			});
			return;
		}

		this.renderHistoryWithData(container, data, currentFile);
	}
	/**
	 * Render history data efficiently
	 */
	renderHistoryWithData(container: HTMLElement, data: SVNFileData, currentFile: TFile | null): void {
		info(this, 'renderHistoryWithData called:', {
			filePath: currentFile?.path,
			historyCount: data.history?.length || 0,
			historyRevisions: data.history?.map(h => ({ revision: h.revision, message: h.message?.substring(0, 30) })) || [],
			lastUpdateTime: data.lastUpdateTime
		});
		
		// Check if we can reuse existing history list
		let historyList = container.querySelector('.svn-history-list') as HTMLElement;
		const existingItems = historyList?.querySelectorAll('.svn-history-item') || [];
		
		// Only rebuild if history count changed significantly or container is empty
		const shouldRebuild = !historyList || 
							 existingItems.length !== data.history.length ||
							 this.historyStructureChanged(existingItems, data.history);
		
		if (shouldRebuild) {
			container.empty();
			historyList = container.createEl('ul', { cls: 'svn-history-list' });
			
			// Build all history items
			data.history.forEach((entry, index) => {
				this.createHistoryItem(historyList, entry, index, data.history, currentFile);
			});
		} else {
			// Reuse existing structure, just update action buttons efficiently
			data.history.forEach((entry, index) => {
				const historyItem = existingItems[index] as HTMLElement;
				if (historyItem) {
					this.updateHistoryItemActions(historyItem, entry, index, data.history, currentFile);
				}
			});
		}
	}

	/**
	 * Check if the history structure has changed (different revisions)
	 */
	private historyStructureChanged(existingItems: NodeListOf<Element>, newHistory: any[]): boolean {
		if (existingItems.length !== newHistory.length) return true;
		
		for (let i = 0; i < Math.min(existingItems.length, newHistory.length); i++) {
			const existingRevision = existingItems[i].querySelector('.svn-revision')?.textContent;
			const newRevision = `r${newHistory[i].revision}`;
			if (existingRevision !== newRevision) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Update just the action buttons of an existing history item
	 */
	private updateHistoryItemActions(historyItem: HTMLElement, entry: any, index: number, fullHistory: any[], currentFile: TFile | null): void {
		const actionsEl = historyItem.querySelector('.svn-history-actions') as HTMLElement;
		if (actionsEl && currentFile) {
			// Only update if actions container exists and we have the file
			actionsEl.empty();
			this.historyRenderer.addHistoryItemActions(actionsEl, currentFile.path, entry, index, fullHistory);
		}
	}

	/**
	 * Create a single history item
	 */
	private createHistoryItem(historyList: HTMLElement, entry: any, index: number, fullHistory: any[], currentFile: TFile | null): void {
		const listItem = historyList.createEl('li', { cls: 'svn-history-item' });
		
		// Create main content container
		const contentEl = listItem.createEl('div', { cls: 'svn-history-list-info-container' });
		// Create header with revision info
		const headerEl = contentEl.createEl('div', { cls: 'svn-history-header' });
		const revisionEl = headerEl.createEl('span', { 
			text: `r${entry.revision}`,
			cls: 'svn-revision'
		});
		setTooltip(revisionEl, `Revision ${entry.revision}`);
		
		const authorEl = headerEl.createEl('span', { 
			text: entry.author,
			cls: 'svn-author'
		});
		setTooltip(authorEl, `Author: ${entry.author}`);
		
		const dateEl = headerEl.createEl('span', { 
			text: new Date(entry.date).toLocaleString(),
			cls: 'svn-date'
		});
		setTooltip(dateEl, `Committed on: ${new Date(entry.date).toLocaleString()}`);		// Add file size information if available
		if (entry.size !== undefined) {
			const sizeEl = headerEl.createEl('span', { 
				text: this.formatFileSize(entry.size),
				cls: 'svn-size'
			});
			setTooltip(sizeEl, `File size: ${this.formatFileSize(entry.size)}`);
		}
		// Add repository storage size if available
		if (entry.repoSize !== undefined) {
			const repoSizeEl = headerEl.createEl('span', { 
				cls: 'svn-repo-size'
			});
			setTooltip(repoSizeEl, `Repository storage: ${this.formatFileSize(entry.repoSize)}`);
			repoSizeEl.createEl('span', { 
				text: 'Δ',
				cls: 'svn-delta-symbol'
			});
			repoSizeEl.createEl('span', { 
				text: `${this.formatFileSize(entry.repoSize)}`
			});
		}
		// Add commit message
		if (entry.message) {
			const messageEl = contentEl.createEl('span', { cls: 'svn-message' });
			messageEl.setText(entry.message);
			setTooltip(messageEl, 'Commit message');
		}
		// Make the entire item clickable to checkout this revision
		if (currentFile) {
			listItem.addClass('clickable-history-item');
			listItem.addEventListener('click', async (evt) => {
				// Don't trigger checkout if clicking on action buttons
				if ((evt.target as HTMLElement).closest('.svn-history-actions')) {
					return;
				}
				
				evt.preventDefault();
				evt.stopPropagation();
				
				try {
					await this.historyRenderer.checkoutRevision(currentFile.path, entry.revision);
				} catch (error) {
					console.error('Error checking out revision:', error);
				}
			});
			
			// Add action buttons (diff only, no checkout)
			const actionsEl = listItem.createEl('div', { cls: 'svn-history-actions' });
			this.historyRenderer.addHistoryItemActions(actionsEl, currentFile.path, entry, index, fullHistory);
		}
	}

	/**
	 * Format file size in human-readable format
	 */
	private formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
	}
}





