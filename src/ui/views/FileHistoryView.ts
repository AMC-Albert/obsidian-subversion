import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import { SVNClient } from '../../services/SVNClient';
import { SvnLogEntry } from '../../types';
import type ObsidianSvnPlugin from '../../main';
import { PLUGIN_CONSTANTS } from '../../core/constants';
import { 
    SVNToolbar, 
    SVNFileActions, 
    SVNStatusDisplay, 
    SVNHistoryRenderer, 
    SVNInfoPanel,
    SVNFileStateRenderer,
    SVNRepositoryHandler 
} from './components';
import { SVNUIController, UIState } from './SVNUIController';
import { SVNFileData } from '../../services/SVNDataStore';

export const FILE_HISTORY_VIEW_TYPE = PLUGIN_CONSTANTS.VIEW_TYPE;

export class FileHistoryView extends ItemView {
    private plugin: ObsidianSvnPlugin;
    private svnClient: SVNClient;
    private currentFile: TFile | null = null;
    private currentViewedRevision: string | null = null;
    
    // UI Controller for data management
    private uiController: SVNUIController;
    private unsubscribeUI: (() => void) | null = null;
    
    // Component instances
    private toolbar: SVNToolbar;
    private fileActions: SVNFileActions;
    private statusDisplay: SVNStatusDisplay;
    private historyRenderer: SVNHistoryRenderer;
    private infoPanel: SVNInfoPanel;
    private fileStateRenderer: SVNFileStateRenderer;
    private repositoryHandler: SVNRepositoryHandler;
    
    // UI Elements with persistent references
    private infoPanelElement: HTMLElement | null = null;
    private toolbarContainer: HTMLElement | null = null;
    private statusContainer: HTMLElement | null = null;
    private contentArea: HTMLElement | null = null;
    private isInitialized = false;    // State tracking for intelligent updates
    private lastDataHash: string | null = null;
    private lastFileId: string | null = null;
    private lastStatusHash: string | null = null;
    private lastContentType: string | null = null;
    private lastHistoryHash: string | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: ObsidianSvnPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.svnClient = plugin.svnClient;
        
        // Initialize UI controller
        this.uiController = new SVNUIController(plugin, this.svnClient);
        
        // Initialize components with simpler refresh callback
        this.fileActions = new SVNFileActions(plugin, this.svnClient, () => this.refreshData());
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
        // Initialize base DOM structure once
        this.initializeLayout();
        
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

    /**
     * Initialize the persistent DOM layout structure
     */
    private initializeLayout(): void {
        if (this.isInitialized) return;
        
        this.containerEl.empty();
        
        // Create persistent container structure
        this.toolbarContainer = this.containerEl.createEl('div', { cls: 'nav-header' });
        
        this.infoPanelElement = this.containerEl.createEl('div', { cls: 'svn-info-panel' });
        this.infoPanelElement.style.display = 'none';
        this.infoPanel.setPanelElement(this.infoPanelElement);
        this.fileActions.setInfoPanel(this.infoPanelElement);
        
        this.statusContainer = this.containerEl.createEl('div', { cls: 'svn-status-display' });
        this.contentArea = this.containerEl.createEl('div', { cls: 'svn-history-content' });
        
        this.isInitialized = true;
    }

