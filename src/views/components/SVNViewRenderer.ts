import { TFile } from 'obsidian';
import { SVNClient } from '@/services';
import { SvnStatusCode } from '@/types';
import { UIState } from '../SVNUIController';
import { 
	SVNToolbar, 
	SVNFileActions, 
	SVNStatusDisplay, 
	SVNHistoryRenderer, 
	SVNInfoPanel,
	SVNFileStateRenderer,
	SVNRepositoryHandler 
} from '.';
import { SVNViewStateManager } from './SVNViewStateManager';
import { SVNViewLayoutManager } from './SVNViewLayoutManager';
import { SVNViewStatusManager } from './SVNViewStatusManager';
import { SVNViewHistoryManager } from './SVNViewHistoryManager';
import type ObsidianSvnPlugin from '../../main';
import { debug, info, error, registerLoggerClass } from '@/utils/obsidian-logger';

/**
 * Main renderer component that coordinates all rendering logic for the FileHistoryView
 * Extracted from FileHistoryView to reduce complexity
 */
export class SVNViewRenderer {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	
	// Component managers
	private stateManager: SVNViewStateManager;
	private layoutManager: SVNViewLayoutManager;
	private statusManager: SVNViewStatusManager;
	private historyManager: SVNViewHistoryManager;
	
	// Component instances
	private toolbar: SVNToolbar;
	private fileActions: SVNFileActions;
	private statusDisplay: SVNStatusDisplay;
	private historyRenderer: SVNHistoryRenderer;
	private infoPanel: SVNInfoPanel;
	private fileStateRenderer: SVNFileStateRenderer;
	private repositoryHandler: SVNRepositoryHandler;
	
	// State handling protection
	private isHandlingStateChange: boolean = false;
	private pendingState: UIState | null = null;
	private pendingFile: TFile | null = null;

	constructor(
		plugin: ObsidianSvnPlugin,
		svnClient: SVNClient,
		containerEl: HTMLElement,
		toolbar: SVNToolbar,
		fileActions: SVNFileActions,
		statusDisplay: SVNStatusDisplay,
		historyRenderer: SVNHistoryRenderer,
		infoPanel: SVNInfoPanel,
		fileStateRenderer: SVNFileStateRenderer,
		repositoryHandler: SVNRepositoryHandler	) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		registerLoggerClass(this, 'SVNViewRenderer');
		
		// Initialize managers
		this.stateManager = new SVNViewStateManager();
		this.layoutManager = new SVNViewLayoutManager(containerEl);
		this.statusManager = new SVNViewStatusManager(svnClient, statusDisplay, this.stateManager, fileStateRenderer);
		this.historyManager = new SVNViewHistoryManager(
			svnClient, 
			plugin, 
			historyRenderer, 
			fileStateRenderer, 
			repositoryHandler
		);
		
