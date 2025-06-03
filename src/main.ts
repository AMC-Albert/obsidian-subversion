import { Plugin, TFile, Notice, WorkspaceLeaf, FileSystemAdapter, addIcon } from 'obsidian';
import { SvnSettingTab } from './settings';
import { SvnPluginSettings } from './types';
import { registerCommands } from './core/commands';
import { SVNClient } from './services/SVNClient';
import { SVNView as FileHistoryView, FILE_HISTORY_VIEW_TYPE } from './views/SVNView';
import { PLUGIN_CONSTANTS, DEFAULT_SETTINGS, SVN_ICON_SVG } from './core/constants';
import { logger, LogLevel, logError } from './utils/logger';

/**
 * Main plugin class for Obsidian SVN integration
 * Handles plugin lifecycle, view registration, and core functionality
 */
export default class ObsidianSvnPlugin extends Plugin {
	settings: SvnPluginSettings;
	svnClient: SVNClient;
	private statusUpdateTimer: number | null = null;
	private lastActiveFile: string | null = null;	async onload() {
		// Initialize logger first
		logger.initialize(this.app, LogLevel.DEBUG);
		logger.info('Plugin', `Loading ${PLUGIN_CONSTANTS.PLUGIN_NAME} plugin`);
		
		// Register SVN icon
		addIcon(PLUGIN_CONSTANTS.ICON_ID, SVN_ICON_SVG);
		
		// Load settings
		await this.loadSettings();

		// Configure logger based on settings
		this.configureLogger();

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
		
		// Set the vault path if using FileSystemAdapter
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			this.svnClient.setVaultPath(adapter.getBasePath());
		}
	}
	/**
	 * Configure logger settings
	 */
	private configureLogger() {
		// Set the vault path for log files using the same pattern as SVNClient
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			logger.setVaultPath(adapter.getBasePath());
		}
		
		// Configure logger based on settings (can be enhanced with user preferences later)
		logger.setLogLevel(LogLevel.DEBUG); // Could be made configurable
		logger.setAutoDumpOnError(true);
		logger.setMaxErrorsBeforeDump(5);
		logger.startAutoDump(30); // Auto-dump every 30 minutes
		
		logger.info('Plugin', 'Logger configured with auto-dump functionality');
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
		this.addRibbonIcon(PLUGIN_CONSTANTS.ICON_ID, 'Open Subversion view', () => {
			this.openFileHistoryView();
		});

		// Add main command to open view
		this.addCommand({
			id: 'svn-open-file-history-view',
			name: 'Open Subversion view',
			callback: () => {
				this.activateView();
			}
		});
	}
	
	/**
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
	}
	
	/**
	 * Save plugin settings
	 */
	async saveSettings() {
		await this.saveData(this.settings);
		
		// Update SVN client path when settings change (but don't auto-refresh views)
		this.updateSvnClient();
		
		// Notify views that settings have changed (with a small delay to ensure debounced saves complete)
		setTimeout(() => {
			this.notifyViewsOfSettingsChange();
		}, 100);
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
		}
		
		// Don't automatically refresh views here - let user manually refresh if needed
		// Automatic refresh on every settings keystroke creates race conditions
		logger.info('[SVN Plugin]', 'SVN client updated, views will refresh on next user action');
	}

	/**
	 * Notify views that settings have changed
	 */
	private notifyViewsOfSettingsChange() {
		logger.info('[SVN Plugin]', 'Notifying views of settings change');
		let notifiedCount = 0;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof FileHistoryView) {
				// Call a method on the view to handle settings change
				if (typeof (leaf.view as any).onSettingsChanged === 'function') {
					(leaf.view as any).onSettingsChanged();
					notifiedCount++;
				}
			}
		});
		logger.info(`[SVN Plugin]`, `Notified ${notifiedCount} file history views of settings change`);
	}

	/**
	 * Setup file change monitoring for status updates
	 */
	private setupFileChangeMonitoring() {
		// Update status when switching files (with smart refresh)
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				// Only refresh if the active file has actually changed
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile && this.lastActiveFile !== activeFile?.path) {
					this.lastActiveFile = activeFile.path;
					this.refreshFileHistoryViews();
				}
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
	}
	
	/**
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
		}, 150); // Reduced delay since FileHistoryView now has intelligent retry logic
	}

	/**
	 * Setup auto-commit functionality
	 */
	private setupAutoCommit() {
		this.registerEvent(
			this.app.vault.on('modify', async (file: TFile) => {
				if (!this.settings.autoCommit) return;

				try {
					const isWorkingCopy = await this.svnClient.isWorkingCopy(file.path);
					if (isWorkingCopy) {
						await this.svnClient.commitFile(file.path, this.settings.commitMessage);
						new Notice(`Auto-committed: ${file.name}.`);
						  // Refresh status after auto-commit
						setTimeout(() => {
							this.refreshStatusInViews();
						}, PLUGIN_CONSTANTS.UI.REFRESH_DELAY);
					}
				} catch (error) {
					logError('SVNPlugin', 'Auto-commit failed:', error);
					// Don't show notice for auto-commit failures to avoid spam
				}
			})
		);
	}
	
	/**
	 * Refresh all open file history views (with throttling to prevent spam)
	 */
	private lastRefreshTime = 0;
	private static readonly REFRESH_THROTTLE_MS = 1000; // 1 second throttle
	
	refreshFileHistoryViews() {
		const now = Date.now();
		if (now - this.lastRefreshTime < ObsidianSvnPlugin.REFRESH_THROTTLE_MS) {
			logger.info(`[SVN Plugin]`, `Throttling refreshFileHistoryViews - last refresh ${now - this.lastRefreshTime}ms ago`);
			return;
		}
		
		logger.info('[SVN Plugin]', 'refreshFileHistoryViews called');
		this.lastRefreshTime = now;
		
		let refreshedCount = 0;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof FileHistoryView) {
				leaf.view.refreshView();
				refreshedCount++;
			}
		});
		logger.info(`[SVN Plugin]`, `Refreshed ${refreshedCount} file history views`);
	}

	/**
	 * Refresh only the status display in all open file history views
	 */
	refreshStatusInViews() {
		let refreshedCount = 0;
		this.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view instanceof FileHistoryView) {
				// Use refreshData instead of refreshStatus to ensure history is reloaded
				leaf.view.refreshData();
				refreshedCount++;
			}
		});
		logger.info(`[SVN Plugin]`, `Refreshed data in ${refreshedCount} file history views`);
	}
	/**
	 * Cleanup resources on plugin unload
	 */
	private cleanup() {
		if (this.statusUpdateTimer) {
			clearTimeout(this.statusUpdateTimer);
			this.statusUpdateTimer = null;
		}
		
		// Stop logger auto-dump and dump final logs
		logger.stopAutoDump();
		logger.dumpLogsToFile().catch(err => {
			console.error('Failed to dump final logs on unload:', err);
		});
		
		logger.info('Plugin', 'Plugin cleanup completed');
	}
}