    private async updateCurrentFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile !== this.currentFile) {
            this.currentFile = activeFile;
            await this.uiController.setCurrentFile(activeFile);
        }
    }    private handleUIStateChange(state: UIState): void {
        console.log('[SVN FileHistoryView] UI State Change:', {
            isLoading: state.isLoading,
            showLoading: state.showLoading,
            hasData: !!state.data,
            error: state.error,
            timestamp: new Date().toISOString()
        });
        
        // Calculate state hash for intelligent updates
        const currentDataHash = this.calculateStateHash(state);
        const currentFileId = this.currentFile?.path || null;
        
        // Only update if file changed or data significantly changed
        const fileChanged = currentFileId !== this.lastFileId;
        const dataChanged = currentDataHash !== this.lastDataHash;
        
        console.log('[SVN FileHistoryView] Change Analysis:', {
            fileChanged,
            dataChanged,
            currentFileId,
            lastFileId: this.lastFileId,
            currentDataHash: currentDataHash.substring(0, 50) + '...',
            lastDataHash: this.lastDataHash?.substring(0, 50) + '...'
        });
        
        if (fileChanged || dataChanged) {
            console.log('[SVN FileHistoryView] Triggering UI update');
            this.updateViewIntelligently(state, fileChanged, dataChanged);
            this.lastDataHash = currentDataHash;
            this.lastFileId = currentFileId;
        } else {
            console.log('[SVN FileHistoryView] Skipping UI update - no significant changes');
        }
    }

    /**
     * Calculate a hash of the current state for change detection
     */
    private calculateStateHash(state: UIState): string {
        const hashData = {
            isLoading: state.isLoading,
            showLoading: state.showLoading,
            error: state.error,
            isWorkingCopy: state.data?.isWorkingCopy,
            isFileInSvn: state.data?.isFileInSvn,
            revision: state.data?.info?.revision,
            statusCount: state.data?.status?.length || 0,
            historyCount: state.data?.history?.length || 0,
            lastHistoryRevision: state.data?.history?.[0]?.revision
        };
        return JSON.stringify(hashData);
    }    /**
     * Intelligently update only what has changed
     */
    private updateViewIntelligently(state: UIState, fileChanged: boolean, dataChanged: boolean): void {
        console.log('[SVN FileHistoryView] updateViewIntelligently:', { fileChanged, dataChanged });
        
        // Ensure layout is initialized
        this.initializeLayout();
        
        // Always update toolbar on file change
        if (fileChanged) {
            console.log('[SVN FileHistoryView] Updating toolbar due to file change');
            this.updateToolbar();
        }
        
        // Update status display when data changes
        if (dataChanged) {
            console.log('[SVN FileHistoryView] Updating status display due to data change');
            this.updateStatusDisplay(state);
        }
        
        // Update content area when file or data changes
        if (fileChanged || dataChanged) {
            console.log('[SVN FileHistoryView] Updating content area');
            this.updateContentArea(state);
        }
    }

    /**
     * Update toolbar section only
     */
    private updateToolbar(): void {
        console.log('[SVN FileHistoryView] updateToolbar called');
        if (this.toolbarContainer) {
            this.toolbarContainer.empty();
            this.toolbar.render(this.toolbarContainer, this.currentFile);
        }
    }    /**
     * Update status display section only
     */
    private updateStatusDisplay(state: UIState): void {
        if (!this.statusContainer) return;
        
        // Preserve existing status during loading states to avoid flicker
        if (state.showLoading && this.lastStatusHash && this.lastStatusHash !== 'no-data') {
            console.log('[SVN FileHistoryView] Preserving status during loading - avoiding flicker');
            return;
        }
        
        // Calculate status hash to avoid unnecessary rebuilds
        const currentStatusHash = this.calculateStatusHash(state);
        console.log('[SVN FileHistoryView] Status hash check:', {
            current: currentStatusHash.substring(0, 30) + '...',
            last: this.lastStatusHash?.substring(0, 30) + '...',
            same: currentStatusHash === this.lastStatusHash,
            showLoading: state.showLoading
        });
        
        if (currentStatusHash === this.lastStatusHash) {
            console.log('[SVN FileHistoryView] Skipping status update - no changes');
            return; // Status hasn't changed, no need to rebuild
        }
        
        console.log('[SVN FileHistoryView] Rebuilding status display');
        this.statusContainer.empty();
        if (state.data && !state.showLoading) {
            this.renderStatusWithData(this.statusContainer, state.data);
        } else if (this.currentFile) {
            this.statusDisplay.render(this.statusContainer, this.currentFile);
        }
        
        // Only update the hash if we're not in a loading state (to preserve it for the check above)
        if (!state.showLoading) {
            this.lastStatusHash = currentStatusHash;
        }
    }/**
     * Calculate hash for status display to detect changes
     */
    private calculateStatusHash(state: UIState): string {
        // During loading states, return a stable hash to avoid rebuilds
        if (state.showLoading) {
            return `loading-${this.currentFile?.path || 'no-file'}`;
        }
        
        if (!state.data) return 'no-data';
        
        const statusData = {
            isWorkingCopy: state.data.isWorkingCopy,
            revision: state.data.info?.revision,
            author: state.data.info?.lastChangedAuthor,
            date: state.data.info?.lastChangedDate,
            fileStatus: state.data.status.find(item => 
                item.filePath.includes(this.currentFile?.name || '') || 
                item.filePath.endsWith(this.currentFile?.path || '')
            )?.status
        };
        
        return JSON.stringify(statusData);
    }/**
     * Update content area section only  
     */    private updateContentArea(state: UIState): void {
        if (!this.contentArea) return;
        
        // Determine content type for intelligent updates
        const contentType = this.getContentType(state);
        const historyChanged = contentType === 'history' && this.hasHistoryChanged(state);
        
        // Radical anti-flicker approach: Never rebuild content area for loading states
        // Keep existing content visible during brief loading operations
        let shouldRebuild = false;
        
        if (state.showLoading) {
            // We're in a visible loading state
            // Only rebuild if we have no existing content or we're switching from error/no-file states
            const hasExistingContent = this.lastContentType === 'history' || 
                                     this.lastContentType === 'added-not-committed' ||
                                     this.lastContentType === 'not-in-svn';
            
            if (!hasExistingContent) {
                shouldRebuild = true;
            }
            // If we have existing content, keep it visible during loading
        } else {
            // We're not in loading state - this is real content
            if (this.lastContentType === 'loading') {
                // We're transitioning from loading - always rebuild to show final content
                shouldRebuild = true;
            } else if (contentType !== this.lastContentType) {
                // Content type changed (not loading related)
                shouldRebuild = true;
            } else if (contentType === 'history' && historyChanged) {
                // History content actually changed
                shouldRebuild = true;
            }
        }
        
        console.log('[SVN FileHistoryView] Content area check:', {
            contentType,
            lastContentType: this.lastContentType,
            historyChanged,
            isLoading: state.showLoading,
            shouldRebuild,
            hasExistingContent: this.lastContentType === 'history' || this.lastContentType === 'added-not-committed' || this.lastContentType === 'not-in-svn'
        });
        
        // Only rebuild if necessary
        if (shouldRebuild) {
            console.log('[SVN FileHistoryView] Rebuilding content area');
            this.contentArea.empty();
            this.renderContentWithState(this.contentArea, state);
        } else {
            console.log('[SVN FileHistoryView] Skipping content area update - preserving existing content');
        }
        
        // Update content type tracking - but don't update to 'loading' if we have existing content
        if (!state.showLoading || this.lastContentType === null || this.lastContentType === 'no-file' || this.lastContentType === 'error') {
            this.lastContentType = contentType;
        }
        // If we're loading and have existing content, don't update lastContentType - keep the existing type
    }

    /**
     * Determine the type of content being displayed
     */
    private getContentType(state: UIState): string {
        if (state.showLoading) return 'loading';
        if (state.error) return 'error';
        if (!state.data || !this.currentFile) return 'no-file';
        
        const data = state.data;
        if (!data.isWorkingCopy) return 'repository-setup';
        if (!data.isFileInSvn) return 'not-in-svn';
        
        const isAddedNotCommitted = data.status.some(s => s.status === 'A');
        if (isAddedNotCommitted) return 'added-not-committed';
        
        if (data.history.length === 0) return 'no-history';
        return 'history';
    }    /**
     * Check if history data has meaningfully changed
     */
    private hasHistoryChanged(state: UIState): boolean {
        if (!state.data) {
            console.log('[SVN FileHistoryView] History change check: no data, assuming changed');
            return true;
        }
        
        const historyData = {
            count: state.data.history.length,
            firstRevision: state.data.history[0]?.revision,
            lastRevision: state.data.history[state.data.history.length - 1]?.revision,
            // Include first few revision numbers to detect reordering
            revisions: state.data.history.slice(0, 5).map(h => h.revision).join(',')
        };
        
        const currentHistoryHash = JSON.stringify(historyData);
        const changed = currentHistoryHash !== this.lastHistoryHash;
        
        console.log('[SVN FileHistoryView] History change check:', {
            current: currentHistoryHash,
            last: this.lastHistoryHash || 'none',
            changed,
            historyCount: state.data.history.length
        });
        
        // Only update the stored hash if we're not in loading state
        // This prevents the hash from being updated during temporary loading states
        if (!state.showLoading) {
            this.lastHistoryHash = currentHistoryHash;
        }
        
        return changed;
    }/**
     * Legacy method - now replaced by intelligent updates
     */
    private renderViewWithState(state: UIState): void {
        // This method is now deprecated in favor of intelligent updates
        this.updateViewIntelligently(state, true, true);
    }private renderStatusWithData(container: HTMLElement, data: SVNFileData): void {
        // Create status display with loaded data
        container.empty();
        
        if (!data.isWorkingCopy) {
            container.createEl('span', { 
                text: 'Not in SVN working copy',
                cls: 'svn-status-text svn-status-warning'
            });
            return;
        }

        // Create status container with comprehensive revision info
        const statusContainer = container.createEl('div', { cls: 'svn-status-container' });
        
        // Show current revision with full details
        if (data.info && data.info.revision) {
            const revisionEl = statusContainer.createEl('span', { 
                cls: 'svn-status-revision'
            });
            
            // Revision number with badge styling
            revisionEl.createEl('span', { 
                text: 'r' + data.info.revision,
                cls: 'svn-revision-badge'
            });
            
            // Author information
            if (data.info.lastChangedAuthor) {
                revisionEl.createEl('span', {
                    text: ' by ' + data.info.lastChangedAuthor,
                    cls: 'svn-revision-author'
                });
            }
            
            // Date information
            if (data.info.lastChangedDate) {
                const date = new Date(data.info.lastChangedDate).toLocaleDateString();
                revisionEl.createEl('span', {
                    text: ' on ' + date,
                    cls: 'svn-revision-date'
                });
            }
        }
        
        // Show file modification status
        const statusTextEl = statusContainer.createEl('span', { cls: 'svn-status-text' });
        
        if (!data.status || data.status.length === 0) {
            statusTextEl.setText('Up to date');
            statusTextEl.addClass('svn-status-clean');
        } else {
            // Find status for current file
            const fileStatus = data.status.find(item => 
                item.filePath.includes(this.currentFile?.name || '') || 
                item.filePath.endsWith(this.currentFile?.path || '')
            );
            
            if (!fileStatus) {
                statusTextEl.setText('Up to date');
                statusTextEl.addClass('svn-status-clean');
            } else {
                const statusCode = fileStatus.status.charAt(0);
                
                switch (statusCode) {
                    case 'M':
                        statusTextEl.setText('Modified');
                        statusTextEl.addClass('svn-status-modified');
                        break;
                    case 'A':
                        statusTextEl.setText('Added');
                        statusTextEl.addClass('svn-status-added');
                        break;
                    case 'D':
                        statusTextEl.setText('Deleted');
                        statusTextEl.addClass('svn-status-deleted');
                        break;
                    case '?':
                        statusTextEl.setText('Not tracked');
                        statusTextEl.addClass('svn-status-untracked');
                        break;
                    case 'C':
                        statusTextEl.setText('Conflicted');
                        statusTextEl.addClass('svn-status-error');
                        break;
                    default:
                        statusTextEl.setText('Up to date');
                        statusTextEl.addClass('svn-status-clean');
                }
            }
        }
    }

    private renderContentWithState(container: HTMLElement, state: UIState): void {
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

        if (!state.data || !this.currentFile) {
            container.createEl('p', { 
                text: 'No file selected',
                cls: 'svn-no-file'
            });
            return;
        }

        const data = state.data;

        // Handle different file states based on loaded data
        if (!data.isWorkingCopy) {
            this.repositoryHandler.renderRepositorySetup(container, this.currentFile);
            return;
        }

        if (!data.isFileInSvn) {
            this.fileStateRenderer.renderNotInSvn(container, this.currentFile);
            return;
        }

        // Check if file is added but not committed
        const isAddedNotCommitted = data.status.some(s => s.status === 'A');
        if (isAddedNotCommitted) {
            this.fileStateRenderer.renderAddedButNotCommitted(container, this.currentFile);
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

        this.renderHistoryWithData(container, data);
    }

    private renderHistoryWithData(container: HTMLElement, data: SVNFileData): void {
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
                this.createHistoryItem(historyList, entry, index, data.history);
            });
        } else {
            // Reuse existing structure, just update action buttons efficiently
            data.history.forEach((entry, index) => {
                const existingItem = existingItems[index] as HTMLElement;
                if (existingItem) {
                    this.updateHistoryItemActions(existingItem, entry, index, data.history);
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
    private updateHistoryItemActions(historyItem: HTMLElement, entry: any, index: number, fullHistory: any[]): void {
        const actionsEl = historyItem.querySelector('.svn-history-actions') as HTMLElement;
        if (actionsEl) {
            // Only update if actions container exists and we have the file
            if (this.currentFile) {
                actionsEl.empty();
                this.historyRenderer.addHistoryItemActions(actionsEl, this.currentFile.path, entry, index, fullHistory);
            }
        }
    }

    /**
     * Create a single history item
     */
    private createHistoryItem(historyList: HTMLElement, entry: any, index: number, fullHistory: any[]): void {
        const listItem = historyList.createEl('li', { cls: 'svn-history-item' });
        
        // Create main content container
        const contentEl = listItem.createEl('div', { cls: 'svn-history-content' });
        
        // Create header with revision info
        const headerEl = contentEl.createEl('div', { cls: 'svn-history-header' });
        headerEl.createEl('span', { 
            text: `r${entry.revision}`,
            cls: 'svn-revision'
        });
        headerEl.createEl('span', { 
            text: entry.author,
            cls: 'svn-author'
        });
        headerEl.createEl('span', { 
            text: new Date(entry.date).toLocaleString(),
            cls: 'svn-date'
        });

        // Add commit message
        if (entry.message) {
            const messageEl = contentEl.createEl('div', { cls: 'svn-message' });
            messageEl.setText(entry.message);
        }

        // Add action buttons
        const actionsEl = listItem.createEl('div', { cls: 'svn-history-actions' });
        this.historyRenderer.addHistoryItemActions(actionsEl, this.currentFile!.path, entry, index, fullHistory);
    }

    /**
     * Refresh data (used by components)
     */
    async refreshData(): Promise<void> {
        const stack = new Error().stack;
        console.log('[SVN FileHistoryView] refreshData called from:', {
            caller: stack?.split('\n')[2]?.trim(),
            timestamp: new Date().toISOString(),
            currentFile: this.currentFile?.path
        });
        await this.uiController.refreshCurrentFile();
    }

    async refreshView() {
        // Legacy method for backward compatibility
        await this.refreshData();
    }

    async refreshStatus() {
        // For status-only refreshes (like file modifications), use lightweight update
        console.log('[SVN FileHistoryView] refreshStatus called - using lightweight status update');
        
        if (!this.currentFile) return;
        
        // Use the lightweight update method that only fetches and updates status
        await this.updateFileStatus();
    }

    private showRepositorySetup(): void {
        if (!this.currentFile) return;
        
        const contentEl = this.containerEl.querySelector('.svn-history-content') as HTMLElement;
        if (contentEl) {
            this.repositoryHandler.renderRepositorySetup(contentEl, this.currentFile);
        }
    }
    
    async onClose() {
        // Clean up subscriptions
        if (this.unsubscribeUI) {
            this.unsubscribeUI();
            this.unsubscribeUI = null;
        }
        
        // Dispose UI controller
        this.uiController.dispose();
        
        // Reset state tracking
        this.resetStateTracking();
    }

    /**
     * Reset all state tracking for clean slate
     */
    private resetStateTracking(): void {
        this.lastDataHash = null;
        this.lastFileId = null;
        this.lastStatusHash = null;
        this.lastContentType = null;
        this.isInitialized = false;
    }

    // Methods for tracking viewed revision
    setCurrentViewedRevision(revision: string | null): void {
        this.currentViewedRevision = revision;
    }
    
    getCurrentViewedRevision(): string | null {
        return this.currentViewedRevision;
    }
    
    // Reset to working copy revision (null means working copy)
    resetToWorkingCopy(): void {
        this.currentViewedRevision = null;
    }

    /**
     * Lightweight status-only update for file modifications
     * This bypasses the full data loading and cache to provide immediate status updates
     */
    async updateFileStatus(): Promise<void> {
        if (!this.currentFile || !this.statusContainer) return;
        
        console.log('[SVN FileHistoryView] Performing lightweight status update for:', this.currentFile.path);
        
        try {
            // Get fresh status data without cache
            const statusData = await this.getStatusDataWithRetry();
            
            // Update only the status display
            this.statusContainer.empty();
            this.renderStatusWithData(this.statusContainer, statusData as any);
            
            // Update the status hash to reflect the new status
            const newStatusHash = this.calculateStatusHashFromData(statusData);
            const statusChanged = this.lastStatusHash !== newStatusHash;
            this.lastStatusHash = newStatusHash;
            
            console.log('[SVN FileHistoryView] Status updated successfully, changed:', statusChanged);
            
        } catch (error) {
            console.error('[SVN FileHistoryView] Failed to update status:', error);
            // Fall back to showing basic status
            if (this.currentFile) {
                this.statusDisplay.render(this.statusContainer, this.currentFile);
            }
        }
    }    /**
     * Get status data with smart retry logic to handle file reversions
     * Detects when files are changed back to their original state
     */
    private async getStatusDataWithRetry(maxRetries: number = 3): Promise<any> {
        const currentHash = this.lastStatusHash;
        let lastStatusData: any = null;
        
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Add progressively longer delays for retry attempts
            if (attempt > 0) {
                const delay = attempt === 1 ? 300 : 600; // 300ms, then 600ms
                console.log(`[SVN FileHistoryView] Retry attempt ${attempt} for status check (${delay}ms delay)`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            
            const [isWorkingCopy, statusResult, infoResult] = await Promise.all([
                this.svnClient.isWorkingCopy(this.currentFile!.path),
                this.svnClient.getStatus(this.currentFile!.path).catch(() => []),
                this.svnClient.getInfo(this.currentFile!.path).catch(() => null)
            ]);
            
            const statusData = {
                isWorkingCopy,
                status: Array.isArray(statusResult) ? statusResult : [],
                info: infoResult
            };
            
            const newHash = this.calculateStatusHashFromData(statusData);
            const isModified = this.isFileModifiedFromStatus(statusData);
            
            console.log(`[SVN FileHistoryView] Attempt ${attempt}: modified=${isModified}, hash=${newHash.substring(0, 20)}...`);
            
            // Store the data from this attempt
            lastStatusData = statusData;
            
            // On first attempt, if file appears modified, continue to retry
            if (attempt === 0 && isModified) {
                console.log('[SVN FileHistoryView] File appears modified, will retry to check for reversion');
                continue;
            }
            
            // If this is a retry and the status changed from the original, we found the update
            if (attempt > 0 && newHash !== currentHash) {
                console.log(`[SVN FileHistoryView] Status change detected on retry ${attempt}`);
                return statusData;
            }
            
            // If we're on the last retry, return what we got
            if (attempt === maxRetries) {
                console.log(`[SVN FileHistoryView] Final attempt ${attempt}, returning current status`);
                return statusData;
            }
            
            // For middle attempts, if status hasn't changed and file is not modified, we can return early
            if (attempt > 0 && !isModified) {
                console.log(`[SVN FileHistoryView] File no longer modified on attempt ${attempt}, returning status`);
                return statusData;
            }
        }
        
        // Fallback - return the last data we got
        return lastStatusData || {
            isWorkingCopy: false,
            status: [],
            info: null
        };
    }

    /**
     * Check if file appears modified based on status data
     */
    private isFileModifiedFromStatus(statusData: any): boolean {
        if (!statusData.isWorkingCopy || !Array.isArray(statusData.status)) {
            return false;
        }
        
        // Check if any status indicates modification
        return statusData.status.some((item: any) => 
            item.status && (item.status.includes('M') || item.status.includes('A') || item.status.includes('D'))
        );
    }
    
    /**
     * Calculate status hash from raw data (for direct status updates)
     */
    private calculateStatusHashFromData(data: { isWorkingCopy: boolean, status: any[], info: any }): string {
        const statusData = {
            isWorkingCopy: data.isWorkingCopy,
            revision: data.info?.revision,
            author: data.info?.lastChangedAuthor,
            date: data.info?.lastChangedDate,
            fileStatus: data.status.find(item => 
                item.filePath.includes(this.currentFile?.name || '') || 
                item.filePath.endsWith(this.currentFile?.path || '')
            )?.status
        };
        
        return JSON.stringify(statusData);
    }
}