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
	 * Main method to update the content area DOM based on new and old states.
	 * Decides whether to clear the container or let sub-renderers handle it.
	 */
	public updateContentAreaDOM(
		container: HTMLElement,
		state: UIState,
		currentFile: TFile | null,
		newContentType: string,
		lastContentType: string | null,
		historyActuallyChanged: boolean
	): void {
		info(this, 'SVNViewHistoryManager.updateContentAreaDOM called', { 
			newContentType, 
			lastContentType, 
			currentFile: currentFile?.path,
			historyActuallyChanged,
			stateIsLoading: state.isLoading,
			stateHasError: !!state.error,
			stateHasData: !!state.data
		});

		// Render based on newContentType. 
		// Sub-renderers (SVNFileStateRenderer, SVNRepositoryHandler) are responsible for their own container.empty()
		// if they perform a full takeover of the content area.
		// This manager is responsible for clearing if it's rendering a simple text message directly
		// AND the previous content type was different or the specific message element isn't already there.

		switch (newContentType) {
			case 'loading':
				if (lastContentType !== 'loading' || !container.querySelector('.svn-loading')) {
					container.empty();
					container.createEl('p', { text: 'Loading SVN data...', cls: 'svn-loading' });
				}
				break;
			case 'error':
				if (lastContentType !== 'error' || !container.querySelector('.mod-warning.svn-error-message')) { // Added svn-error-message for specificity
					container.empty();
					container.createEl('p', { text: `Error: ${state.error}`, cls: 'mod-warning svn-error-message' });
				}
				break;
			case 'no-file':
				 if (lastContentType !== 'no-file' || !container.querySelector('.svn-no-file')) {
					container.empty();
					container.createEl('p', { text: 'No file selected or file is not active.', cls: 'svn-no-file' });
				}
				break;
			case 'waiting-for-data':
				// This state implies currentFile is set, but SVNDataStore hasn't returned data yet,
				// and it's not an error, and not explicitly loading.
				if (lastContentType !== 'waiting-for-data' || !container.querySelector('.svn-waiting-for-data')) {
					container.empty();
					container.createEl('p', { text: 'Waiting for file data...', cls: 'svn-waiting-for-data' });
				}
				break;
			case 'repository-setup':
				// SVNRepositoryHandler.renderRepositorySetup calls container.empty()
				this.repositoryHandler.renderRepositorySetup(container, currentFile);
				break;
			case 'unversioned-file': 
			case 'not-tracked-file':
				// SVNFileStateRenderer.renderNotInSvn calls container.empty()
				if (!currentFile) {
					error(this, "Cannot render 'not-tracked-file': currentFile is null");
					if (lastContentType !== 'error') container.empty();
					container.createEl('p', { text: 'Error: File context lost.', cls: 'mod-warning svn-error-message' });
					return;
				}
				this.fileStateRenderer.renderNotInSvn(container, currentFile);
				break;
			case 'added-not-committed':
				// SVNFileStateRenderer.renderAddedButNotCommitted calls container.empty()
				if (!currentFile) {
					error(this, "Cannot render 'added-not-committed': currentFile is null");
					if (lastContentType !== 'error') container.empty();
					container.createEl('p', { text: 'Error: File context lost.', cls: 'mod-warning svn-error-message' });
					return;
				}
				this.fileStateRenderer.renderAddedButNotCommitted(container, currentFile);
				break;
			case 'no-history':
				// This implies state.data exists, isFileInSvn is true, and history is empty.
				if (lastContentType !== 'no-history' || !container.querySelector('.svn-no-history')) {
					container.empty();
					container.createEl('p', { text: 'No history found for this file.', cls: 'svn-no-history' });
				}
				break;
			case 'history':
				if (state.data && currentFile) {
					this.renderHistoryWithData(container, state.data, currentFile, lastContentType, historyActuallyChanged);
				} else {
					error(this, "Cannot render history: data or currentFile is null for 'history' contentType", {hasData: !!state.data, hasFile: !!currentFile});
					if (lastContentType !== 'error' || !container.querySelector('.mod-warning.svn-error-message')) {
						container.empty();
						container.createEl('p', { text: 'Error: Cannot display history due to missing data.', cls: 'mod-warning svn-error-message' });
					}
				}
				break;
			default:
				error(this, 'Unknown content type in SVNViewHistoryManager.updateContentAreaDOM:', newContentType);
				if (lastContentType !== 'error' || !container.querySelector('.mod-warning.svn-error-message')) { // Avoid multiple error messages
					container.empty();
					container.createEl('p', { text: `Unknown view state: ${newContentType}`, cls: 'mod-warning svn-error-message' });
				}
		}
	}

	/**
	 * Render history content with state (OLD METHOD - to be replaced or removed)
	 */
	/* // Commenting out the old method to ensure the new one is used.
	renderHistoryContentWithState(container: HTMLElement, state: UIState, currentFile: TFile | null): void {
		// ... old logic ...
		// This should be replaced by calls to updateContentAreaDOM
		info(this, "OLD renderHistoryContentWithState was called. This should be updated.");
		// Fallback to a simple clear and call to the new method for now
		container.empty();
		const newContentType = "unknown_fallback"; // Determine actual content type if possible
		// const newContentType = this.plugin.svnView?.uiController.stateManager.getContentType(state); // This is a circular dependency risk
		this.updateContentAreaDOM(container, state, currentFile, newContentType, null, false);
	}
	*/

	/**
	 * Render history data efficiently
	 */
	renderHistoryWithData(
		container: HTMLElement, 
		data: SVNFileData, 
		currentFile: TFile | null, // Though currentFile should always be non-null if we reach here with 'history' type
		lastContentType: string | null,
		historyContentActuallyChanged: boolean 
	): void {
		info(this, 'renderHistoryWithData called:', {
			filePath: currentFile?.path,
			historyCount: data.history?.length || 0,
			lastContentType,
			historyContentActuallyChanged
		});
		
		let historyList = container.querySelector('.svn-history-list') as HTMLElement;
		
		// Determine if a full rebuild of the history list is necessary
		const needsFullRebuild = !historyList || lastContentType !== 'history' || historyContentActuallyChanged;
		
		if (needsFullRebuild) {
			info(this, 'Rebuilding history list because:', { 
				listExists: !!historyList, 
				lastContentTypeSVC: lastContentType, // SVC for "Subversion" to avoid conflict
				historyContentActuallyChangedSVC: historyContentActuallyChanged // SVC for "Subversion"
			});
			container.empty(); // Clear the container specifically for the history list
			historyList = container.createEl('ul', { cls: 'svn-history-list' });
			
			data.history.forEach((entry, index) => {
				this.createHistoryItem(historyList, entry, index, data.history, currentFile);
			});
		} else {
			// If not rebuilding, we assume the list structure is intact.
			// We might still need to update individual items if their content can change
			// without triggering historyContentActuallyChanged (e.g., relative dates, though not used here).
			// For now, just update action buttons as per existing logic.
			info(this, 'Updating existing history items (actions only).');
			const existingItems = historyList.querySelectorAll('.svn-history-item');
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





