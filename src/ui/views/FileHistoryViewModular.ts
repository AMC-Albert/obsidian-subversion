import { ItemView, WorkspaceLeaf, TFile } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import type ObsidianSvnPlugin from '../../main';
import { PLUGIN_CONSTANTS } from '../../core/constants';
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

export const FILE_HISTORY_VIEW_TYPE = PLUGIN_CONSTANTS.VIEW_TYPE;

export class FileHistoryViewModular extends ItemView {
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
        
        // Initialize UI controller
        this.uiController = new SVNUIController(plugin, this.svnClient);
        
        // Initialize all component instances first
        this.fileActions = new SVNFileActions(plugin, this.svnClient, () => this.refreshStatus());
        this.toolbar = new SVNToolbar(plugin, this.svnClient, this.fileActions, () => this.refreshData(), () => this.showRepositorySetup());
        this.statusDisplay = new SVNStatusDisplay(this.svnClient);
        this.historyRenderer = new SVNHistoryRenderer(this.svnClient, plugin, () => this.refreshData());
        this.infoPanel = new SVNInfoPanel(plugin, this.svnClient);
        this.fileStateRenderer = new SVNFileStateRenderer(plugin, this.svnClient, () => this.refreshData());
        this.repositoryHandler = new SVNRepositoryHandler(plugin, this.svnClient, () => this.refreshData());
    }

    getViewType(): string {
        return FILE_HISTORY_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "SVN Manager";
    }

    getIcon(): string {
        return PLUGIN_CONSTANTS.ICON_ID;
    }    async onOpen() {
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
    }    /**
     * Handle UI state changes - delegate to main renderer
     */
    private async handleUIStateChange(state: UIState): Promise<void> {
        console.log('[SVN FileHistoryViewModular] handleUIStateChange called:', {
            showLoading: state.showLoading,
            hasData: !!state.data,
            error: state.error,
            isLoading: state.data?.isLoading,
            currentFile: this.currentFile?.path
        });
        
        // Let the main renderer handle all UI updates
        await this.viewRenderer.handleUIStateChange(state, this.currentFile);
    }

    /**
     * Show repository setup UI
     */
    private showRepositorySetup(): void {
        if (!this.currentFile) return;
        this.viewRenderer.showRepositorySetup(this.currentFile);
    }

    // === PUBLIC API METHODS (Expected by main.ts) ===

    /**
     * Refresh all data (full refresh)
     */
    async refreshData(): Promise<void> {
        console.log('[SVN FileHistoryViewModular] refreshData called');
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
        console.log('[SVN FileHistoryViewModular] refreshStatus called');
        await this.viewRenderer.refreshStatus(this.currentFile);
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
}
