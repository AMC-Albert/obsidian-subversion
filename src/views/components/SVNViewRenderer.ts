import { TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
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
		repositoryHandler: SVNRepositoryHandler
	) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		
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
	}
	/**
	 * Handle UI state changes intelligently
	 */
	async handleUIStateChange(state: UIState, currentFile: TFile | null): Promise<void> {
		// Check if we're in a user interaction protection window
		if (this.stateManager.isInUserInteractionWindow()) {
			console.log('[SVN ViewRenderer] Skipping UI update - user interaction in progress');
			return;
		}
		  // Override state data status with recent direct status if within protection window
		if (this.stateManager.isWithinProtectionWindow() && state.data) {
			const directData = this.stateManager.getLastDirectStatusData();
			if (directData) {
				state.data.status = directData.status as any;
				state.data.hasLocalChanges = directData.status.some((s: any) => s.status === 'M' || s.status === 'A' || s.status === 'D');
			}
		}
		
		// If we have fresh direct status data, render override and skip state-driven UI updates
		if (this.stateManager.isWithinProtectionWindow()) {
			const statusContainer = this.layoutManager.getStatusContainer();
			if (statusContainer && this.stateManager.getLastDirectStatusData()) {
				this.statusManager.updateStatusDisplay(state, statusContainer, currentFile);
				return;
			}
		}
		
		// Calculate state hash for intelligent updates
		const currentDataHash = this.stateManager.calculateStateHash(state);
		const currentFileId = currentFile?.path || null;
		
		// Only update if file changed or data significantly changed
		const fileChanged = currentFileId !== this.stateManager.getLastFileId();
		const dataChanged = currentDataHash !== this.stateManager.getLastDataHash();
		
		if (fileChanged || dataChanged) {
			await this.updateViewIntelligently(state, fileChanged, dataChanged, currentFile);
			this.stateManager.setLastDataHash(currentDataHash);
			this.stateManager.setLastFileId(currentFileId);
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
		if (dataChanged) {
			const statusContainer = this.layoutManager.getStatusContainer();
			await this.statusManager.updateStatusDisplay(state, statusContainer, currentFile);
		}
		
		// Update content area when file or data changes
		if (fileChanged || dataChanged) {
			this.updateContentArea(state, currentFile);
		}
	}

	/**
	 * Update content area section only  
	 */
	private updateContentArea(state: UIState, currentFile: TFile | null): void {
		const contentArea = this.layoutManager.getContentArea();
		if (!contentArea) return;
		
		// Determine content type for intelligent updates
		const contentType = this.stateManager.getContentType(state);
		const historyChanged = contentType === 'history' && this.stateManager.hasHistoryChanged(state);
		
		// Radical anti-flicker approach: Never rebuild content area for loading states
		// Keep existing content visible during brief loading operations
		let shouldRebuild = false;
		  if (state.showLoading) {
			// Always show loading states to prevent the UI from appearing stuck
			shouldRebuild = true;
		} else {
			// We're not in loading state - this is real content
			if (this.stateManager.getLastContentType() === 'loading') {
				shouldRebuild = true;
			} else if (contentType !== this.stateManager.getLastContentType()) {
				shouldRebuild = true;
			} else if (contentType === 'history' && historyChanged) {
				shouldRebuild = true;
			}
		}
		
		// Only rebuild if necessary
		if (shouldRebuild) {
			this.layoutManager.clearContentArea();
			this.historyManager.renderHistoryContentWithState(contentArea, state, currentFile);
		}
		  // Update content type tracking
		this.stateManager.setLastContentType(contentType);
	}    /**
	 * Show repository setup UI
	 */
	showRepositorySetup(currentFile: TFile | null): void {
		console.log('[SVN ViewRenderer] Showing repository setup');
		
		// Clear the content area and show repository setup
		const contentArea = this.layoutManager.getContentArea();
		if (contentArea) {
			this.repositoryHandler.renderRepositorySetup(contentArea, currentFile);
		}
	}	/**
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
