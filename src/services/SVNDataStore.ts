import { TFile } from 'obsidian';
import { SVNClient } from './SVNClient';
import { SvnLogEntry, SvnInfo, SvnStatus, SvnStatusCode, SvnFileData as ImportedSvnFileData } from '../types';
import { SVNStatusUtils } from '@/utils';
import { loggerDebug, loggerInfo, loggerError, loggerWarn, registerLoggerClass } from '@/utils/obsidian-logger';

// Internal interface for cache entries, combining imported SvnFileData with store-specific fields
interface DataStoreEntry extends ImportedSvnFileData {
	file: TFile; // Specific to the store's context
	isLoading: boolean; // Store-specific loading state
	error: string | null; // Store-specific error state
	lastUpdateTime: number; // Store-specific update timestamp
	svnInfo: SvnInfo | null; // Added info back, as it is part of SvnFileData and accessed directly
	// All other fields (filePath, isFileInSvn, isWorkingCopy, status, history, hasLocalChanges)
	// are inherited from ImportedSvnFileData.
}

export interface DataLoadOptions {
	includeHistory?: boolean;
	includeStatus?: boolean;
	includeInfo?: boolean;
}

export class SVNDataStore {
	private svnClient: SVNClient;
	private dataCache = new Map<string, DataStoreEntry>();
	private loadingPromises = new Map<string, Promise<DataStoreEntry>>();
	private subscribers = new Map<string, Set<(data: DataStoreEntry) => void>>();
	// Store direct status overrides to ensure fresh data is used
	private directStatusMap = new Map<string, SvnStatus[]>();
	private lastRefreshTime = new Map<string, number>();
	private refreshThrottleMs = 500; // Minimum time between refreshes for same file
	// Track when cache was last cleared to invalidate cached data
	private lastCacheClearTime = Date.now();
	private cacheInvalidationCallback?: () => void;
	constructor(svnClient: SVNClient) {
		this.svnClient = svnClient;
		registerLoggerClass(this, 'SVNDataStore');
		// Register callback to clear DataStore cache when SVNClient cache is cleared
		this.svnClient.setCacheInvalidationCallback(() => {
			loggerDebug(this, 'Cache invalidation callback triggered from SVNClient');
			this.forceClearCache();
		});
	}

	/**
	 * Subscribe to data updates for a specific file
	 */
	subscribe(filePath: string, callback: (data: DataStoreEntry) => void): () => void {
		if (!this.subscribers.has(filePath)) {
			this.subscribers.set(filePath, new Set());
		}
		this.subscribers.get(filePath)!.add(callback);

		// Return unsubscribe function
		return () => {
			const subs = this.subscribers.get(filePath);
			if (subs) {
				subs.delete(callback);
				if (subs.size === 0) {
					this.subscribers.delete(filePath);
				}
			}
		};
	}

	/**
	 * Get cached data immediately, or null if not loaded
	 */
	getCachedData(filePath: string): DataStoreEntry | null {
		return this.dataCache.get(filePath) || null;
	}

	/**
	 * Helper function to determine if there are local changes based on status
	 */
	private hasLocalChanges(status: SvnStatus[]): boolean {
		return status.some(s =>
			s.status === SvnStatusCode.MODIFIED ||
			s.status === SvnStatusCode.ADDED ||
			s.status === SvnStatusCode.DELETED ||
			s.status === SvnStatusCode.UNVERSIONED ||
			s.status === SvnStatusCode.MISSING ||
			s.status === SvnStatusCode.CONFLICTED
		);
	}

