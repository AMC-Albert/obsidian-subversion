import { TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SvnStatusCode, SvnFileData } from '@/types';
import { UIState } from '../SVNUIController';
import { SVNStatusDisplay } from '.';
import { SVNViewStateManager } from './SVNViewStateManager';
import { SVNStatusUtils } from '../../utils/SVNStatusUtils';
import { SVNConstants } from '../../utils/SVNConstants';
import { SVNFileStateRenderer } from './SVNFileStateRenderer';
import { loggerDebug, loggerInfo, loggerError, registerLoggerClass } from '@/utils/obsidian-logger';

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
	private lastRenderedStatusType: string | null = null; // Added to track the type of status rendered

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
		registerLoggerClass(this, 'SVNViewStatusManager'); // Ensure logger is registered
	}

	/**
	 * Update status display section only
	 */
	async updateStatusDisplay(state: UIState, statusContainer: HTMLElement | null, currentFile: TFile | null): Promise<void> {
		if (!statusContainer) return;
		
		if (this.isRendering) {
			loggerDebug(this, 'Already rendering status, skipping duplicate update');
			return;
		}
		
		this.isRendering = true;
		let newStatusType = 'unknown'; // Determine what kind of status we are about to render

		try {
			const currentStatusHash = this.stateManager.calculateStatusHash(state, currentFile?.path);
			const lastStatusHash = this.stateManager.getLastStatusHash();

			// Primary condition to skip rendering: if hash hasn't changed, and we are not in a loading state that needs to transition.
			// If showLoading is true, we might need to switch to a loading indicator even if data hash is same.
			if (currentStatusHash === lastStatusHash && !state.showLoading && this.lastRenderedStatusType !== 'loading') {
				loggerDebug(this, 'Status hash unchanged and not transitioning from/to loading, skipping render');
				this.isRendering = false;
				return;
			}

			loggerDebug(this, 'Proceeding with status render:', { currentHash: currentStatusHash, lastHash: lastStatusHash, showLoading: state.showLoading, lastRenderedType: this.lastRenderedStatusType });

			// Determine the type of content to render for status
			if (state.showLoading) {
				newStatusType = 'loading';
				if (this.lastRenderedStatusType !== 'loading') {
					statusContainer.empty();
					statusContainer.createEl('span', { text: 'Loading SVN data...', cls: 'svn-status-loading' });
				}
			} else if (state.data) {
				// renderStatusWithData will determine the specific status type (e.g., 'unversioned', 'versioned-details')
				// It needs to be responsible for emptying or not based on its internal logic and lastRenderedStatusType
				newStatusType = await this.renderStatusWithData(statusContainer, state.data, currentFile, this.lastRenderedStatusType);
			} else if (currentFile) {
				// Fallback to direct SVNStatusDisplay (which empties container)
				newStatusType = 'direct-render';
				if (this.lastRenderedStatusType !== 'direct-render') { // Avoid re-rendering if already direct
					loggerDebug(this, 'No state data, falling back to direct SVNStatusDisplay render');
					const fragment = await this.statusDisplay.render(currentFile);
					if (fragment) {
						statusContainer.empty();
						statusContainer.appendChild(fragment);
					}
				}
			} else {
				newStatusType = 'no-file-selected';
				if (this.lastRenderedStatusType !== 'no-file-selected') {
					statusContainer.empty();
					const noFileEl = statusContainer.createEl('span', { cls: 'svn-status-text' });
					this.statusDisplay.createStatusWithIcon(noFileEl, SVNConstants.ICONS.INFO, SVNConstants.MESSAGES.NO_FILE_SELECTED, SVNConstants.CSS_CLASSES.INFO);
				}
			}

			this.stateManager.setLastStatusHash(currentStatusHash);
			this.lastRenderedStatusType = newStatusType;

		} finally {
			this.isRendering = false;
		}
	}

	/**
	 * Render status display with loaded data
	 * @returns The specific type of status rendered (e.g., 'unversioned', 'up-to-date', 'versioned-details')
	 */
	private async renderStatusWithData(container: HTMLElement, data: SvnFileData, currentFile: TFile | null, lastRenderedType: string | null): Promise<string> {
		let renderedType = 'unknown';
		let fragment: DocumentFragment | null = null;

		if (!data.isWorkingCopy) {
			renderedType = 'not-in-working-copy';
			if (lastRenderedType !== renderedType) {
				const statusTextEl = document.createElement('span');
				statusTextEl.addClass('svn-status-text');
				this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.NOT_IN_WORKING_COPY, SVNConstants.MESSAGES.NOT_IN_WORKING_COPY, SVNConstants.CSS_CLASSES.WARNING);
				container.empty();
				container.appendChild(statusTextEl);
			}
			return renderedType;
		}

		if (currentFile) {
			loggerDebug(this, 'renderStatusWithData: Looking for file in status data:', {
				currentFilePath: currentFile.path,
				isFileInSvn: data.isFileInSvn,
				statusEntries: data.status?.map((item: { filePath: string; status: SvnStatusCode }) => ({ filePath: item.filePath, status: item.status })) || []
			});

			// PRIORITY CHECK: If file is explicitly marked as not in SVN, show unversioned UI immediately
			if (data.isFileInSvn === false) {
				loggerDebug(this, 'renderStatusWithData: File marked as not in SVN (isFileInSvn=false), showing unversioned status.');
				renderedType = 'unversioned';
				if (lastRenderedType !== renderedType) {
					const statusTextEl = document.createElement('span');
					statusTextEl.addClass('svn-status-text');
					this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UNVERSIONED, 'Unversioned', SVNConstants.CSS_CLASSES.UNVERSIONED);
					container.empty();
					container.appendChild(statusTextEl);
				}
				return renderedType;
			}

			const fileStatusEntry = data.status?.find((item: { filePath: string; status: SvnStatusCode }) => {
				const match = this.svnClient.comparePaths(item.filePath, currentFile.path);
				loggerDebug(this, 'Comparing paths:', {
					svnPath: item.filePath,
					currentPath: currentFile.path,
					match: match
				});
				return match;
			});
			loggerDebug(this, 'File status entry found:', fileStatusEntry);

			if (fileStatusEntry && fileStatusEntry.status === SvnStatusCode.UNVERSIONED) {
				// Unversioned file: show simple status message
				loggerDebug(this, 'renderStatusWithData: Unversioned file status found in data, showing status message.');
				renderedType = 'unversioned';
				if (lastRenderedType !== renderedType) {
					const statusTextEl = document.createElement('span');
					statusTextEl.addClass('svn-status-text');
					this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UNVERSIONED, 'Unversioned', SVNConstants.CSS_CLASSES.UNVERSIONED);
					container.empty();
					container.appendChild(statusTextEl);
				}
				return renderedType;
			} else if (fileStatusEntry && fileStatusEntry.status === SvnStatusCode.ADDED) {
				// Handle ADDED status directly for efficiency, as it won't have detailed SVN info yet.
				loggerDebug(this, 'renderStatusWithData: File is ADDED, showing simple status.');
				renderedType = 'added-details'; // A more specific type for added files
				if (lastRenderedType !== renderedType) {
					const statusTextEl = document.createElement('span');
					statusTextEl.addClass('svn-status-text');
					this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.ADDED, SVNConstants.MESSAGES.ADDED, SVNConstants.CSS_CLASSES.ADDED);
					container.empty();
					container.appendChild(statusTextEl);
				}
				return renderedType;
			} else if (fileStatusEntry) {
				// Versioned file with other status (M, D, etc.) - delegate to SVNStatusDisplay
				loggerDebug(this, 'renderStatusWithData: Versioned file with status (not ADDED), delegating to SVNStatusDisplay.');
				fragment = await this.statusDisplay.render(currentFile);
				renderedType = 'versioned-details';
				// SVNStatusDisplay now returns a fragment, so we append it.
				// We only clear if the type is different to avoid flicker if it's the same detailed view.
				if (lastRenderedType !== renderedType && fragment) {
					container.empty();
					container.appendChild(fragment);
				} else if (fragment) {
					// If same type, still need to update if content changed (e.g. revision number)
					// For simplicity, we replace children if fragment is not null.
					// More sophisticated diffing could be done here if needed.
					container.replaceChildren(fragment);
				}
				return renderedType;
			} else {
				// File not found in status data - could be clean/unmodified versioned file
				// Check if the file is actually versioned first
				if (data.isFileInSvn === true) {
					// File is versioned but has no status entry - it's clean/committed
					loggerDebug(this, 'renderStatusWithData: File is versioned but clean (no status entry), showing up-to-date status.');
					renderedType = 'up-to-date';
					if (lastRenderedType !== renderedType) {
						const statusTextEl = document.createElement('span');
						statusTextEl.addClass('svn-status-text');
						this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);
						container.empty();
						container.appendChild(statusTextEl);
					}
					return renderedType;
				}
				
				// Check if there are any status entries at all to determine if we're in a working copy with data
				if (data.status && data.status.length > 0) {
					// We have status data but this file isn't in it - likely a clean versioned file
					loggerDebug(this, 'renderStatusWithData: Clean versioned file (not in status list), delegating to SVNStatusDisplay.');
					fragment = await this.statusDisplay.render(currentFile);
					renderedType = 'complex-fallback-needs-render';
					if (fragment) {
						container.empty(); // Always clear for this fallback as it implies a significant state change
						container.appendChild(fragment);
					}
					return renderedType;
				} else {
					// No status data at all - might be unversioned or error state
					loggerDebug(this, 'renderStatusWithData: No status data available, attempting direct render.');
					fragment = await this.statusDisplay.render(currentFile);
					renderedType = 'no-status-data-direct-render';
					if (fragment) {
						container.empty();
						container.appendChild(fragment);
					}
					return renderedType; // Return type string
				}
			}
		} else {
			// No current file selected, but it's a working copy.
			// Show a generic status for the repository.
			renderedType = 'no-current-file';
			if (lastRenderedType !== renderedType) {
				const statusTextEl = document.createElement('span');
				statusTextEl.addClass('svn-status-text');
				if (!data.status || data.status.length === 0) {
					this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, SVNConstants.MESSAGES.UP_TO_DATE, SVNConstants.CSS_CLASSES.UP_TO_DATE);
				} else {
					this.statusDisplay.createStatusWithIcon(statusTextEl, SVNConstants.ICONS.UP_TO_DATE, "Repository status (select a file for details)", SVNConstants.CSS_CLASSES.UP_TO_DATE);
				}
				container.empty();
				container.appendChild(statusTextEl);
			}
			return renderedType;
		}

		// Fallback if no specific type was matched, should ideally not be reached if logic is complete
		if (lastRenderedType !== 'unknown-default') {
			container.empty();
			const fallbackEl = container.createEl('span', {text: 'Status unavailable.'});
			// Optionally add icon/styling for unknown state
			this.statusDisplay.createStatusWithIcon(fallbackEl, SVNConstants.ICONS.INFO, 'Status unavailable.', SVNConstants.CSS_CLASSES.INFO);
		}
		return 'unknown-default';
	}

	/**
	 * Direct status update without retry logic - for simple refreshes
	 */
	async updateFileStatusDirect(currentFile: TFile | null, statusContainer: HTMLElement | null): Promise<void> {
		if (!currentFile || !statusContainer) return;
		
		loggerDebug(this, 'Performing direct status update for:', currentFile.path);
		
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
			// statusContainer.empty(); // renderStatusWithData will handle clearing based on lastRenderedType
			this.lastRenderedStatusType = await this.renderStatusWithData(statusContainer, statusData as any, currentFile, this.lastRenderedStatusType);
			
			loggerDebug(this, 'Direct status update completed successfully');
			
		} catch (error) {
			loggerError(this, 'Error in direct status update:', error);
		}
	}

	/**
	 * Analyze the type of changes in a diff to determine if they're substantial or just whitespace
	 */
	analyzeDiffChanges(diff: string): { type: string, isWhitespaceOnly: boolean, description: string } {
		loggerDebug(this, 'Analyzing diff changes, input length:', diff.length);
		
		if (!diff || diff.trim().length === 0) {
			return { type: 'no-changes', isWhitespaceOnly: true, description: 'No changes detected' };
		}
		
		// Split diff into lines and analyze changes
		const lines = diff.split('\n');
		const changeLines = lines.filter(line => line.startsWith('+') || line.startsWith('-'));
		
		loggerDebug(this, 'Diff analysis:', {
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
		
		loggerDebug(this, 'Diff analysis result:', {
			hasContentChanges,
			hasWhitespaceChanges,
			hasLineEndingChanges,
			result
		});
		
		return result;
	}
}





