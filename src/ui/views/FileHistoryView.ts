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

export const FILE_HISTORY_VIEW_TYPE = PLUGIN_CONSTANTS.VIEW_TYPE;

export class FileHistoryView extends ItemView {
    private plugin: ObsidianSvnPlugin;    private svnClient: SVNClient;
    private currentFile: TFile | null = null;
    private currentViewedRevision: string | null = null; // Track which revision is currently being viewed
    
    // Component instances
    private toolbar: SVNToolbar;
    private fileActions: SVNFileActions;
    private statusDisplay: SVNStatusDisplay;
    private historyRenderer: SVNHistoryRenderer;
    private infoPanel: SVNInfoPanel;
    private fileStateRenderer: SVNFileStateRenderer;
    private repositoryHandler: SVNRepositoryHandler;
    
    // UI Elements
    private infoPanelElement: HTMLElement | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: ObsidianSvnPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.svnClient = plugin.svnClient;        // Initialize components
        this.fileActions = new SVNFileActions(plugin, this.svnClient, () => this.refreshView());
        this.toolbar = new SVNToolbar(plugin, this.svnClient, this.fileActions, () => this.refreshView(), () => this.showRepositorySetup());
        this.statusDisplay = new SVNStatusDisplay(this.svnClient);
        this.historyRenderer = new SVNHistoryRenderer(this.svnClient, plugin, () => this.refreshView());        this.infoPanel = new SVNInfoPanel(plugin, this.svnClient);
        this.fileStateRenderer = new SVNFileStateRenderer(plugin, this.svnClient, () => this.refreshView());
        this.repositoryHandler = new SVNRepositoryHandler(plugin, this.svnClient, () => this.refreshView());
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
        this.containerEl.empty();
        