	/**
	 * Load SVN data for a file (with caching and deduplication)
	 */
	async loadFileData(file: TFile, options: DataLoadOptions = {}): Promise<DataStoreEntry> {
		const filePath = file.path;
		loggerDebug(this, 'loadFileData called:', {
			filePath,
			hasLoadingPromise: this.loadingPromises.has(filePath),
			hasCachedData: this.dataCache.has(filePath)
		});
				// If already loading, return existing promise
		if (this.loadingPromises.has(filePath)) {
			loggerDebug(this, 'Returning existing loading promise for:', filePath);
			return this.loadingPromises.get(filePath)!;
		}
		// Check if we have recent cached data
		const cached = this.dataCache.get(filePath);
		if (cached && !cached.isLoading) {
			// Check if cache was cleared since this data was created
			if (cached.lastUpdateTime > this.lastCacheClearTime) {
				let shouldRefetch = false;
				// If history is requested, file is in SVN, but cached history is missing/empty
				if (options.includeHistory && cached.isFileInSvn && (!cached.history || cached.history.length === 0)) {
					loggerInfo(this, 'Cached data present, but missing requested history. Refetching.', { filePath });
					shouldRefetch = true;
				}
				// If info is requested, file is in SVN, but cached info is missing
				if (!shouldRefetch && options.includeInfo && cached.isFileInSvn && !cached.svnInfo) {
					loggerInfo(this, 'Cached data present, but missing requested svnInfo. Refetching.', { filePath });
					shouldRefetch = true;
				}

				if (!shouldRefetch) {
					loggerDebug(this, 'Returning cached data:', {
						filePath,
						age: Date.now() - cached.lastUpdateTime,
						isFileInSvn: cached.isFileInSvn,
						isWorkingCopy: cached.isWorkingCopy,
						cacheTime: cached.lastUpdateTime,
						clearTime: this.lastCacheClearTime,
						historyCount: cached.history?.length,
						svnInfoPresent: !!cached.svnInfo,
						statusCount: cached.status?.length
					});
					return cached;
				}
				// If shouldRefetch is true, execution falls through to performDataLoad
			} else {
				loggerDebug(this, 'Cached data invalidated by cache clear - data is stale:', {
					filePath,
					dataTime: cached.lastUpdateTime,
					clearTime: this.lastCacheClearTime
				});
			}
		}
		// Create loading promise
		loggerDebug(this, 'Creating new loading promise for:', filePath);
		const loadingPromise = this.performDataLoad(file, options);
		this.loadingPromises.set(filePath, loadingPromise);

		try {
			const data = await loadingPromise;
			loggerInfo(this, 'Load completed for:', {
				filePath,
				isFileInSvn: data.isFileInSvn,
				isWorkingCopy: data.isWorkingCopy
			});
			return data;
		} finally {
			this.loadingPromises.delete(filePath);
		}
	}
	
	/**
	 * Refresh data for a file (bypasses cache)
	 */
	async refreshFileData(file: TFile, options: DataLoadOptions = {}): Promise<DataStoreEntry> {
		const filePath = file.path;
		const now = Date.now();
		const lastRefresh = this.lastRefreshTime.get(filePath) || 0;
		
		// Throttle rapid consecutive refreshes
		if (now - lastRefresh < this.refreshThrottleMs) {
			loggerInfo(this, `Throttling refresh for ${filePath} (last refresh ${now - lastRefresh}ms ago)`);
			// Return existing cached data or current loading promise if available
			const cached = this.dataCache.get(filePath);
			if (cached) return cached;
			
			const loadingPromise = this.loadingPromises.get(filePath);
			if (loadingPromise) return loadingPromise;
		}

		loggerInfo(this, `Refreshing data for ${filePath}`);
		this.lastRefreshTime.set(filePath, now);
		
		// Clear existing cache
		this.dataCache.delete(filePath);
		this.loadingPromises.delete(filePath);
		
		return this.loadFileData(file, options);
	}

	/**
	 * Clear all cached data
	 */
	clearCache(): void {
		this.dataCache.clear();
		this.loadingPromises.clear();
	}
	/**
	 * Force clear all cached data immediately (for use after SVN operations)
	 */	forceClearCache(): void {
		loggerDebug(this, 'Force clearing all cache data');
		this.dataCache.clear();
		this.loadingPromises.clear();
		this.lastRefreshTime.clear();
		this.directStatusMap.clear();
		this.lastCacheClearTime = Date.now(); // Update clear timestamp
		
		// Notify the cache invalidation callback - this will trigger UI refresh
		this.triggerCacheInvalidatedNotification();
	}

