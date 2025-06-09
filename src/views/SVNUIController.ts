import { TFile } from 'obsidian';
import { SVNDataStore } from '@/services';
import { SvnFileData } from '@/types';
import type ObsidianSvnPlugin from '../main';
import { SVNClient } from '@/services';
import { loggerDebug, loggerInfo, loggerError, registerLoggerClass } from '@/utils/obsidian-logger';

export interface UIState {
	isLoading: boolean;
	showLoading: boolean;
	data: SvnFileData | null;
	error: string | null;
}

export class SVNUIController {
	private plugin: ObsidianSvnPlugin;
	private svnClient: SVNClient;
	private dataStore: SVNDataStore;
	private currentFile: TFile | null = null;
	private uiState: UIState = {
		isLoading: false,
		showLoading: false,
		data: null,
		error: null
	};
	
	private uiUpdateCallbacks = new Set<(state: UIState) => void>();
	private unsubscribeDataStore: (() => void) | null = null;
	private lastStateUpdateTime = 0;
	private updateThrottleMs = 100; // Minimum time between UI updates
		constructor(plugin: ObsidianSvnPlugin, svnClient: SVNClient) {
		this.plugin = plugin;
		this.svnClient = svnClient;
		this.dataStore = new SVNDataStore(svnClient);
		registerLoggerClass(this, 'SVNUIController');
	}

	/**
	 * Subscribe to UI state changes
	 */
	subscribeToUI(callback: (state: UIState) => void): () => void {
		this.uiUpdateCallbacks.add(callback);
		
		// Immediately call with current state
		callback(this.uiState);
		
		return () => {
			this.uiUpdateCallbacks.delete(callback);
		};
	}

	/**
	 * Set the current file and load its data
	 */
	async setCurrentFile(file: TFile | null): Promise<void> {
		// Clean up previous subscription
		if (this.unsubscribeDataStore) {
			this.unsubscribeDataStore();
			this.unsubscribeDataStore = null;
		}

		this.currentFile = file;

		if (!file) {
			this.updateUIState({
				isLoading: false,
				showLoading: false,
				data: null,
				error: null
			});
			return;
		}

		// Check for cached data first
		const cachedData = this.dataStore.getCachedData(file.path);
		if (cachedData && !cachedData.isLoading) {
			// We have cached data, show it immediately
			this.updateUIState({
				isLoading: false,
				showLoading: false,
				data: cachedData,
				error: cachedData.error
			});
		} else {
			// No cached data, show loading state after a short delay
			this.updateUIState({
				isLoading: true,
				showLoading: false, // Don't show loading immediately
				data: cachedData,
				error: null
			});            // Show loading indicator after 200ms if still loading
			setTimeout(() => {
				if (this.uiState.isLoading && this.currentFile?.path === file.path) {
					this.updateUIState({
						...this.uiState,
						showLoading: true
					});
				}
			}, 200);
		}
		// Subscribe to data updates
		this.unsubscribeDataStore = this.dataStore.subscribe(file.path, (data) => {
			loggerDebug(this, 'Data subscription callback triggered:', {
				filePath: file.path,
				currentFilePath: this.currentFile?.path,
				dataIsLoading: data.isLoading,
				statusCount: data.status?.length || 0,
				statusItems: data.status?.map(s => ({ path: s.filePath, status: s.status })) || [],
				historyCount: data.history?.length || 0,
				historyRevisions: data.history?.map(h => ({ revision: h.revision, message: h.message?.substring(0, 50) })) || [],
				lastUpdateTime: data.lastUpdateTime
			});
			
			// Only update if this is still the current file
			if (this.currentFile?.path === file.path) {
				// Check if the data has actually changed to prevent unnecessary updates
				const newStateData = {
					isLoading: data.isLoading,
					showLoading: data.isLoading,
					data: data,
					error: data.error
				};
				
				// Only update if something meaningful changed
				const isLoadingChanged = this.uiState.isLoading !== newStateData.isLoading;
				const showLoadingChanged = this.uiState.showLoading !== newStateData.showLoading;
				const errorChanged = this.uiState.error !== newStateData.error;
				const dataChanged = this.uiState.data !== newStateData.data;
				
				if (isLoadingChanged || showLoadingChanged || errorChanged || dataChanged) {
					loggerInfo(this, 'Updating UI state due to data changes:', {
						isLoadingChanged,
						showLoadingChanged,
						errorChanged,
						dataChanged
					});
					this.updateUIState(newStateData);
				} else {
					loggerInfo(this, 'Skipping UI update, no meaningful changes detected');
				}
			}
		});

		// Load the data
		try {
			await this.dataStore.loadFileData(file, {
				includeHistory: true,
				includeStatus: true,
				includeInfo: true
			});
		} catch (error) {
			loggerError(this, 'Error loading SVN data:', error);
			if (this.currentFile?.path === file.path) {
				this.updateUIState({
					isLoading: false,
					showLoading: false,
					data: null,
					error: error.message
				});
			}
		}
	}
	
