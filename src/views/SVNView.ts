import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { SVNClient } from '@/services';
import type ObsidianSvnPlugin from '../main';
import { PLUGIN_CONSTANTS } from '@/core';
import { 
	SVNViewRenderer,
	SVNToolbar, 
	SVNFileActions, 
	SVNStatusDisplay, 
	SVNHistoryRenderer, 
	SVNInfoPanel,
	SVNFileStateRenderer,
	SVNRepositoryHandler 
} from './components';
import { SVNUIController, UIState } from './SVNUIController';
import { debug, info, error, registerLoggerClass } from '@/utils/obsidian-logger';

export const FILE_HISTORY_VIEW_TYPE = PLUGIN_CONSTANTS.VIEW_TYPE;

export class SVNView extends ItemView {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private currentFile: TFile | null = null;
	private currentViewedRevision: string | null = null;
	
	// Main renderer that coordinates all components
	private viewRenderer: SVNViewRenderer;
	
	// Component instances (needed for SVNViewRenderer)
	private toolbar: SVNToolbar;
	private fileActions: SVNFileActions;
	private statusDisplay: SVNStatusDisplay;
	private historyRenderer: SVNHistoryRenderer;
	private infoPanel: SVNInfoPanel;
	private fileStateRenderer: SVNFileStateRenderer;
	private repositoryHandler: SVNRepositoryHandler;
	
	// UI Controller for data management
	private uiController: SVNUIController;
	private unsubscribeUI: (() => void) | null = null;
	
	// Simple state tracking
	private isInitialized = false;
	constructor(leaf: WorkspaceLeaf, plugin: ObsidianSvnPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.svnClient = plugin.svnClient;
		registerLoggerClass(this, 'SVNView');
		
		// Initialize UI controller
		this.uiController = new SVNUIController(plugin, this.svnClient);
		// Initialize all component instances first
		this.fileActions = new SVNFileActions(plugin, this.svnClient, () => this.refreshData());
		this.toolbar = new SVNToolbar(plugin, this.svnClient, this.fileActions, () => this.refreshData(), () => this.toggleRepositorySetup());
		this.statusDisplay = new SVNStatusDisplay(this.svnClient);
		this.historyRenderer = new SVNHistoryRenderer(this.svnClient, plugin, () => this.refreshData());
		this.infoPanel = new SVNInfoPanel(plugin, this.svnClient);
		this.fileStateRenderer = new SVNFileStateRenderer(plugin, this.svnClient, () => this.refreshData());
		this.repositoryHandler = new SVNRepositoryHandler(plugin, this.svnClient, () => this.refreshData(), () => this.markUserInteraction());
				// Set cross-references between components
		this.fileActions.setInfoToggleCallback((isActive: boolean) => {
			this.toolbar.setButtonActive('info', isActive);
		});
		this.fileActions.setToolbar(this.toolbar);
	}

	getViewType(): string {
		return FILE_HISTORY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "SVN Manager";
	}

	getIcon(): string {
		return PLUGIN_CONSTANTS.ICON_ID;
	}

