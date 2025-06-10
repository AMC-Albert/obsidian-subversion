import { TFile, setTooltip } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SvnFileData } from '@/types';
import { UIState } from '../SVNUIController';
import { SVNHistoryRenderer, SVNFileStateRenderer, SVNRepositoryHandler } from '.';
import type ObsidianSvnPlugin from '../../main';
import { loggerDebug, loggerInfo, loggerError, registerLoggerClass } from '@/utils/obsidian-logger';

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
		registerLoggerClass(this, 'SVNViewHistoryManager');
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
		loggerDebug(this, 'SVNViewHistoryManager.updateContentAreaDOM called', { 
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
					loggerError(this, "Cannot render 'not-tracked-file': currentFile is null");
					if (lastContentType !== 'error') container.empty();
					container.createEl('p', { text: 'Error: File context lost.', cls: 'mod-warning svn-error-message' });
					return;
				}
				this.fileStateRenderer.renderNotInSvn(container, currentFile);
				break;
			case 'added-not-committed':
				// SVNFileStateRenderer.renderAddedButNotCommitted calls container.empty()
				if (!currentFile) {
					loggerError(this, "Cannot render 'added-not-committed': currentFile is null");
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
					loggerError(this, "Cannot render history: data or currentFile is null for 'history' contentType", {hasData: !!state.data, hasFile: !!currentFile});
					if (lastContentType !== 'error' || !container.querySelector('.mod-warning.svn-error-message')) {
						container.empty();
						container.createEl('p', { text: 'Error: Cannot display history due to missing data.', cls: 'mod-warning svn-error-message' });
					}
				}
				break;
			default:
				loggerError(this, 'Unknown content type in SVNViewHistoryManager.updateContentAreaDOM:', newContentType);
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
		loggerDebug(this, "OLD renderHistoryContentWithState was called. This should be updated.");
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
		data: SvnFileData, 
		currentFile: TFile | null, // Though currentFile should always be non-null if we reach here with 'history' type
		lastContentType: string | null,
		historyContentActuallyChanged: boolean 
	): void {
		loggerDebug(this, 'renderHistoryWithData called:', {
			filePath: currentFile?.path,
			historyCount: data.history?.length || 0,
			lastContentType,
			historyContentActuallyChanged,
			pinCheckedOutRevision: this.plugin.settings.pinCheckedOutRevision
		});
		
		const shouldShowPinnedRevision = this.plugin.settings.pinCheckedOutRevision;
		
		// Determine if a full rebuild is necessary
		const needsFullRebuild = lastContentType !== 'history' || historyContentActuallyChanged;
		
		if (needsFullRebuild) {
			loggerDebug(this, 'Rebuilding history list because:', { 
				lastContentTypeSVC: lastContentType, // SVC for "Subversion" to avoid conflict
				historyContentActuallyChangedSVC: historyContentActuallyChanged // SVC for "Subversion"
			});
			container.empty(); // Clear the container specifically for the history list
			
			// Check if we need to show pinned revision
			let pinnedRevision: any = null;
			let remainingHistory = data.history;
			
			if (shouldShowPinnedRevision && data.svnInfo) {
				// Find the currently checked out revision
				const currentRevision = data.svnInfo.revision;
				pinnedRevision = data.history.find(entry => entry.revision === currentRevision);
				
				if (pinnedRevision) {
					// Remove the pinned revision from the main list
					remainingHistory = data.history.filter(entry => entry.revision !== currentRevision);
				}
			}
			
			// Render pinned revision container if needed
			if (shouldShowPinnedRevision) {
				if (pinnedRevision) {
					this.renderPinnedRevisionContainer(container, pinnedRevision, data.history, currentFile);
				} else {
					this.renderEmptyPinnedContainer(container);
				}
			}
			
			// Create main history list
			const historyList = container.createEl('ul', { cls: 'svn-history-list' });
			remainingHistory.forEach((entry: any, index: number) => {
				this.createHistoryItem(historyList, entry, index, data.history, currentFile, data.svnInfo?.revision);
			});
		} else {
			// If not rebuilding, we assume the list structure is intact.
			// We might still need to update individual items if their content can change
			// without triggering historyContentActuallyChanged (e.g., relative dates, though not used here).
			// For now, just update action buttons as per existing logic.
			loggerDebug(this, 'Updating existing history items (actions only).');
			const historyList = container.querySelector('.svn-history-list') as HTMLElement;
			if (historyList) {
				const existingItems = historyList.querySelectorAll('.svn-history-item');
				data.history.forEach((entry: any, index: number) => {
					const historyItem = existingItems[index] as HTMLElement;
					if (historyItem) {
						this.updateHistoryItemActions(historyItem, entry, index, data.history, currentFile);
					}
				});
			}
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
	 */	private updateHistoryItemActions(historyItem: HTMLElement, entry: any, index: number, fullHistory: any[], currentFile: TFile | null, currentRevision?: number): void {
		const existingActionsEl = historyItem.querySelector('.svn-history-actions') as HTMLElement;
		const previewEl = historyItem.querySelector('.svn-history-preview-container') as HTMLElement;
		const contentEl = historyItem.querySelector('.svn-history-list-info-container') as HTMLElement;
		
		if (currentFile && contentEl) {
			// Create a temporary actions container to test if buttons will be added
			const tempActionsEl = contentEl.createEl('div', { cls: 'svn-history-actions' });
			const hasButtons = this.historyRenderer.addHistoryItemActions(tempActionsEl, currentFile.path, entry, index, fullHistory, previewEl, currentRevision);
			
			if (hasButtons) {
				// Remove existing actions container if it exists
				if (existingActionsEl) {
					existingActionsEl.remove();
				}
				// Keep the new container with buttons
			} else {
				// Remove both the temporary and existing containers
				tempActionsEl.remove();
				if (existingActionsEl) {
					existingActionsEl.remove();
				}
			}
		}
	}

	/**
	 * Create a single history item
	 */
	private createHistoryItem(historyList: HTMLElement, entry: any, index: number, fullHistory: any[], currentFile: TFile | null, currentRevision?: number): void {
		const listItem = historyList.createEl('li', { cls: 'svn-history-item' });
		
		// Create preview container on the left (if preview exists)
		let previewEl: HTMLElement | null = null;
		if (entry.previewImagePath && currentFile) {
			previewEl = listItem.createEl('div', { cls: 'svn-history-preview-container' });
		}
		
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
		setTooltip(dateEl, `Committed on: ${new Date(entry.date).toLocaleString()}`);
		
		// Add combined storage size information (prioritize repository storage)
		if (entry.repoSize !== undefined || entry.size !== undefined) {
			const storageEl = headerEl.createEl('span', { 
				cls: 'svn-size' // Use the original svn-size styling
			});
			
			// Display repository storage by default, fall back to file size
			const displaySize = entry.repoSize ?? entry.size;
			const displayText = entry.repoSize !== undefined ? this.formatFileSize(entry.repoSize) : this.formatFileSize(entry.size!);
			
			storageEl.setText(displayText);
			
			// Create comprehensive tooltip
			let tooltipText = '';
			if (entry.repoSize !== undefined && entry.size !== undefined) {
				tooltipText = `Repository storage: ${this.formatFileSize(entry.repoSize)}\nFile size: ${this.formatFileSize(entry.size)}`;
			} else if (entry.repoSize !== undefined) {
				tooltipText = `Repository storage: ${this.formatFileSize(entry.repoSize)}`;
			} else {
				tooltipText = `File size: ${this.formatFileSize(entry.size!)}`;
			}
			
			setTooltip(storageEl, tooltipText);
		}
		// Add commit message
		if (entry.message) {
			const messageEl = contentEl.createEl('span', { cls: 'svn-message' });
			messageEl.setText(entry.message);
			setTooltip(messageEl, 'Commit message');
		}

		if (currentFile) {
			// Add action buttons (diff only, no checkout) - only create container if buttons will be added
			const tempActionsEl = contentEl.createEl('div', { cls: 'svn-history-actions' });
			const hasButtons = this.historyRenderer.addHistoryItemActions(tempActionsEl, currentFile.path, entry, index, fullHistory, previewEl, currentRevision);
			
			// Remove the container if no buttons were added
			if (!hasButtons) {
				tempActionsEl.remove();
			}
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

	/**
	 * Render the pinned revision container with the current checkout
	 */
	private renderPinnedRevisionContainer(container: HTMLElement, pinnedRevision: any, fullHistory: any[], currentFile: TFile | null): void {
		loggerDebug(this, 'Rendering pinned revision container', { revision: pinnedRevision.revision });
		
		// Create pinned container
		const pinnedContainer = container.createEl('div', { cls: 'svn-pinned-revision-container' });
		
		// Add header
		const headerEl = pinnedContainer.createEl('div', { cls: 'svn-pinned-header' });
		headerEl.createEl('span', { 
			text: 'Currently Checked Out',
			cls: 'svn-pinned-title'
		});

		// Create pinned item (similar to regular history item but with different styling)
		const pinnedItem = pinnedContainer.createEl('div', { cls: 'svn-pinned-item' });
		
		// Create preview container on the left (if preview exists)
		let previewEl: HTMLElement | null = null;
		if (pinnedRevision.previewImagePath && currentFile) {
			previewEl = pinnedItem.createEl('div', { cls: 'svn-history-preview-container' });
		}
		
		// Create main content container
		const contentEl = pinnedItem.createEl('div', { cls: 'svn-history-list-info-container' });
		
		// Create header with revision info
		const revisionHeaderEl = contentEl.createEl('div', { cls: 'svn-history-header' });
		const revisionEl = revisionHeaderEl.createEl('span', { 
			text: `r${pinnedRevision.revision}`,
			cls: 'svn-revision svn-pinned-revision'
		});
		setTooltip(revisionEl, `Currently checked out revision ${pinnedRevision.revision}`);
		
		const authorEl = revisionHeaderEl.createEl('span', { 
			text: pinnedRevision.author,
			cls: 'svn-author'
		});
		setTooltip(authorEl, `Author: ${pinnedRevision.author}`);
		
		const dateEl = revisionHeaderEl.createEl('span', { 
			text: new Date(pinnedRevision.date).toLocaleString(),
			cls: 'svn-date'
		});
		setTooltip(dateEl, `Committed on: ${new Date(pinnedRevision.date).toLocaleString()}`);
		
		// Add combined storage size information
		if (pinnedRevision.repoSize !== undefined || pinnedRevision.size !== undefined) {
			const storageEl = revisionHeaderEl.createEl('span', { 
				cls: 'svn-size'
			});
			
			const displaySize = pinnedRevision.repoSize ?? pinnedRevision.size;
			const displayText = pinnedRevision.repoSize !== undefined ? this.formatFileSize(pinnedRevision.repoSize) : this.formatFileSize(pinnedRevision.size!);
			
			storageEl.setText(displayText);
			
			let tooltipText = '';
			if (pinnedRevision.repoSize !== undefined && pinnedRevision.size !== undefined) {
				tooltipText = `Repository storage: ${this.formatFileSize(pinnedRevision.repoSize)}\nFile size: ${this.formatFileSize(pinnedRevision.size)}`;
			} else if (pinnedRevision.repoSize !== undefined) {
				tooltipText = `Repository storage: ${this.formatFileSize(pinnedRevision.repoSize)}`;
			} else {
				tooltipText = `File size: ${this.formatFileSize(pinnedRevision.size!)}`;
			}
			
			setTooltip(storageEl, tooltipText);
		}
		
		// Add commit message
		if (pinnedRevision.message) {
			const messageEl = contentEl.createEl('span', { cls: 'svn-message' });
			messageEl.setText(pinnedRevision.message);
			setTooltip(messageEl, 'Commit message');
		}
		// Add action buttons for pinned item - only create container if buttons will be added
		if (currentFile) {
			const tempActionsEl = contentEl.createEl('div', { cls: 'svn-history-actions' });
			const pinnedIndex = fullHistory.findIndex(entry => entry.revision === pinnedRevision.revision);
			const hasButtons = this.historyRenderer.addHistoryItemActions(tempActionsEl, currentFile.path, pinnedRevision, pinnedIndex, fullHistory, previewEl);
			
			// Remove the container if no buttons were added
			if (!hasButtons) {
				tempActionsEl.remove();
			}
		}
	}

	/**
	 * Render an empty pinned container when no revision is checked out
	 */
	private renderEmptyPinnedContainer(container: HTMLElement): void {
		loggerDebug(this, 'Rendering empty pinned revision container');
		
		// Create empty pinned container
		const pinnedContainer = container.createEl('div', { cls: 'svn-pinned-revision-container svn-pinned-empty' });
		
		// Add header
		const headerEl = pinnedContainer.createEl('div', { cls: 'svn-pinned-header' });
		headerEl.createEl('span', { 
			text: 'Currently Checked Out',
			cls: 'svn-pinned-title'
		});
		
		// Add empty state message
		const emptyEl = pinnedContainer.createEl('div', { cls: 'svn-pinned-empty-message' });
		emptyEl.createEl('span', { 
			text: 'No specific revision checked out',
			cls: 'svn-empty-text'
		});
	}
}





