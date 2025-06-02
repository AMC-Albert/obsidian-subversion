import { TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SVNFileData } from '../../services/SVNDataStore';
import { UIState } from '../SVNUIController';
import { SVNStatusDisplay } from '.';
import { SVNViewStateManager } from './SVNViewStateManager';
import { SVNStatusUtils } from '../../utils/SVNStatusUtils';
import { SVNConstants } from '../../utils/SVNConstants';
import { SVNFileStateRenderer } from './SVNFileStateRenderer';

/**
 * Manages status updates and display logic for the FileHistoryView
 * Extracted from FileHistoryView to reduce complexity
 */
export class SVNViewStatusManager {
	private svnClient: SVNClient;
	private statusDisplay: SVNStatusDisplay;
	private stateManager: SVNViewStateManager;
	private fileStateRenderer: SVNFileStateRenderer;
	private isRendering: boolean = false;

	constructor(
		svnClient: SVNClient,
		statusDisplay: SVNStatusDisplay,
		stateManager: SVNViewStateManager,
		fileStateRenderer: SVNFileStateRenderer
	) {
		this.svnClient = svnClient;
		this.statusDisplay = statusDisplay;
		this.stateManager = stateManager;
		this.fileStateRenderer = fileStateRenderer;
	}
	/**
	 * Update status display section only
	 */	async updateStatusDisplay(state: UIState, statusContainer: HTMLElement | null, currentFile: TFile | null): Promise<void> {
		if (!statusContainer) return;
		
		// Prevent duplicate renders - if already rendering, skip
		if (this.isRendering) {
			console.log('[SVN ViewStatusManager] Already rendering, skipping duplicate update');
			return;
		}
		
		this.isRendering = true;
		
		try {
			// If we have fresh direct status data, override and render immediately
			const protectionWindowMs = this.stateManager.getProtectionWindowMs();
			if (this.stateManager.isWithinProtectionWindow()) {
				statusContainer.empty();
				const directData = this.stateManager.getLastDirectStatusData();
				if (directData) {
					this.renderStatusWithData(statusContainer, directData as any, currentFile);
				}
				return;
			}
			
			// Preserve existing status during loading states to avoid flicker
			if (state.showLoading && this.stateManager.getLastStatusHash() && this.stateManager.getLastStatusHash() !== 'no-data') {
				return;
			}
			
			// Calculate status hash to avoid unnecessary rebuilds
			const currentStatusHash = this.stateManager.calculateStatusHash(state, currentFile?.path);
			if (currentStatusHash === this.stateManager.getLastStatusHash()) {
				return;
			}
					statusContainer.empty();
			if (state.data && !state.showLoading) {
				// Always use renderStatusWithData when we have state data - it handles routing correctly
				this.renderStatusWithData(statusContainer, state.data, currentFile);
			} else if (currentFile && !state.showLoading) {
				// Only fall back to direct SVNStatusDisplay when we have no state data AND not loading
				console.log('[SVN ViewStatusManager] No state data available, falling back to direct SVNStatusDisplay');
				this.statusDisplay.render(statusContainer, currentFile);
			} else if (state.showLoading) {
				// During loading, show a simple loading message instead of trying to render status
				const loadingEl = statusContainer.createEl('span', { 
					text: 'Loading...', 
					cls: 'svn-status-loading' 
				});
			}
			
			// Only update the hash if we're not in a loading state
			if (!state.showLoading) {
				this.stateManager.setLastStatusHash(currentStatusHash);
			}
		} finally {
			this.isRendering = false;
		}
	}
	/**
	 * Render status display with loaded data
	 */
	private renderStatusWithData(container: HTMLElement, data: SVNFileData, currentFile: TFile | null): void {
		// SVNFileStateRenderer and SVNStatusDisplay.render will handle emptying their container.

		if (!data.isWorkingCopy) {
			container.empty(); // Ensure clean for this specific message
			const statusTextEl = container.createEl('span', { cls: 'svn-status-text' });
			this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.NOT_IN_WORKING_COPY, SVNConstants.MESSAGES.NOT_IN_WORKING_COPY, SVNConstants.CSS_CLASSES.WARNING);
			return;
		}
		if (currentFile) {
			console.log('[SVN ViewStatusManager] renderStatusWithData: Looking for file in status data:', {
				currentFilePath: currentFile.path,
				statusEntries: data.status?.map(item => ({ filePath: item.filePath, status: item.status })) || []
			});

			const fileStatusEntry = data.status?.find(item => {
				const match = this.svnClient.comparePaths(item.filePath, currentFile.path);
				console.log('[SVN ViewStatusManager] Comparing paths:', {
					svnPath: item.filePath,
					currentPath: currentFile.path,
					match: match
				});
				return match;
			});

			console.log('[SVN ViewStatusManager] File status entry found:', fileStatusEntry);			if (fileStatusEntry && fileStatusEntry.status === '?') {
				// Unversioned file: show simple status message
				console.log('[SVN ViewStatusManager] renderStatusWithData: Unversioned file status found in data, showing status message.');
				container.empty();
				const statusTextEl = container.createEl('span', { cls: 'svn-status-text' });
				this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UNVERSIONED, 'Unversioned', SVNConstants.CSS_CLASSES.UNVERSIONED);
				return;
			} else {
				// Versioned file (M, A, D, clean), or file not in status list (implies clean if other statuses exist)
				// Delegate to SVNStatusDisplay to render revision and status.
				// SVNStatusDisplay.render itself will handle emptying the container and also has a '?' check.
				console.log('[SVN ViewStatusManager] renderStatusWithData: Versioned or clean file, delegating to SVNStatusDisplay.');
				this.statusDisplay.render(container, currentFile);
				return;
			}
		} else {
			// No current file selected, but it's a working copy.
			// Show a generic status for the repository.
			container.empty(); // Ensure clean for this specific message
			const statusTextEl = container.createEl('span', { cls: 'svn-status-text' });
			if (!data.status || data.status.length === 0) {
				this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);
			} else {
				// Display a generic message if there are statuses but no specific file is selected.
				this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, "Repository status (select a file for details)", SVNConstants.CSS_CLASSES.UP_TO_DATE);
			}
			return;
		}
	}

	/**
	 * Direct status update without retry logic - for simple refreshes
	 */
	async updateFileStatusDirect(currentFile: TFile | null, statusContainer: HTMLElement | null): Promise<void> {
		if (!currentFile || !statusContainer) return;
		
		console.log('[SVN ViewStatusManager] Performing direct status update for:', currentFile.path);
		
		try {            // Get fresh status data directly without retry logic
			const statusResult = await this.svnClient.getStatus(currentFile.path);
			const infoResult = await this.svnClient.getInfo(currentFile.path);
			
			const statusData = {
				isWorkingCopy: true,
				status: statusResult || [],
				info: infoResult || null
			};
			
			// Store the direct status data with protection window
			this.stateManager.setLastDirectStatusData(statusData);
			
			// Calculate and store the new status hash
			const newStatusHash = this.stateManager.calculateStatusHashFromData(
				statusData, 
				currentFile.path, 
				currentFile.name
			);
			this.stateManager.setLastStatusHash(newStatusHash);
			
			// Render the updated status immediately
			statusContainer.empty();
			this.renderStatusWithData(statusContainer, statusData as any, currentFile);
			
			console.log('[SVN ViewStatusManager] Direct status update completed successfully');
			
		} catch (error) {
			console.error('[SVN ViewStatusManager] Error in direct status update:', error);
		}
	}

	/**
	 * Analyze the type of changes in a diff to determine if they're substantial or just whitespace
	 */
	analyzeDiffChanges(diff: string): { type: string, isWhitespaceOnly: boolean, description: string } {
		console.log('[SVN ViewStatusManager] Analyzing diff changes, input length:', diff.length);
		
		if (!diff || diff.trim().length === 0) {
			return { type: 'no-changes', isWhitespaceOnly: true, description: 'No changes detected' };
		}
		
		// Split diff into lines and analyze changes
		const lines = diff.split('\n');
		const changeLines = lines.filter(line => line.startsWith('+') || line.startsWith('-'));
		
		console.log('[SVN ViewStatusManager] Diff analysis:', {
			totalLines: lines.length,
			changeLines: changeLines.length,
			sampleChangeLines: changeLines.slice(0, 5)
		});
		
		if (changeLines.length === 0) {
			return { type: 'no-changes', isWhitespaceOnly: true, description: 'No visible changes' };
		}
		
		// Analyze the actual content changes
		let hasContentChanges = false;
		let hasWhitespaceChanges = false;
		let hasLineEndingChanges = false;
		
		for (const line of changeLines) {
			const content = line.substring(1); // Remove +/- prefix
			const trimmedContent = content.trim();
			
			if (trimmedContent.length > 0) {
				// This line has actual content
				hasContentChanges = true;
			} else if (content.length > 0) {
				// This line has only whitespace
				hasWhitespaceChanges = true;
			}
		}
		
		// Detect line ending changes by looking for lines that differ only in invisible characters
		const addedLines = changeLines.filter(l => l.startsWith('+')).map(l => l.substring(1));
		const removedLines = changeLines.filter(l => l.startsWith('-')).map(l => l.substring(1));
		
		if (addedLines.length === removedLines.length) {
			const hasLineEndingDifferences = addedLines.some((added, index) => {
				const removed = removedLines[index];
				return !!(removed && added.trim() === removed.trim() && added !== removed);
			});
			
			if (hasLineEndingDifferences) {
				hasLineEndingChanges = true;
			}
		}
		
		// Determine the overall type of changes
		const result = (() => {
			if (hasContentChanges) {
				return { 
					type: 'content', 
					isWhitespaceOnly: false, 
					description: 'Content changes with possible whitespace changes' 
				};
			} else if (hasLineEndingChanges) {
				return { 
					type: 'line-endings', 
					isWhitespaceOnly: true, 
					description: 'Line ending differences only' 
				};
			} else if (hasWhitespaceChanges) {
				return { 
					type: 'whitespace', 
					isWhitespaceOnly: true, 
					description: 'Whitespace changes only' 
				};
			} else {
				return { 
					type: 'unknown', 
					isWhitespaceOnly: false, 
					description: 'Unknown change type' 
				};
			}
		})();
		
		console.log('[SVN ViewStatusManager] Diff analysis result:', {
			hasContentChanges,
			hasWhitespaceChanges,
			hasLineEndingChanges,
			result
		});
		
		return result;
	}
}
