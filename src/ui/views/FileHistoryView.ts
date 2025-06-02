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
    private isDirectStatusUpdate = false;
    private lastDirectStatusUpdateTime = 0;
    private allowNextUIStateUpdate = false;
    // Store the last direct status data to override stale state data
    private lastDirectStatusData: { isWorkingCopy: boolean; status: any[]; info: any | null } | null = null;
    private suppressNextUIStateChange = false;

    constructor(leaf: WorkspaceLeaf, plugin: ObsidianSvnPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.svnClient = plugin.svnClient;
        
        // Initialize UI controller
        this.uiController = new SVNUIController(plugin, this.svnClient);
          // Initialize components with simpler refresh callback
        // Use refreshStatus for file actions (faster, status-only updates after file operations)
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
    }
    private async handleUIStateChange(state: UIState): Promise<void> {
        // Override state data status with recent direct status if within protection window
        const protectionWindowMs = 5000;
        if (this.lastDirectStatusData && Date.now() - this.lastDirectStatusUpdateTime < protectionWindowMs && state.data) {
            console.log('[SVN FileHistoryView] Overriding state data.status with direct status override');
            state.data.status = this.lastDirectStatusData.status as any;
            state.data.hasLocalChanges = this.lastDirectStatusData.status.some((s: any) => s.status === 'M' || s.status === 'A' || s.status === 'D');
        }
        console.log('[SVN FileHistoryView] UI State Change:', {
            isLoading: state.isLoading,
            showLoading: state.showLoading,
            hasData: !!state.data,
            error: state.error,
            timestamp: new Date().toISOString()
        });
        
        // Override stale state data with direct status data if applicable
        if (this.lastDirectStatusData && state.data && Array.isArray(state.data.status) && state.data.status.length === 0) {
            const timeSinceDirect = Date.now() - this.lastDirectStatusUpdateTime;
            if (timeSinceDirect < 5000) {
                console.log('[SVN FileHistoryView] Overriding stale state data with direct status data:', {
                    timeSinceDirect: timeSinceDirect + 'ms',
                    overrideCount: this.lastDirectStatusData.status.length
                });
                state.data = {
                    ...state.data,
                    isWorkingCopy: this.lastDirectStatusData.isWorkingCopy,
                    status: this.lastDirectStatusData.status,
                    info: this.lastDirectStatusData.info || state.data.info,
                    hasLocalChanges: this.lastDirectStatusData.status.some((s: any) => s.status === 'M' || s.status === 'A' || s.status === 'D')
                } as any;
            }
        }
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
            await this.updateViewIntelligently(state, fileChanged, dataChanged);
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
    private async updateViewIntelligently(state: UIState, fileChanged: boolean, dataChanged: boolean): Promise<void> {
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
            await this.updateStatusDisplay(state);
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
    private async updateStatusDisplay(state: UIState): Promise<void> {
        if (!this.statusContainer) return;
        // If we have fresh direct status data, override and render immediately
        const protectionWindowMs = 5000;
        if (this.lastDirectStatusData && Date.now() - this.lastDirectStatusUpdateTime < protectionWindowMs) {
            console.log('[SVN FileHistoryView] Rendering direct status override:', this.lastDirectStatusData.status.length);
            this.statusContainer.empty();
            this.renderStatusWithData(this.statusContainer, this.lastDirectStatusData as any);
            return;
        }
        
        // Skip hash comparison during direct status updates to avoid conflicts
        if (this.isDirectStatusUpdate) {
            console.log('[SVN FileHistoryView] Skipping UI state status update - direct update in progress');
            return;
        }
        
        // Check if we should proactively run a direct status update
        // This helps prevent showing stale "Up to date" when the file is actually modified
        if (state.data && state.data.status && state.data.status.length === 0 && this.currentFile) {
            const timeSinceDirectUpdate = Date.now() - this.lastDirectStatusUpdateTime;
            // If we haven't done a direct update recently and the data shows no status items,
            // but the file might actually be modified, do a quick direct status check
            if (timeSinceDirectUpdate > 3000) { // 3 seconds cooldown
                console.log('[SVN FileHistoryView] Data shows no status items - performing proactive status check');
                // Run direct status update asynchronously to get real-time status
                this.updateFileStatusDirect().catch(error => {
                    console.error('[SVN FileHistoryView] Proactive status check failed:', error);
                });
                // Continue with current update but note that a fresh check is running
            }
        }
        // Skip or override stale state updates if a direct status update happened recently
        const timeSinceDirectUpdate = Date.now() - this.lastDirectStatusUpdateTime;
        if (this.lastDirectStatusData && timeSinceDirectUpdate < 5000) {
            // Render direct status override
            console.log('[SVN FileHistoryView] Overriding status display with direct status data:', {
                timeSinceDirectUpdate: timeSinceDirectUpdate + 'ms',
                statusCount: this.lastDirectStatusData.status.length
            });
            this.statusContainer.empty();
            this.renderStatusWithData(this.statusContainer, this.lastDirectStatusData as any);
            // Do not clear direct status data here; let it persist for the window
            return;
        }
        // If allowedNextUIStateUpdate is false, skip stale state updates
        if (timeSinceDirectUpdate < 5000 && !this.allowNextUIStateUpdate) {
            console.log('[SVN FileHistoryView] Skipping UI state status update - recent direct update and no override:', {
                timeSinceDirectUpdate: timeSinceDirectUpdate + 'ms',
                allowNextUpdate: this.allowNextUIStateUpdate
            });
            return;
        }
          // Always use direct status for actual status information instead of potentially stale UI state data
        if (!state.isLoading && !state.showLoading && this.currentFile) {
            console.log('[SVN FileHistoryView] Using direct status check instead of UI state data to ensure accuracy');
            // Clear the allow flag since we're bypassing UI state data
            this.allowNextUIStateUpdate = false;
            // Use direct status update for accurate, real-time status (non-blocking)
            this.updateFileStatusDirect().catch(error => {
                console.error('[SVN FileHistoryView] Error in direct status update:', error);
            });
            return;
        }
        
        // Clear the allow flag after first use
        if (this.allowNextUIStateUpdate) {
            console.log('[SVN FileHistoryView] Allowing UI state update after direct status change');
            this.allowNextUIStateUpdate = false;
        }
        
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
        
        // Find the current file's specific status
        const currentFileStatus = state.data.status.find(item => 
            item.filePath.includes(this.currentFile?.name || '') || 
            item.filePath.endsWith(this.currentFile?.path || '')
        );
        
        const statusData = {
            isWorkingCopy: state.data.isWorkingCopy,
            revision: state.data.info?.revision,
            author: state.data.info?.lastChangedAuthor,
            date: state.data.info?.lastChangedDate,
            // Include file path to make hash more specific
            filePath: this.currentFile?.path,
            // Include the complete status information
            fileStatus: currentFileStatus?.status,
            fileStatusPath: currentFileStatus?.filePath,
            // Include total count and summary for better change detection
            totalStatusItems: state.data.status.length,
            hasModifications: state.data.status.some((item: any) => {
                return item.status && typeof item.status === 'string' && (
                    item.status.includes('M') || 
                    item.status.includes('A') || 
                    item.status.includes('D')
                );
            }),
            // Add a timestamp factor to ensure freshness when direct updates occur
            timeSinceDirectUpdate: Date.now() - this.lastDirectStatusUpdateTime
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
    }
    
    /**
     * Legacy method - now replaced by intelligent updates
     */
    private renderViewWithState(state: UIState): void {
        // This method is now deprecated in favor of intelligent updates
        this.updateViewIntelligently(state, true, true);
    }
    
    private renderStatusWithData(container: HTMLElement, data: SVNFileData): void {
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
        
        // Debug logging to see what status data we have
        console.log('[SVN FileHistoryView] Rendering status with data:', {
            statusCount: data.status?.length || 0,
            statusItems: data.status?.map(item => ({ path: item.filePath, status: item.status })) || [],
            currentFile: this.currentFile?.path
        });
        
        if (!data.status || data.status.length === 0) {
            console.log('[SVN FileHistoryView] No status items - showing "Up to date"');
            statusTextEl.setText('Up to date');
            statusTextEl.addClass('svn-status-clean');
        } else {
            // Find status for current file
            const fileStatus = data.status.find(item => 
                item.filePath.includes(this.currentFile?.name || '') || 
                item.filePath.endsWith(this.currentFile?.path || '')
            );
            
            console.log('[SVN FileHistoryView] File status search result:', {
                found: !!fileStatus,
                fileStatus: fileStatus || 'none',
                searchTerms: {
                    name: this.currentFile?.name,
                    path: this.currentFile?.path
                }
            });
            
            if (!fileStatus) {
                console.log('[SVN FileHistoryView] No matching file status - showing "Up to date"');
                statusTextEl.setText('Up to date');
                statusTextEl.addClass('svn-status-clean');            } else {
                const statusCode = fileStatus.status.charAt(0);
                console.log('[SVN FileHistoryView] Found file status:', {
                    fullStatus: fileStatus.status,
                    statusCode: statusCode,
                    filePath: fileStatus.filePath
                });
                  switch (statusCode) {
                    case 'M':
                        statusTextEl.setText('Modified');
                        statusTextEl.addClass('svn-status-modified');
                        
                        // Add a small hint if we know this is whitespace-only changes
                        // Note: This would require storing the change analysis result
                        // For now, just show the standard "Modified" status
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
    }    async refreshStatus() {
        // For status-only refreshes (like file modifications), use lightweight update
        console.log('[SVN FileHistoryView] refreshStatus called - using direct status update');
        
        if (!this.currentFile) return;
        
        // Use direct status update without retry logic for better performance
        await this.updateFileStatusDirect();
    }    /**
     * Direct status update without retry logic - for simple refreshes
     */
    async updateFileStatusDirect(): Promise<void> {
        if (!this.currentFile || !this.statusContainer) return;
        
        console.log('[SVN FileHistoryView] Performing direct status update for:', this.currentFile.path);
        
        try {
            // Set flag to indicate we're doing a direct update
            this.isDirectStatusUpdate = true;
            
            // Get fresh status data directly without retry logic
            const [isWorkingCopy, statusResult, infoResult] = await Promise.all([
                this.svnClient.isWorkingCopy(this.currentFile.path),
                this.svnClient.getStatus(this.currentFile.path).catch(() => []),
                this.svnClient.getInfo(this.currentFile.path).catch(() => null)
            ]);
            
            // Debug: Log the raw SVN status result
            console.log('[SVN FileHistoryView] Raw SVN status result:', {
                statusResult,
                statusCount: Array.isArray(statusResult) ? statusResult.length : 0,
                currentFile: this.currentFile.path
            });
              // If we have status items, check if there are actual differences
            if (Array.isArray(statusResult) && statusResult.length > 0) {
                const modifiedItem = statusResult.find((item: any) => {
                    if (!item.status || typeof item.status !== 'string') return false;
                    if (!item.status.includes('M')) return false;
                    return item.filePath.includes(this.currentFile!.name) || 
                           item.filePath.endsWith(this.currentFile!.path);
                });
                
                if (modifiedItem) {
                    try {
                        const diff = await this.svnClient.getDiff(this.currentFile.path);
                        const hasActualChanges = diff.trim().length > 0;
                        
                        // Analyze the type of changes
                        const changeAnalysis = this.analyzeDiffChanges(diff);
                        console.log('[SVN FileHistoryView] File shows as modified - checking diff:', {
                            filePath: this.currentFile.path,
                            diffLength: diff.length,
                            diffContent: diff.substring(0, 200) + (diff.length > 200 ? '...' : ''),
                            hasActualChanges,
                            changeType: changeAnalysis.type,
                            isWhitespaceOnly: changeAnalysis.isWhitespaceOnly,
                            description: changeAnalysis.description
                        });
                    } catch (error) {
                        console.error('[SVN FileHistoryView] Error getting diff for modified file:', error);
                    }
                }
            }
            
            const statusData = {
                isWorkingCopy,
                status: Array.isArray(statusResult) ? statusResult : [],
                info: infoResult
            };
            
            // Update only the status display
            this.statusContainer.empty();
            this.renderStatusWithData(this.statusContainer, statusData as any);
              // Update the status hash to reflect the new status
            const newStatusHash = this.calculateStatusHashFromData(statusData);
            const statusChanged = this.lastStatusHash !== newStatusHash;
            
            console.log('[SVN FileHistoryView] Direct status updated successfully, changed:', statusChanged);
            console.log('[SVN FileHistoryView] Status hash comparison:', {
                oldHash: this.lastStatusHash?.substring(0, 100) + '...',
                newHash: newStatusHash.substring(0, 100) + '...',
                changed: statusChanged
            });
            
            // Always update the status hash after successful update
            this.lastStatusHash = newStatusHash;            // Record the timestamp of this direct update
            this.lastDirectStatusUpdateTime = Date.now();
            
            // Only handle direct status override if status changed
            if (statusChanged) {
                console.log('[SVN FileHistoryView] Status changed - storing direct status data');
                // Store direct status data for future override
                this.lastDirectStatusData = statusData;
                // Allow the UI to show direct status for a short period
                this.lastDirectStatusUpdateTime = Date.now();
            }
            
        } catch (error) {
            console.error('[SVN FileHistoryView] Failed to update status directly:', error);
            // Fall back to showing basic status
            if (this.currentFile) {
                this.statusDisplay.render(this.statusContainer, this.currentFile);
            }
        } finally {
            // Clear the flag
            this.isDirectStatusUpdate = false;
        }
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
    }    /**
     * Lightweight status-only update for file modifications
     * This bypasses the full data loading and cache to provide immediate status updates
     * Uses retry logic only when there's evidence of potential reversion
     */
    async updateFileStatus(): Promise<void> {
        if (!this.currentFile || !this.statusContainer) return;
        
        console.log('[SVN FileHistoryView] Performing lightweight status update for:', this.currentFile.path);
        
        try {
            // First try a direct status check
            const [isWorkingCopy, statusResult, infoResult] = await Promise.all([
                this.svnClient.isWorkingCopy(this.currentFile.path),
                this.svnClient.getStatus(this.currentFile.path).catch(() => []),
                this.svnClient.getInfo(this.currentFile.path).catch(() => null)
            ]);
            
            const statusData = {
                isWorkingCopy,
                status: Array.isArray(statusResult) ? statusResult : [],
                info: infoResult
            };
            
            const newStatusHash = this.calculateStatusHashFromData(statusData);
            const isModified = await this.isFileModifiedFromStatus(statusData);
            
            // Only use retry logic if:
            // 1. File appears modified AND
            // 2. Status hash suggests a recent change AND
            // 3. We have a previous status hash to compare against
            const shouldUseRetryLogic = isModified && 
                                       this.lastStatusHash && 
                                       newStatusHash !== this.lastStatusHash &&
                                       this.lastStatusHash !== 'no-data';
            
            let finalStatusData = statusData;
            if (shouldUseRetryLogic) {
                console.log('[SVN FileHistoryView] Using retry logic due to potential reversion detection');
                finalStatusData = await this.getStatusDataWithRetry();
            } else {
                console.log('[SVN FileHistoryView] Using direct status - no retry needed');
            }
            
            // Update only the status display
            this.statusContainer.empty();
            this.renderStatusWithData(this.statusContainer, finalStatusData as any);
            
            // Update the status hash to reflect the new status
            const finalStatusHash = this.calculateStatusHashFromData(finalStatusData);
            const statusChanged = this.lastStatusHash !== finalStatusHash;
            this.lastStatusHash = finalStatusHash;
            
            console.log('[SVN FileHistoryView] Status updated successfully, changed:', statusChanged);
            
        } catch (error) {
            console.error('[SVN FileHistoryView] Failed to update status:', error);
            // Fall back to showing basic status
            if (this.currentFile) {
                this.statusDisplay.render(this.statusContainer, this.currentFile);
            }
        }
    }/**
     * Get status data with smart retry logic to handle file reversions
     * Only retries when there's evidence of potential reversion (status changed recently)
     */
    private async getStatusDataWithRetry(maxRetries: number = 3): Promise<any> {
        const currentHash = this.lastStatusHash;
        let lastStatusData: any = null;
        let lastDiffLength: number | null = null;
        
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
            const isModified = await this.isFileModifiedFromStatus(statusData);
            
            console.log(`[SVN FileHistoryView] Attempt ${attempt}: modified=${isModified}, hash=${newHash.substring(0, 20)}...`);
            
            // Store the data from this attempt
            lastStatusData = statusData;
            
            // Get current diff length to track changes
            let currentDiffLength: number | null = null;
            if (isModified && this.currentFile) {
                try {
                    const diff = await this.svnClient.getDiff(this.currentFile.path);
                    currentDiffLength = diff.trim().length;
                } catch (error) {
                    console.error('[SVN FileHistoryView] Error getting diff for retry logic:', error);
                }
            }
            
            // On first attempt, only retry if we suspect the file might be in transition
            // (recently reverted or recently modified)
            if (attempt === 0 && isModified && currentHash) {
                // Only retry if the hash suggests a recent change or if we have no previous diff baseline
                const hashChanged = newHash !== currentHash;
                if (hashChanged) {
                    console.log('[SVN FileHistoryView] Status hash changed, will retry to check for stabilization');
                    lastDiffLength = currentDiffLength;
                    continue;
                } else {
                    // File is consistently modified with no recent status change - no need to retry
                    console.log('[SVN FileHistoryView] File consistently modified with stable status, no retry needed');
                    return statusData;
                }
            }
            
            // For retries, check if status or diff length has stabilized
            if (attempt > 0) {
                // If status changed from the original, we found the update
                if (newHash !== currentHash) {
                    console.log(`[SVN FileHistoryView] Status change detected on retry ${attempt}`);
                    return statusData;
                }
                
                // If file is no longer modified, return immediately
                if (!isModified) {
                    console.log(`[SVN FileHistoryView] File no longer modified on attempt ${attempt}, returning status`);
                    return statusData;
                }
                
                // If diff length hasn't changed between attempts, the file is stable
                if (lastDiffLength !== null && currentDiffLength === lastDiffLength) {
                    console.log(`[SVN FileHistoryView] Diff stable across attempts (${currentDiffLength} chars), returning status`);
                    return statusData;
                }
                
                lastDiffLength = currentDiffLength;
            }
            
            // If we're on the last retry, return what we got
            if (attempt === maxRetries) {
                console.log(`[SVN FileHistoryView] Final attempt ${attempt}, returning current status`);
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
     */    private async isFileModifiedFromStatus(statusData: any): Promise<boolean> {
        if (!statusData.isWorkingCopy || !Array.isArray(statusData.status)) {
            return false;
        }
        
        // Check if any status indicates modification
        const hasModifiedStatus = statusData.status.some((item: any) => 
            item.status && (item.status.includes('M') || item.status.includes('A') || item.status.includes('D'))
        );
          // If the status shows modified ('M'), double-check with diff to see if there are actual changes
        if (hasModifiedStatus && this.currentFile) {
            const modifiedItem = statusData.status.find((item: any) => 
                item.status && item.status.includes('M') &&
                (item.filePath.includes(this.currentFile!.name) || 
                 item.filePath.endsWith(this.currentFile!.path))
            );
            
            if (modifiedItem) {
                try {
                    console.log(`[SVN FileHistoryView] Checking diff for potentially reverted file: ${this.currentFile.path}`);
                    const diff = await this.svnClient.getDiff(this.currentFile.path);
                    const hasActualChanges = diff.trim().length > 0;
                    console.log(`[SVN FileHistoryView] Diff check result: hasChanges=${hasActualChanges}, diffLength=${diff.length}`);
                    // If diff is empty, the file was reverted to original content
                    return hasActualChanges;
                } catch (error) {
                    console.error('[SVN FileHistoryView] Error checking diff for modified file:', error);
                    // If we can't get diff, assume there are changes to be safe
                    return true;
                }
            }
        }
        
        return hasModifiedStatus;
    }    /**
     * Calculate status hash from raw data (for direct status updates)
     */    private calculateStatusHashFromData(data: { isWorkingCopy: boolean, status: any[], info: any }): string {
        // More robust file matching - try multiple approaches
        const currentFilePath = this.currentFile?.path || '';
        const currentFileName = this.currentFile?.name || '';
        
        console.log('[SVN FileHistoryView] Looking for file status:', {
            currentFilePath,
            currentFileName,
            availableFiles: data.status.map(item => item.filePath)
        });
        
        // Try different matching strategies
        let currentFileStatus = data.status.find(item => {
            const itemPath = item.filePath;
            return itemPath === currentFilePath || 
                   itemPath.endsWith('/' + currentFileName) ||
                   itemPath.endsWith('\\' + currentFileName) ||
                   itemPath.includes(currentFileName);
        });
        
        // If we still haven't found it, try normalizing paths
        if (!currentFileStatus && currentFilePath) {
            const normalizedPath = currentFilePath.replace(/\\/g, '/');
            currentFileStatus = data.status.find(item => {
                const normalizedItemPath = item.filePath.replace(/\\/g, '/');
                return normalizedItemPath === normalizedPath ||
                       normalizedItemPath.endsWith('/' + currentFileName) ||
                       normalizedPath.endsWith(normalizedItemPath) ||
                       normalizedItemPath.endsWith(normalizedPath);
            });
        }
        
        const statusData = {
            isWorkingCopy: data.isWorkingCopy,
            revision: data.info?.revision,
            author: data.info?.lastChangedAuthor,
            date: data.info?.lastChangedDate,
            // Include file path to make hash more specific and stable
            filePath: currentFilePath,
            // Include the full status object, not just the status string
            fileStatus: currentFileStatus?.status,
            fileStatusPath: currentFileStatus?.filePath,
            // Include any additional status flags
            fileModified: currentFileStatus?.modified,
            fileConflicted: currentFileStatus?.conflicted,
            // Include status array length to detect changes
            totalStatusItems: data.status.length,
            // Include a summary of all status items for better change detection
            allStatuses: data.status.map(item => ({ path: item.filePath, status: item.status })),
            // Add a stability check: hash changes based on actual status content
            statusChecksum: this.calculateStatusChecksum(currentFileStatus, data.status.length)
        };
        
        console.log('[SVN FileHistoryView] Calculating status hash with data:', {
            currentFileStatus: currentFileStatus || 'none',
            totalItems: data.status.length,
            filePath: currentFilePath,
            foundFileStatus: !!currentFileStatus,
            fileStatusString: currentFileStatus?.status,
            statusChecksum: statusData.statusChecksum
        });
        
        const hash = JSON.stringify(statusData);
        console.log('[SVN FileHistoryView] Generated status hash length:', hash.length, 'includes file status:', !!currentFileStatus);
        
        return hash;
    }

    /**
     * Calculate a checksum based on the actual file status to ensure changes are detected
     */
    private calculateStatusChecksum(fileStatus: any, totalItems: number): string {
        if (!fileStatus) {
            return `no-status-${totalItems}`;
        }
        
        // Include key status properties that would change
        const checksumData = {
            status: fileStatus.status,
            path: fileStatus.filePath,
            modified: fileStatus.modified,
            conflicted: fileStatus.conflicted,
            totalItems,
            // Add current time factor to detect real-time changes
            timeSlice: Math.floor(Date.now() / 5000) // 5-second windows
        };
        
        return JSON.stringify(checksumData);
    }

    /**
     * Analyze the type of changes in a diff to determine if they're substantial or just whitespace
     */
    private analyzeDiffChanges(diff: string): { type: string, isWhitespaceOnly: boolean, description: string } {
        console.log('[SVN FileHistoryView] Analyzing diff changes, input length:', diff.length);
        
        if (!diff || diff.trim().length === 0) {
            return { type: 'none', isWhitespaceOnly: false, description: 'No changes' };
        }
        
        // Split diff into lines and analyze changes
        const lines = diff.split('\n');
        const changeLines = lines.filter(line => line.startsWith('+') || line.startsWith('-'));
        
        console.log('[SVN FileHistoryView] Diff analysis:', {
            totalLines: lines.length,
            changeLines: changeLines.length,
            sampleChangeLines: changeLines.slice(0, 5)
        });
        
        if (changeLines.length === 0) {
            return { type: 'metadata', isWhitespaceOnly: false, description: 'Metadata changes only' };
        }
        
        // Analyze the actual content changes
        let hasContentChanges = false;
        let hasWhitespaceChanges = false;
        let hasLineEndingChanges = false;
        
        for (const line of changeLines) {
            if (line.startsWith('+++') || line.startsWith('---')) continue;
            
            const content = line.substring(1); // Remove +/- prefix
            const trimmedContent = content.trim();
            
            if (trimmedContent.length === 0) {
                // This is a whitespace-only or empty line change
                hasWhitespaceChanges = true;
            } else if (content !== trimmedContent) {
                // This line has leading/trailing whitespace changes
                hasWhitespaceChanges = true;
                
                // Check if there's also content changes
                const oppositePrefix = line.startsWith('+') ? '-' : '+';
                const oppositeLine = changeLines.find(l => 
                    l.startsWith(oppositePrefix) && l.substring(1).trim() === trimmedContent
                );
                
                if (!oppositeLine) {
                    hasContentChanges = true;
                }
            } else {
                // This is a real content change
                hasContentChanges = true;
            }
        }
        
        // Detect line ending changes by looking for lines that differ only in invisible characters
        const addedLines = changeLines.filter(l => l.startsWith('+')).map(l => l.substring(1));
        const removedLines = changeLines.filter(l => l.startsWith('-')).map(l => l.substring(1));
        
        if (addedLines.length === removedLines.length) {            const hasLineEndingDifferences = addedLines.some((added, index) => {
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
        
        console.log('[SVN FileHistoryView] Diff analysis result:', {
            hasContentChanges,
            hasWhitespaceChanges,
            hasLineEndingChanges,
            result
        });
          return result;
    }    /**
     * Update the data store with fresh status data to prevent stale data issues
     */
    private async updateDataStoreWithFreshData(statusData: any): Promise<void> {
        if (!this.currentFile) return;
        
        console.log('[SVN FileHistoryView] Clearing data store cache to force fresh data load');
        
        try {
            // Access the data store through the UI controller
            const dataStore = (this.uiController as any).dataStore;
            if (dataStore && typeof dataStore.clearCache === 'function') {
                // Clear the entire cache to force fresh data
                dataStore.clearCache();
                console.log('[SVN FileHistoryView] Data store cache cleared successfully');
            } else {
                console.warn('[SVN FileHistoryView] Could not access data store for cache clearing');
            }
        } catch (error) {
            console.error('[SVN FileHistoryView] Error clearing data store cache:', error);
            throw error;
        }
    }
}