		// Store component instances
		this.toolbar = toolbar;
		this.fileActions = fileActions;
		this.statusDisplay = statusDisplay;
		this.historyRenderer = historyRenderer;
		this.infoPanel = infoPanel;
		this.fileStateRenderer = fileStateRenderer;
		this.repositoryHandler = repositoryHandler;
	}

	/**
	 * Initialize the layout once
	 */
	initializeLayout(): void {
		this.layoutManager.initializeLayout();
		this.layoutManager.setupInfoPanel(this.infoPanel, this.fileActions);
	}	/**
	 * Handle UI state changes intelligently, processing the latest available state.
	 */
	async handleUIStateChange(state: UIState, currentFile: TFile | null): Promise<void> {
		debug(this, 'handleUIStateChange invoked for file:', currentFile?.path ?? 'none', 'Current isHandling:', this.isHandlingStateChange);
		this.pendingState = state;
		this.pendingFile = currentFile;

		if (this.isHandlingStateChange) {
			debug(this, 'Renderer busy, new state queued for file:', currentFile?.path ?? 'none');
			return;
		}

		this.isHandlingStateChange = true;
		debug(this, 'Renderer started processing.');

		try {
			while (this.pendingState) {
				const stateToProcess = this.pendingState;
				const fileToProcess = this.pendingFile;
				
				// Clear pending state *before* processing this iteration's state
				this.pendingState = null;
				this.pendingFile = null;

				debug(this, 'Processing state for file:', fileToProcess?.path ?? 'none', { hasData: !!stateToProcess.data, isLoading: stateToProcess.isLoading, showLoading: stateToProcess.showLoading });

				// Check for user interaction or repository setup
				if (this.stateManager.isInUserInteractionWindow()) {
					info(this, 'Skipping UI update (user interaction) for file:', fileToProcess?.path ?? 'none');
					continue; // Skip this state, check for newer pending state in the next loop iteration
				}
				if (this.isShowingRepositorySetup()) {
					info(this, 'Skipping UI update (repository setup active) for file:', fileToProcess?.path ?? 'none');
					continue; // Skip this state, check for newer pending state
				}

				// Override state data status with recent direct status if within protection window
				if (this.stateManager.isWithinProtectionWindow() && stateToProcess.data) {
					const directData = this.stateManager.getLastDirectStatusData();
					if (directData && directData.status) { // Ensure directData and its status exist
						stateToProcess.data.status = directData.status;
						stateToProcess.data.hasLocalChanges = directData.status.some((s: any) => 
							s.status === SvnStatusCode.MODIFIED || 
							s.status === SvnStatusCode.ADDED || 
							s.status === SvnStatusCode.DELETED
						);
					}
				}
				
				// If we have fresh direct status data, render override and skip state-driven UI updates
				if (this.stateManager.isWithinProtectionWindow()) {
					const statusContainer = this.layoutManager.getStatusContainer();
					if (statusContainer && this.stateManager.getLastDirectStatusData()) {
						await this.statusManager.updateStatusDisplay(stateToProcess, statusContainer, fileToProcess);
						debug(this, 'Direct status update rendered for file:', fileToProcess?.path ?? 'none');
						continue; // Skip further processing for this state, check for newer pending state
					}
				}
				
				// Calculate state hash for intelligent updates
				const currentDataHash = this.stateManager.calculateStateHash(stateToProcess);
				const currentFileId = fileToProcess?.path || null;
				
				const fileChanged = currentFileId !== this.stateManager.getLastFileId();
				const dataChanged = currentDataHash !== this.stateManager.getLastDataHash();
				
				if (fileChanged || dataChanged) {
					debug(this, 'File or data changed, updating view intelligently for file:', fileToProcess?.path ?? 'none', { fileChanged, dataChanged });
					await this.updateViewIntelligently(stateToProcess, fileChanged, dataChanged, fileToProcess);
					this.stateManager.setLastDataHash(currentDataHash);
					this.stateManager.setLastFileId(currentFileId);
				} else {
					debug(this, 'No significant file or data change, skipping full view update for file:', fileToProcess?.path ?? 'none');
				}
			}
		} catch (err) {
			error(this, 'Error during handleUIStateChange processing loop:', err);
		} finally {
			this.isHandlingStateChange = false;
			debug(this, 'Renderer finished processing. Pending state available:', !!this.pendingState);

			// If a new state came in and was stored in this.pendingState *after* the while condition
			// was last checked (e.g., during an await in the loop's last iteration, or if loop didn't run due to initial pendingState being null),
			// and the loop has exited, we need to re-trigger processing for this new state.
			if (this.pendingState) {
				debug(this, 'Re-triggering handleUIStateChange for pending state after loop completion for file:', this.pendingFile?.path ?? 'none');
				// Use a microtask to avoid deep recursion and allow current stack to unwind.
				// Pass the currently stored pendingState and pendingFile.
				Promise.resolve().then(() => this.handleUIStateChange(this.pendingState!, this.pendingFile)).catch(e => error(this, "Error in re-triggered handleUIStateChange", e));
			}
		}
	}

	/**
	 * Intelligently update only what has changed
	 */
	private async updateViewIntelligently(state: UIState, fileChanged: boolean, dataChanged: boolean, currentFile: TFile | null): Promise<void> {
		// Ensure layout is initialized
		this.initializeLayout();
		
		// Always update toolbar on file change
		if (fileChanged) {
			this.layoutManager.updateToolbar(this.toolbar, currentFile);
		}
		
		// Update status display when data changes
		// Consider if status display also needs more granular updates to prevent flashing
		if (dataChanged) {
			const statusContainer = this.layoutManager.getStatusContainer();
			await this.statusManager.updateStatusDisplay(state, statusContainer, currentFile);
		}
		
		// Update content area when file or data changes
		if (fileChanged || dataChanged) {
			// This method will now be responsible for more granular updates
			this.updateContentArea(state, currentFile);
		}
	}

	/**
	 * Update content area section only  
	 */
	private updateContentArea(state: UIState, currentFile: TFile | null): void {
		const contentArea = this.layoutManager.getContentArea();
		if (!contentArea) return;

		const newContentType = this.stateManager.getContentType(state);
		const lastContentType = this.stateManager.getLastContentType();
		// Ensure hasHistoryChanged is only evaluated if relevant (i.e., newContentType is 'history')
		const historyActuallyChanged = newContentType === 'history' ? this.stateManager.hasHistoryChanged(state) : false;
		
		info(this, 'Content analysis for updateContentArea:', {
			newContentType,
			lastContentType,
			historyActuallyChanged,
			showLoading: state.showLoading,
			hasData: !!state.data,
			historyCount: state.data?.history?.length || 0,
			currentFile: currentFile?.path
		});
		
		// Delegate to HistoryManager to handle rendering and clearing decisions
		this.historyManager.updateContentAreaDOM( // Renamed to avoid conflict if we keep old one temporarily
			contentArea,
			state,
			currentFile,
			newContentType,
			lastContentType,
			historyActuallyChanged 
		);
		
		// Update content type tracking
		this.stateManager.setLastContentType(newContentType);
	}	/**
	 * Show repository setup UI
	 */
	showRepositorySetup(currentFile: TFile | null): void {
		info(this, 'Showing repository setup view');
		// Clear the content area and show repository setup
		const contentArea = this.layoutManager.getContentArea();
		if (contentArea) {
			contentArea.empty();
			this.repositoryHandler.renderRepositorySetup(contentArea, currentFile);
		}
	}

	/**
	 * Check if currently showing repository setup
	 */
	private isShowingRepositorySetup(): boolean {
		const contentArea = this.layoutManager.getContentArea();
		if (!contentArea) return false;
		
		// Check for repository setup indicators
		const hasSetupContent = 
			contentArea.querySelector('.workspace-leaf-content') !== null ||
			(contentArea.querySelector('h3')?.textContent?.includes('Repository Setup') ?? false) ||
			(contentArea.textContent?.includes('Repository setup') ?? false) ||
			(contentArea.textContent?.includes('not found in vault') ?? false) ||
			(contentArea.textContent?.includes('Create New Repository') ?? false) ||
			(contentArea.textContent?.includes('Checkout Existing Repository') ?? false);

		return hasSetupContent;
	}/**
	 * Show the normal file view (opposite of repository setup)
	 */
	showNormalView(currentFile: TFile | null): void {
		info(this, 'Showing normal file view');
		// Clear the content area
		const contentArea = this.layoutManager.getContentArea();
		if (contentArea) {
			contentArea.empty();
		}
		
		// Reset state tracking to ensure fresh rendering
		this.stateManager.resetStateTracking();
		
		// The actual data refresh should be triggered by the caller (SVNView)
		// This method just prepares the view for normal content
	}

	/**
	 * Refresh status directly (for fast updates)
	 */
	async refreshStatus(currentFile: TFile | null): Promise<void> {
		if (!currentFile) return;
		
		// Use the status manager's direct update method which now routes properly
		const statusContainer = this.layoutManager.getStatusContainer();
		await this.statusManager.updateFileStatusDirect(currentFile, statusContainer);
	}

	/**
	 * Reset all state tracking
	 */
	resetStateTracking(): void {
		this.stateManager.resetStateTracking();
		this.layoutManager.resetLayout();
	}

	// Expose managers for external access if needed
	getStateManager(): SVNViewStateManager { return this.stateManager; }
	getLayoutManager(): SVNViewLayoutManager { return this.layoutManager; }
	getStatusManager(): SVNViewStatusManager { return this.statusManager; }
	getHistoryManager(): SVNViewHistoryManager { return this.historyManager; }
}