	async onOpen() {
		// Initialize the view
		this.initializeView();
		
		// Subscribe to UI state changes
		this.unsubscribeUI = this.uiController.subscribeToUI((state) => {
			this.handleUIStateChange(state);
		});
		
		// Listen for active file changes
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.updateCurrentFile();
			})
		);
		
		// Initial render
		this.updateCurrentFile();
	}

	async onClose() {
		// Clean up subscriptions
		if (this.unsubscribeUI) {
			this.unsubscribeUI();
			this.unsubscribeUI = null;
		}
		
		// Dispose UI controller
		this.uiController.dispose();
		
		// Reset state tracking in view renderer
		this.viewRenderer.resetStateTracking();
		
		this.isInitialized = false;
	}

	/**
	 * Initialize the view structure - delegate to main renderer
	 */
	private initializeView(): void {
		if (this.isInitialized) return;
		
		// Create the SVNViewRenderer with all components
		this.viewRenderer = new SVNViewRenderer(
			this.plugin,
			this.svnClient,
			this.containerEl,
			this.toolbar,
			this.fileActions,
			this.statusDisplay,
			this.historyRenderer,
			this.infoPanel,
			this.fileStateRenderer,
			this.repositoryHandler
		);
		
		// Initialize the layout
		this.viewRenderer.initializeLayout();
		this.isInitialized = true;
	}

	/**
	 * Update the current file being viewed
	 */
	private async updateCurrentFile(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile !== this.currentFile) {
			this.currentFile = activeFile;
			await this.uiController.setCurrentFile(activeFile);
		}
	}
	/**
	 * Handle UI state changes - delegate to main renderer
	 */
	private async handleUIStateChange(state: UIState): Promise<void> {
		info(this, 'handleUIStateChange called:', {
			showLoading: state.showLoading,
			hasData: !!state.data,
			error: state.error,
			isLoading: state.isLoading,
			currentFile: this.currentFile?.path
		});
		
		// Prevent overlapping state change handlers
		if (!this.isInitialized) {
			info(this, 'View not initialized, skipping state change');
			return;
		}
		
		// Let the main renderer handle all UI updates first
		await this.viewRenderer.handleUIStateChange(state, this.currentFile);
				// Check if we're showing repository setup after rendering
		const isShowingSetup = this.isShowingRepositorySetup();
		info(this, 'Setup mode detected:', isShowingSetup);
		
		// Update toolbar button states based on current state
		if (isShowingSetup) {
			this.updateToolbarForRepositorySetup();
		} else {
			// Reset settings button active state and update button states normally
			this.toolbar.setButtonActive('settings', false);
			await this.toolbar.updateButtonStates(this.currentFile);
		}
	}	/**
	 * Toggle between repository setup and normal view
	 */
	async toggleRepositorySetup(): Promise<void> {
		const isCurrentlyShowingSetup = this.isShowingRepositorySetup();
		
		if (isCurrentlyShowingSetup) {
			// Go back to normal view - first clear and prepare
			this.viewRenderer.showNormalView(this.currentFile);
			this.toolbar.setButtonActive('settings', false);
			// Force a complete refresh to populate the normal view
			await this.uiController.refreshCurrentFile();
		} else {
			// Show repository setup
			this.showRepositorySetup();
			this.toolbar.setButtonActive('settings', true);
		}
	}
	/**
	 * Show repository setup and update toolbar state
	 */
	showRepositorySetup(): void {
		info(this, 'Showing repository setup');
		this.markUserInteraction();
		
		// Hide the info panel if it's currently visible
		this.fileActions.hideInfoPanel();
		
		// Update toolbar button states instead of disabling entire toolbar
		this.updateToolbarForRepositorySetup();
		
		// Directly render repository setup through the view renderer
		this.viewRenderer.showRepositorySetup(this.currentFile);
	}/**
	 * Update toolbar button states when showing repository setup
	 */
	private updateToolbarForRepositorySetup(): void {
		// Set the settings button as active
		this.toolbar.setButtonActive('settings', true);
		
		// Disable other buttons during repository setup (only keep settings enabled)
		this.toolbar.setButtonsDisabled({
			'add': true,
			'commit': true,
			'revert': true,
			'diff': true,
			'info': true,
			'remove': true,
			'refresh': true,   // Disable refresh during setup
			'settings': false  // Keep enabled for toggling
		});
	}

	/**
	 * Handle settings changes from the main plugin
	 */
	onSettingsChanged(): void {
		info(this, 'Settings changed, refreshing view');
		// Always refresh the view when settings change to ensure all configurations are applied.
		// refreshView() ultimately calls uiController.refreshCurrentFile(), which bypasses the cache.
		this.refreshView();
	}
	
	/**
	 * Check if currently showing repository setup
	 */
	private isShowingRepositorySetup(): boolean {
		const contentArea = this.viewRenderer.getLayoutManager().getContentArea();
		if (!contentArea) return false;
		
		// Check for repository setup indicators
		const hasSetupContent = 
			contentArea.querySelector('.workspace-leaf-content') !== null ||
			(contentArea.querySelector('h3')?.textContent?.includes('Repository Setup') ?? false) ||
			(contentArea.textContent?.includes('Repository setup') ?? false) ||
			(contentArea.textContent?.includes('not found in vault') ?? false) ||
			(contentArea.textContent?.includes('Create New Repository') ?? false) ||
			(contentArea.textContent?.includes('Checkout Existing Repository') ?? false);

		info(this, 'Repository setup check:', {
			hasSetupContent,
			contentText: contentArea.textContent?.substring(0, 100)
		});
		
		return hasSetupContent;
	}

	// === PUBLIC API METHODS (Expected by main.ts) === //
	/**
	 * Refresh all data (full refresh)
	 */
	async refreshData(): Promise<void> {
		info(this, 'refreshData called');
		await this.uiController.refreshCurrentFile();
	}

	/**
	 * Legacy method for backward compatibility with main.ts
	 */
	async refreshView(): Promise<void> {
		await this.refreshData();
	}

	/**
	 * Refresh only status data (lightweight refresh)
	 */
	async refreshStatus(): Promise<void> {
		info(this, 'refreshStatus called');
		await this.viewRenderer.refreshStatus(this.currentFile);
	}

	/**
	 * Refresh the view using cached data via SVNDataStore.
	 * This is intended for background updates or light refreshes.
	 */
	async refreshFromCache(): Promise<void> {
		info(this, 'refreshFromCache called');
		// Re-triggering setCurrentFile will use the SVNDataStore, which respects the cache.
		// If the current file is null, it will effectively clear or set to a default state.
		await this.uiController.setCurrentFile(this.currentFile);
	}

	// === REVISION TRACKING METHODS ===

	/**
	 * Set the current viewed revision
	 */
	setCurrentViewedRevision(revision: string | null): void {
		this.currentViewedRevision = revision;
	}
	
	/**
	 * Get the current viewed revision
	 */
	getCurrentViewedRevision(): string | null {
		return this.currentViewedRevision;
	}

	/**
	 * Reset to working copy revision (null means working copy)
	 */
	resetToWorkingCopy(): void {
		this.currentViewedRevision = null;
	}

	/**
	 * Mark user interaction to prevent DOM rebuilding during button clicks
	 */
	private markUserInteraction(): void {
		info(this, 'markUserInteraction called - activating protection');
		this.viewRenderer.getStateManager().startUserInteraction();
	}
}




