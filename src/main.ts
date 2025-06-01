import { Plugin, TFile, Notice, WorkspaceLeaf, FileSystemAdapter, addIcon } from 'obsidian';
import { SvnSettingTab } from './settings';
import { SvnPluginSettings } from './types';
import { registerCommands } from './core/commands';
import { SVNClient } from './services/SVNClient';
import { FileHistoryView, FILE_HISTORY_VIEW_TYPE } from './ui/views/FileHistoryView';
import { PLUGIN_CONSTANTS, DEFAULT_SETTINGS, SVN_ICON_SVG } from './core/constants';

/**
 * Main plugin class for Obsidian SVN integration
 * Handles plugin lifecycle, view registration, and core functionality
 */
export default class ObsidianSvnPlugin extends Plugin {
    settings: SvnPluginSettings;
    svnClient: SVNClient;
    private statusUpdateTimer: number | null = null;

    async onload() {
        console.log(`Loading ${PLUGIN_CONSTANTS.PLUGIN_NAME} plugin`);
        
        // Register SVN icon
        addIcon(PLUGIN_CONSTANTS.ICON_ID, SVN_ICON_SVG);
        
        // Load settings
        await this.loadSettings();

        // Initialize SVN client
        this.initializeSvnClient();

        // Register UI components
        this.registerUI();

        // Register commands
        registerCommands(this);

        // Setup features based on settings
        this.setupFeatures();

        // Initialize workspace
        this.initializeWorkspace();
    }

    onunload() {
        this.cleanup();
    }

    /**
     * Initialize the SVN client with proper vault path
     */
    private initializeSvnClient() {
        this.svnClient = new SVNClient(this.settings.svnBinaryPath);
        
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            this.svnClient.setVaultPath(adapter.getBasePath());
        } else {
            new Notice('SVN plugin requires file system access and may not work with this vault type');
        }
    }

    /**
     * Register all UI components (views, ribbon, settings)
     */
    private registerUI() {
        // Register the file history view
        this.registerView(
            FILE_HISTORY_VIEW_TYPE,
            (leaf: WorkspaceLeaf) => new FileHistoryView(leaf, this)
        );

        // Add settings tab
        this.addSettingTab(new SvnSettingTab(this.app, this));

        // Add ribbon icon
        this.addRibbonIcon(PLUGIN_CONSTANTS.ICON_ID, 'Open SVN Manager', () => {
            this.openFileHistoryView();
        });

        // Add main command to open view
        this.addCommand({
            id: 'svn-open-file-history-view',
            name: 'Open SVN Manager',
            callback: () => {
                this.activateView();
            }
        });
    }    /**
     * Setup optional features based on settings
     */
    private setupFeatures() {
        if (this.settings.autoCommit) {
            this.setupAutoCommit();
        }
        
        // Setup file change monitoring for status updates
        this.setupFileChangeMonitoring();
    }

    /**
     * Initialize workspace-related functionality
     */
    private initializeWorkspace() {
        // Refresh views after configuration
        this.refreshFileHistoryViews();

        // Update SVN client when workspace is ready
        this.app.workspace.onLayoutReady(() => {
            this.updateSvnClient();
        });
    }

    /**
     * Open the file history view
     */
    async openFileHistoryView() {
        await this.activateView();
    }

    /**
     * Activate the SVN file history view
     */
    async activateView() {
        this.app.workspace.detachLeavesOfType(FILE_HISTORY_VIEW_TYPE);

        const rightLeaf = this.app.workspace.getRightLeaf(false);
        if (rightLeaf) {
            await rightLeaf.setViewState({
                type: FILE_HISTORY_VIEW_TYPE,
                active: true,
            });

            this.app.workspace.revealLeaf(
                this.app.workspace.getLeavesOfType(FILE_HISTORY_VIEW_TYPE)[0]
            );
        }
    }

    /**
     * Load plugin settings
     */
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }    /**
     * Save plugin settings
     */
    async saveSettings() {
        await this.saveData(this.settings);
        
        // Update SVN client path when settings change
        this.updateSvnClient();
    }

    /**
     * Update SVN client configuration
     */
    private updateSvnClient() {
        this.svnClient = new SVNClient(this.settings.svnBinaryPath);
        
        // Set the vault path if using FileSystemAdapter
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            this.svnClient.setVaultPath(adapter.getBasePath());
        }        // Refresh file history views with the new client
        this.refreshFileHistoryViews();
    }    /**
     * Setup file change monitoring for status updates
     */
    private setupFileChangeMonitoring() {
        // Update status when switching files (full refresh needed for new file)
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.refreshFileHistoryViews(); // Full refresh when switching files
            })
        );
        
        // Update status when files are modified (status-only refresh)
        this.registerEvent(
            this.app.vault.on('modify', (file: TFile) => {
                this.handleFileChange(file);
            })
        );
        
        // Update status when files are created (status-only refresh)
        this.registerEvent(
            this.app.vault.on('create', (file: TFile) => {
                this.handleFileChange(file);
            })
        );
        
        // Update status when files are deleted (status-only refresh)
        this.registerEvent(
            this.app.vault.on('delete', () => {
                this.scheduleStatusRefresh();
            })
        );
        
        // Update history views when files are renamed
        this.registerEvent(
            this.app.vault.on('rename', (file: TFile) => {
                this.handleFileChange(file);
            })
        );
    }    /**
     * Handle file changes for status updates
     */
    private handleFileChange(file: TFile) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && file.path === activeFile.path) {
            this.scheduleStatusRefresh();
        }
    }

    /**
     * Schedule a status refresh with delay
     */
    private scheduleStatusRefresh() {
        if (this.statusUpdateTimer) {
            clearTimeout(this.statusUpdateTimer);
        }
        
        this.statusUpdateTimer = window.setTimeout(() => {
            this.refreshStatusInViews();
            this.statusUpdateTimer = null;
        }, 300); // 300ms delay for status updates
    }

    /**
     * Setup auto-commit functionality
     */
    private setupAutoCommit() {
        this.registerEvent(            this.app.vault.on('modify', async (file: TFile) => {
                if (!this.settings.autoCommit) return;

                try {
                    const isWorkingCopy = await this.svnClient.isWorkingCopy(file.path);
                    if (isWorkingCopy) {
                        await this.svnClient.commitFile(file.path, this.settings.commitMessage);
                        new Notice(`Auto-committed: ${file.name}`);
                          // Refresh status after auto-commit
                        setTimeout(() => {
                            this.refreshStatusInViews();
                        }, PLUGIN_CONSTANTS.UI.REFRESH_DELAY);
                    }
                } catch (error) {
                    console.error('Auto-commit failed:', error);
                    // Don't show notice for auto-commit failures to avoid spam
                }
            })
        );
    }

    /**
     * Refresh all open file history views
     */
    refreshFileHistoryViews() {
        let refreshedCount = 0;
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof FileHistoryView) {
                leaf.view.refreshView();
                refreshedCount++;
            }
        });
        console.log(`Refreshed ${refreshedCount} file history views`);
    }

    /**
     * Refresh only the status display in all open file history views
     */
    refreshStatusInViews() {
        let refreshedCount = 0;
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof FileHistoryView) {
                leaf.view.refreshStatus();
                refreshedCount++;
            }
        });
        console.log(`Refreshed status in ${refreshedCount} file history views`);
    }

    /**
     * Cleanup resources on plugin unload
     */
    private cleanup() {
        if (this.statusUpdateTimer) {
            clearTimeout(this.statusUpdateTimer);
            this.statusUpdateTimer = null;
        }
    }
}
