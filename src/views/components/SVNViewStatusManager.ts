import { TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SVNFileData } from '../../services/SVNDataStore';
import { UIState } from '../SVNUIController';
import { SVNStatusDisplay } from '.';
import { SVNViewStateManager } from './SVNViewStateManager';
import { SVNStatusUtils } from '../../utils/SVNStatusUtils';
import { SVNConstants } from '../../utils/SVNConstants';
import { SVNFileStateRenderer } from './SVNFileStateRenderer';
import { logger, logDebug, logInfo } from '../../utils/logger';

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
	 */
	async updateStatusDisplay(state: UIState, statusContainer: HTMLElement | null, currentFile: TFile | null): Promise<void> {
		if (!statusContainer) return;
		
		// Prevent duplicate renders - if already rendering, skip
		if (this.isRendering) {
			logDebug('SVN ViewStatusManager', 'Already rendering, skipping duplicate update');
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
				// Don't rebuild during loading if we already have content
				return;
			}
			
			// Calculate status hash to avoid unnecessary rebuilds
			const currentStatusHash = this.stateManager.calculateStatusHash(state, currentFile?.path);
			if (currentStatusHash === this.stateManager.getLastStatusHash()) {
				logInfo('SVN ViewStatusManager', 'Status hash unchanged, skipping render');
				return;
			}
			
			statusContainer.empty();
			
			if (state.showLoading) {
				// During loading, show a simple loading message instead of trying to render status
				const loadingEl = statusContainer.createEl('span', { 
					text: 'Loading SVN data...', 
					cls: 'svn-status-loading' 
				});
			} else if (state.data && !state.showLoading) {
				// Always use renderStatusWithData when we have state data - it handles routing correctly
				this.renderStatusWithData(statusContainer, state.data, currentFile);
			} else if (currentFile && !state.showLoading) {
				// Only fall back to direct SVNStatusDisplay when we have no state data AND not loading
				// But never during loading state to prevent infinite loops
				logInfo('SVN ViewStatusManager', 'No state data available, falling back to direct SVNStatusDisplay');
				await this.statusDisplay.render(statusContainer, currentFile);
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
		}		if (currentFile) {
			logInfo('SVN ViewStatusManager', 'renderStatusWithData: Looking for file in status data:', {
				currentFilePath: currentFile.path,
				isFileInSvn: data.isFileInSvn,
				statusEntries: data.status?.map(item => ({ filePath: item.filePath, status: item.status })) || []
			});

			// PRIORITY CHECK: If file is explicitly marked as not in SVN, show unversioned UI immediately
			if (data.isFileInSvn === false) {
				logInfo('SVN ViewStatusManager', 'renderStatusWithData: File marked as not in SVN (isFileInSvn=false), showing unversioned status.');
				container.empty();
				const statusTextEl = container.createEl('span', { cls: 'svn-status-text' });
				this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UNVERSIONED, 'Unversioned', SVNConstants.CSS_CLASSES.UNVERSIONED);
				return;
			}

			const fileStatusEntry = data.status?.find(item => {
				const match = this.svnClient.comparePaths(item.filePath, currentFile.path);
				logInfo('SVN ViewStatusManager', 'Comparing paths:', {
					svnPath: item.filePath,
					currentPath: currentFile.path,
					match: match
				});
				return match;
			});
			logInfo('SVN ViewStatusManager', 'File status entry found:', fileStatusEntry);

			if (fileStatusEntry && fileStatusEntry.status === '?') {
				// Unversioned file: show simple status message
				logInfo('SVN ViewStatusManager', 'renderStatusWithData: Unversioned file status found in data, showing status message.');
				container.empty();
				const statusTextEl = container.createEl('span', { cls: 'svn-status-text' });
				this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UNVERSIONED, 'Unversioned', SVNConstants.CSS_CLASSES.UNVERSIONED);
				return;
			} else if (fileStatusEntry) {
				// Versioned file with status (M, A, D, etc.) - delegate to SVNStatusDisplay
				logInfo('SVN ViewStatusManager', 'renderStatusWithData: Versioned file with status, delegating to SVNStatusDisplay.');
				this.statusDisplay.render(container, currentFile);
				return;			} else {
				// File not found in status data - could be clean/unmodified versioned file
				// Check if the file is actually versioned first
				if (data.isFileInSvn === true) {
					// File is versioned but has no status entry - it's clean/committed
					logInfo('SVN ViewStatusManager', 'renderStatusWithData: File is versioned but clean (no status entry), showing up-to-date status.');
					container.empty();
					const statusTextEl = container.createEl('span', { cls: 'svn-status-text' });
					this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);
					return;
				}
				
				// Check if there are any status entries at all to determine if we're in a working copy with data
				if (data.status && data.status.length > 0) {
					// We have status data but this file isn't in it - likely a clean versioned file
					logInfo('SVN ViewStatusManager', 'renderStatusWithData: Clean versioned file (not in status list), delegating to SVNStatusDisplay.');
					this.statusDisplay.render(container, currentFile);
					return;
				} else {
					// No status data at all - might be unversioned or error state
					logInfo('SVN ViewStatusManager', 'renderStatusWithData: No status data available, checking if file is versioned.');
					this.statusDisplay.render(container, currentFile);
					return;
				}
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
		
		logInfo('SVN ViewStatusManager', 'Performing direct status update for:', currentFile.path);
		
		try {
			// Get fresh status data directly without retry logic
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
			
			logInfo('SVN ViewStatusManager', 'Direct status update completed successfully');
			
		} catch (error) {
			logInfo('SVN ViewStatusManager', 'Error in direct status update:', error);
		}
	}

	/**
	 * Analyze the type of changes in a diff to determine if they're substantial or just whitespace
	 */
	analyzeDiffChanges(diff: string): { type: string, isWhitespaceOnly: boolean, description: string } {
		logInfo('SVN ViewStatusManager', 'Analyzing diff changes, input length:', diff.length);
		
		if (!diff || diff.trim().length === 0) {
			return { type: 'no-changes', isWhitespaceOnly: true, description: 'No changes detected' };
		}
		
		// Split diff into lines and analyze changes
		const lines = diff.split('\n');
		const changeLines = lines.filter(line => line.startsWith('+') || line.startsWith('-'));
		
		logInfo('SVN ViewStatusManager', 'Diff analysis:', {
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
		
		logInfo('SVN ViewStatusManager', 'Diff analysis result:', {
			hasContentChanges,
			hasWhitespaceChanges,
			hasLineEndingChanges,
			result
		});
		
		return result;
	}
}