	/**
	 * Update SVN client reference
	 */
	updateSvnClient(svnClient: SVNClient): void {
		this.svnClient = svnClient;
		// Clear cache since client changed
		this.clearCache();
	}

	/**
	 * Set callback for cache invalidation notifications that should trigger UI refresh
	 */
	setCacheInvalidationCallback(callback: () => void): void {
		this.cacheInvalidationCallback = callback;
	}

	/**
	 * Trigger cache invalidation notification to connected UI
	 */
	private triggerCacheInvalidatedNotification(): void {
		// This will trigger the callback registered in the constructor, 
		// which notifies the UI system of cache invalidation
		loggerDebug(this, 'Triggering cache invalidation notification');
		if (this.cacheInvalidationCallback) {
			this.cacheInvalidationCallback();
		}
	}

	private async performDataLoad(file: TFile, options: DataLoadOptions): Promise<DataStoreEntry> {
		const filePath = file.path;
		
		// Create initial loading state
		const loadingData: DataStoreEntry = {
			file,
			filePath: filePath, // from ImportedSvnFileData
			isLoading: true,
			error: null,
			isWorkingCopy: false, // from ImportedSvnFileData
			isFileInSvn: false, // from ImportedSvnFileData
			status: [], // from ImportedSvnFileData
			svnInfo: null, // Added to satisfy DataStoreEntry interface
			history: [], // from ImportedSvnFileData
			hasLocalChanges: false, // from ImportedSvnFileData
			// currentRevision is derived from svnInfo.revision, so not stored directly here
			lastUpdateTime: Date.now()
		};

		// Cache loading state and notify subscribers
		this.dataCache.set(filePath, loadingData);
		this.notifySubscribers(filePath, loadingData);
		try {
			// Load data in parallel where possible
			const [isWorkingCopy, isFileInSvn] = await Promise.all([
				this.svnClient.isWorkingCopy(filePath),
				this.svnClient.isFileInSvn(filePath).catch(() => false)
			]);

			loggerInfo(this, 'Core checks completed:', {
				filePath,
				isWorkingCopy,
				isFileInSvn
			});

			// Early exit if not in working copy
			if (!isWorkingCopy) {
				const finalData: DataStoreEntry = {
					...loadingData, // Spread previous loading data
					file, // Ensure file is explicitly set
					filePath, // Ensure filePath is explicitly set
					isLoading: false,
					isWorkingCopy: false, // Explicitly set based on check
					// Default other SvnFileData fields for a non-working-copy scenario
					isFileInSvn: false,
					status: [],
					svnInfo: null,
					history: [],
					hasLocalChanges: false,
					lastUpdateTime: Date.now()
				};
				this.dataCache.set(filePath, finalData);
				this.notifySubscribers(filePath, finalData);
				return finalData;
			}// Load additional data based on options
			// Use direct status override if available to prevent stale data
			let statusPromise: Promise<SvnStatus[]>;
			if (this.directStatusMap.has(filePath)) {
				statusPromise = Promise.resolve(this.directStatusMap.get(filePath)!);
			} else if (options.includeStatus !== false) {
				// Always get status when requested, regardless of isFileInSvn
				// This is important for unversioned files which show status '?'
				statusPromise = this.svnClient.getStatus(filePath).catch(() => []);
			} else {
				statusPromise = Promise.resolve([]);
			}

			const infoPromise = isFileInSvn && options.includeInfo !== false
				? this.svnClient.getInfo(filePath).catch(() => null)
				: Promise.resolve(null);

			const historyPromise = isFileInSvn && options.includeHistory !== false
				? this.svnClient.getFileHistory(filePath).catch((err: Error) => {
					// Log the raw error and its type more robustly
					console.error('SVNDataStore: Raw error caught in historyPromise:', err);
					loggerError(this, 'Error fetching file history in historyPromise. See raw error in console.', {
						filePath,
						errorMessage: err instanceof Error ? err.message : String(err),
						errorStack: err instanceof Error ? err.stack : 'N/A',
						errorObjectString: String(err),
						errorType: typeof err
					});
					return []; // Return empty array on error
				})
				: Promise.resolve([]);
				// Wait for all data to load
			const [status, svnInfoData, historyData] = await Promise.all([ // Renamed svnInfo to svnInfoData to avoid conflict with info field
				statusPromise,
				infoPromise,
				historyPromise
			]);

			loggerDebug(this, 'Data fetched in Promise.all:', {
				filePath,
				statusCount: status?.length,
				svnInfoDataPresent: !!svnInfoData,
				historyDataCount: historyData?.length,
				rawHistoryData: historyData // Log the raw historyData
			});			// IMPORTANT: Re-validate isFileInSvn based on actual status results
			// If status is empty AND there's no info, the file might be unversioned
			// But if svnInfo exists, the file is definitely in SVN (even with empty status)
			let finalIsFileInSvn = isFileInSvn;
			if (isFileInSvn && status.length === 0 && !svnInfoData) {
				loggerInfo(this, 'Re-evaluating isFileInSvn: empty status and no info suggests unversioned file');
				// Double-check with a direct status call to be absolutely sure
				try {
					const recheck = await this.svnClient.isFileInSvn(filePath);
					finalIsFileInSvn = recheck;
					loggerDebug(this, 'Re-check result:', { filePath, originalCheck: isFileInSvn, recheckResult: recheck });
				} catch (error) {
					finalIsFileInSvn = false;
					loggerDebug(this, 'Re-check failed, assuming unversioned:', error.message);
				}
			} else if (svnInfoData) {
				// If we have svnInfo, the file is definitely in SVN
				finalIsFileInSvn = true;
				loggerDebug(this, 'File has svnInfo, confirming it is in SVN:', { filePath, url: svnInfoData.url });
			}// Compute derived properties with type-safe status checking
			const hasLocalChanges = status.some((s: SvnStatus) => SVNStatusUtils.hasChanges(s.status));
			const currentRevision = svnInfoData?.revision || null; // Using svnInfoData here

			// Create final data object
			const finalData: DataStoreEntry = {
				file,
				filePath: filePath, // from ImportedSvnFileData
				isLoading: false,
				error: null,
				isWorkingCopy,
				isFileInSvn: finalIsFileInSvn,
				status,
				svnInfo: svnInfoData, 
				history: historyData, // Ensure historyData is assigned here
				hasLocalChanges,
				// currentRevision is derived from svnInfo.revision, so not stored directly here
				lastUpdateTime: Date.now()
			};
			// Cache and notify

			loggerInfo(this, 'Final data loaded:', {
				filePath: filePath,
				isWorkingCopy: finalData.isWorkingCopy,
				isFileInSvn: finalData.isFileInSvn,
				statusCount: finalData.status.length,
				statusItems: finalData.status.map((s: SvnStatus) => ({ path: s.filePath, status: s.status })),
				historyCount: finalData.history.length, // Added logging for history count
				svnInfoPresent: !!finalData.svnInfo // Added logging for info presence
			});
			this.dataCache.set(filePath, finalData);
			this.notifySubscribers(filePath, finalData);
			return finalData;

		} catch (error) {
			const errorData: DataStoreEntry = {
				...loadingData, // Spread previous loading data
				file, // Ensure file is explicitly set
				filePath, // Ensure filePath is explicitly set
				isLoading: false,
				error: error.message,
				// Default other SvnFileData fields for an error scenario
				isWorkingCopy: loadingData.isWorkingCopy, // Preserve if known
				isFileInSvn: loadingData.isFileInSvn, // Preserve if known
				status: [],
				svnInfo: null, // Corrected from svnInfo to info
				history: [],
				hasLocalChanges: false,
				lastUpdateTime: Date.now()
			};

			this.dataCache.set(filePath, errorData);
			this.notifySubscribers(filePath, errorData);
			return errorData;
		}
	}

	private notifySubscribers(filePath: string, data: DataStoreEntry): void {
		const subscribers = this.subscribers.get(filePath);
		if (subscribers) {
			subscribers.forEach(callback => {
				try {
					callback(data);
				} catch (error) {
					console.error('Error in SVN data subscriber:', error);
				}
			});
		}
	}
}