	/**
	 * Refresh data for current file
	 */
	async refreshCurrentFile(): Promise<void> {
		loggerInfo(this, 'refreshCurrentFile called:', {
			currentFile: this.currentFile?.path,
			timestamp: new Date().toISOString()
		});
		
		if (!this.currentFile) return;

		// Don't show loading state for refreshes
		this.updateUIState({
			...this.uiState,
			isLoading: true
		});

		try {
			// Refresh data for current file (including status)
			await this.dataStore.refreshFileData(this.currentFile, {
				includeHistory: true,
				includeStatus: true,
				includeInfo: true
			});
		} catch (error) {
			loggerError(this, 'Error refreshing SVN data:', error);
			this.updateUIState({
				...this.uiState,
				isLoading: false,
				error: error.message
			});
		}
	}

	/**
	 * Update SVN client and clear cache
	 */
	updateSvnClient(svnClient: SVNClient): void {
		this.svnClient = svnClient;
		this.dataStore.updateSvnClient(svnClient);
		
		// Reload current file with new client
		if (this.currentFile) {
			this.setCurrentFile(this.currentFile);
		}
	}

	/**
	 * Get current UI state
	 */
	getCurrentState(): UIState {
		return { ...this.uiState };
	}
	
	/**
	 * Inject fresh file data into UI state
	 */
	public setData(data: SvnFileData): void {
		// Preserve loading flags
		this.updateUIState({ data, isLoading: false, showLoading: false, error: null });
	}

	/**
	 * Get current file data
	 */
	getCurrentData(): SvnFileData | null {
		return this.uiState.data;
	}

	/**
	 * Cleanup
	 */
	dispose(): void {
		if (this.unsubscribeDataStore) {
			this.unsubscribeDataStore();
			this.unsubscribeDataStore = null;
		}
		this.uiUpdateCallbacks.clear();	}    private updateUIState(newState: Partial<UIState>): void {
		const now = Date.now();
		
		// Throttle UI updates to prevent rapid-fire calls
		if (now - this.lastStateUpdateTime < this.updateThrottleMs) {
			// If we're throttling, schedule the update for later unless we're transitioning to/from loading
			const isLoadingTransition = 
				(newState.showLoading !== undefined && newState.showLoading !== this.uiState.showLoading) ||
				(newState.isLoading !== undefined && newState.isLoading !== this.uiState.isLoading);
			
			if (!isLoadingTransition) {
				loggerDebug(this, 'Throttling UI update, too frequent');
				return;
			}
		}
		
		const oldState = { ...this.uiState };
		this.uiState = { ...this.uiState, ...newState };
		this.lastStateUpdateTime = now;
		
		loggerDebug(this, 'State update:', {
			old: {
				isLoading: oldState.isLoading,
				showLoading: oldState.showLoading,
				hasData: !!oldState.data,
				error: oldState.error
			},
			new: {
				isLoading: this.uiState.isLoading,
				showLoading: this.uiState.showLoading,
				hasData: !!this.uiState.data,
				error: this.uiState.error
			},
			timestamp: new Date().toISOString()
		});
		
		// Notify all UI subscribers
		this.uiUpdateCallbacks.forEach(callback => {
			try {
				callback(this.uiState);
			} catch (error) {
				loggerError(this, 'Error in UI state callback:', error);
			}
		});
	}
}




