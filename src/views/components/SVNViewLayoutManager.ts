import { TFile } from 'obsidian';
import { SVNToolbar, SVNInfoPanel } from '.';

/**
 * Manages the DOM layout and structure for the FileHistoryView
 * Extracted from FileHistoryView to reduce complexity
 */
export class SVNViewLayoutManager {
    private containerEl: HTMLElement;
    private isInitialized = false;
    
    // UI Elements with persistent references
    private infoPanelElement: HTMLElement | null = null;
    private toolbarContainer: HTMLElement | null = null;
    private statusContainer: HTMLElement | null = null;
    private contentArea: HTMLElement | null = null;

    constructor(containerEl: HTMLElement) {
        this.containerEl = containerEl;
    }

    /**
     * Initialize the persistent DOM layout structure
     */
    initializeLayout(): void {
        if (this.isInitialized) return;
        
        this.containerEl.empty();
        
        // Create persistent container structure
        this.toolbarContainer = this.containerEl.createEl('div', { cls: 'nav-header' });
        
        this.infoPanelElement = this.containerEl.createEl('div', { cls: 'svn-info-panel' });
        this.infoPanelElement.style.display = 'none';
        
        this.statusContainer = this.containerEl.createEl('div', { cls: 'svn-status-display' });
        this.contentArea = this.containerEl.createEl('div', { cls: 'svn-history-content' });
        
        this.isInitialized = true;
    }

    /**
     * Setup the info panel with necessary components
     */
    setupInfoPanel(infoPanel: SVNInfoPanel, fileActions: any): void {
        if (this.infoPanelElement) {
            infoPanel.setPanelElement(this.infoPanelElement);
            fileActions.setInfoPanel(this.infoPanelElement);
        }
    }

    /**
     * Update toolbar section only
     */
    updateToolbar(toolbar: SVNToolbar, currentFile: TFile | null): void {
        if (this.toolbarContainer) {
            this.toolbarContainer.empty();
            toolbar.render(this.toolbarContainer, currentFile);
        }
    }

    /**
     * Clear the status container
     */
    clearStatusContainer(): void {
        if (this.statusContainer) {
            this.statusContainer.empty();
        }
    }

    /**
     * Clear the content area
     */
    clearContentArea(): void {
        if (this.contentArea) {
            this.contentArea.empty();
        }
    }

    // Getters for UI elements
    getInfoPanelElement(): HTMLElement | null { return this.infoPanelElement; }
    getToolbarContainer(): HTMLElement | null { return this.toolbarContainer; }
    getStatusContainer(): HTMLElement | null { return this.statusContainer; }
    getContentArea(): HTMLElement | null { return this.contentArea; }
    
    isLayoutInitialized(): boolean { return this.isInitialized; }

    /**
     * Reset layout state
     */
    resetLayout(): void {
        this.isInitialized = false;
        this.infoPanelElement = null;
        this.toolbarContainer = null;
        this.statusContainer = null;
        this.contentArea = null;
    }
}