        // Listen for active file changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.updateCurrentFile();
            })
        );
        
        // Initial render
        this.updateCurrentFile();
    }

    async refreshView() {
        // Update the SVNClient reference in case it was reinitialized
        this.svnClient = this.plugin.svnClient;
        this.updateComponentClients();
        // Force a re-render of the current view
        this.renderView();
    }

    async refreshStatus() {
        // Only refresh the status display without rebuilding the entire view
        this.renderView();
    }    private updateComponentClients(): void {
        // Update SVN client references in all components
        this.fileActions = new SVNFileActions(this.plugin, this.svnClient, () => this.refreshView());
        this.toolbar = new SVNToolbar(this.plugin, this.svnClient, this.fileActions, () => this.refreshView(), () => this.showRepositorySetup());
        this.statusDisplay = new SVNStatusDisplay(this.svnClient);this.historyRenderer = new SVNHistoryRenderer(this.svnClient, this.plugin, () => this.refreshView());        this.infoPanel = new SVNInfoPanel(this.plugin, this.svnClient);
        this.fileStateRenderer = new SVNFileStateRenderer(this.plugin, this.svnClient, () => this.refreshView());
        this.repositoryHandler = new SVNRepositoryHandler(this.plugin, this.svnClient, () => this.refreshView());
    }

    private renderView() {
        this.containerEl.empty();
        
        // Toolbar
        const toolbarContainer = this.containerEl.createEl('div', { cls: 'nav-header' });
        this.toolbar.render(toolbarContainer, this.currentFile);
        
        // Info panel (hidden by default)
        this.infoPanelElement = this.containerEl.createEl('div', { cls: 'svn-info-panel' });
        this.infoPanelElement.style.display = 'none';
        this.infoPanel.setPanelElement(this.infoPanelElement);
        this.fileActions.setInfoPanel(this.infoPanelElement);
        
        // Status display
        const statusContainer = this.containerEl.createEl('div', { cls: 'svn-status-display' });
        this.statusDisplay.render(statusContainer, this.currentFile);
        
        // Main content area
        const contentArea = this.containerEl.createEl('div', { cls: 'svn-history-content' });
        this.loadFileHistory(contentArea);
    }

    private async updateCurrentFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile !== this.currentFile) {
            this.currentFile = activeFile;
            this.renderView();
        }
    }

    private async loadFileHistory(container: HTMLElement) {
        if (!this.currentFile) return;
        
        // Check if SVNClient is properly initialized
        if (!this.isSvnClientReady()) {
            container.createEl('p', { 
                text: 'SVN client not initialized. Please check plugin settings.',
                cls: 'mod-warning'
            });
            return;
        }
        
        const loadingEl = container.createEl('p', { 
            text: 'Loading file history...', 
            cls: 'svn-loading' 
        });
          try {
            const isWorkingCopy = await this.svnClient.isWorkingCopy(this.currentFile.path);
            if (!isWorkingCopy) {
                loadingEl.remove();
                // Use repository handler instead of showing basic error
                this.repositoryHandler.renderRepositorySetup(container, this.currentFile);
                return;
            }
              // Check if file is tracked in SVN before trying to get history
            const isFileInSvn = await this.svnClient.isFileInSvn(this.currentFile.path);
            if (!isFileInSvn) {
                loadingEl.remove();
                this.fileStateRenderer.renderNotInSvn(container, this.currentFile);
                return;
            }
            
            // Check the specific SVN status to determine if file is added but not committed
            const status = await this.svnClient.getStatus(this.currentFile.path);
            if (status.length > 0 && status[0].status === 'A') {
                loadingEl.remove();
                this.fileStateRenderer.renderAddedButNotCommitted(container, this.currentFile);
                return;
            }
            
            // Get complete file history from repository
            const history = await this.svnClient.getFileHistory(this.currentFile.path);
            loadingEl.remove();
            
            if (history.length === 0) {
                container.createEl('p', { 
                    text: 'No history found for this file',
                    cls: 'svn-no-history'
                });
                return;
            }
            
            this.historyRenderer.renderHistory(container, this.currentFile.path);
            
        } catch (error) {
            loadingEl.remove();
            
            // Log the error for debugging
            console.log('SVN Error Details:', error.message);
              // Check if this is a "file not in SVN" error
            const errorMessage = error.message.toLowerCase();
            if (this.isNotInWorkingCopyError(errorMessage)) {
                // Use repository handler for working copy issues
                this.repositoryHandler.renderRepositorySetup(container, this.currentFile);
            } else if (this.isFileNotInSvnError(errorMessage)) {
                this.fileStateRenderer.renderNotInSvn(container, this.currentFile);
            } else if (this.isAddedButNotCommittedError(errorMessage)) {
                this.fileStateRenderer.renderAddedButNotCommitted(container, this.currentFile);
            } else {
                // Other errors
                console.error('Unhandled SVN Error:', error);
                container.createEl('p', { 
                    text: `Error loading history: ${error.message}`,
                    cls: 'mod-warning'
                });
            }
        }
    }    private isFileNotInSvnError(errorMessage: string): boolean {
        return errorMessage.includes('node was not found') || 
               errorMessage.includes('is not under version control') ||
               errorMessage.includes('no such file or directory') ||
               errorMessage.includes('path not found') ||
               errorMessage.includes('file not found') ||
               errorMessage.includes('not found in repository') ||
               // SVN specific error patterns
               errorMessage.includes('svn: e155010') || // node not found
               errorMessage.includes('svn: e200009') || // node not found (different context)
               errorMessage.includes('svn: e160013'); // path not found
    }

    private isNotInWorkingCopyError(errorMessage: string): boolean {
        return errorMessage.includes('is not a working copy') ||
               errorMessage.includes('not a working copy') ||
               errorMessage.includes('svn: e155007'); // not a working copy
    }

    private isAddedButNotCommittedError(errorMessage: string): boolean {
        return errorMessage.includes('has no committed revision') || 
               errorMessage.includes('svn: e195002'); // no committed revision
    }

    private isSvnClientReady(): boolean {
        return this.svnClient && 
               this.plugin.svnClient && 
               this.svnClient === this.plugin.svnClient &&
               // Check if vault path is set (simple way to verify client is configured)
               typeof this.svnClient.setVaultPath === 'function';
    }    private showRepositorySetup(): void {
        if (!this.currentFile) return;
        
        const contentEl = this.containerEl.querySelector('.svn-history-content') as HTMLElement;
        if (contentEl) {
            this.repositoryHandler.renderRepositorySetup(contentEl, this.currentFile);
        }
    }

    async onClose() {
        // No persistent DOM or cache to clean up anymore
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
}