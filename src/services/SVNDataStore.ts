import { TFile } from 'obsidian';
import { SVNClient } from './SVNClient';
import { SvnLogEntry, SvnInfo, SvnStatus } from '../types';
import { svnDebug, svnInfo, svnError } from '../debug';

export interface SVNFileData {
	file: TFile;
	isLoading: boolean;
	error: string | null;
	
	// Core data
	isWorkingCopy: boolean;
	isFileInSvn: boolean;
	status: SvnStatus[];
	info: SvnInfo | null;
	history: SvnLogEntry[];
	
	// Computed properties
	hasLocalChanges: boolean;
	currentRevision: string | null;
	lastUpdateTime: number;
}

export interface DataLoadOptions {
	includeHistory?: boolean;
	includeStatus?: boolean;
	includeInfo?: boolean;
}

export class SVNDataStore {
	private svnClient: SVNClient;
	private dataCache = new Map<string, SVNFileData>();
	private loadingPromises = new Map<string, Promise<SVNFileData>>();
	private subscribers = new Map<string, Set<(data: SVNFileData) => void>>();
	// Store direct status overrides to ensure fresh data is used
	private directStatusMap = new Map<string, SvnStatus[]>();
	private lastRefreshTime = new Map<string, number>();
	private refreshThrottleMs = 200; // Minimum time between refreshes for same file
	// Track when cache was last cleared to invalidate cached data
	private lastCacheClearTime = Date.now();
	constructor(svnClient: SVNClient) {
		this.svnClient = svnClient;
		
		// Register callback to clear DataStore cache when SVNClient cache is cleared
		this.svnClient.setCacheInvalidationCallback(() => {
			svnInfo('Cache invalidation callback triggered from SVNClient');
			this.forceClearCache();
		});
	}

	/**
	 * Subscribe to data updates for a specific file
	 */
	subscribe(filePath: string, callback: (data: SVNFileData) => void): () => void {
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
	getCachedData(filePath: string): SVNFileData | null {
		return this.dataCache.get(filePath) || null;
	}

	/**
	 * Load SVN data for a file (with caching and deduplication)
	 */
	async loadFileData(file: TFile, options: DataLoadOptions = {}): Promise<SVNFileData> {
		const filePath = file.path;

		svnInfo('loadFileData called:', {
			filePath,
			hasLoadingPromise: this.loadingPromises.has(filePath),
			hasCachedData: this.dataCache.has(filePath)
		});
		
		// If already loading, return existing promise
		if (this.loadingPromises.has(filePath)) {
			svnInfo('Returning existing loading promise for:', filePath);
			return this.loadingPromises.get(filePath)!;
		}

		// TEMPORARY: Disable cache completely to debug the issue
		/*
		// Check if we have recent cached data
		const cached = this.dataCache.get(filePath);
		if (cached && !cached.isLoading && (Date.now() - cached.lastUpdateTime) < 2000) {
			// Check if cache was cleared since this data was created
			if (cached.lastUpdateTime > this.lastCacheClearTime) {
				svnDebug('Returning cached data:', {
					filePath,
					age: Date.now() - cached.lastUpdateTime,
					isFileInSvn: cached.isFileInSvn,
					isWorkingCopy: cached.isWorkingCopy,
					cacheTime: cached.lastUpdateTime,
					clearTime: this.lastCacheClearTime
				});
				return cached;
			} else {
				svnDebug('Cached data invalidated by cache clear:', {
					filePath,
					dataTime: cached.lastUpdateTime,
					clearTime: this.lastCacheClearTime
				});
			}
		}
		*/
		// Create loading promise
		svnInfo('Creating new loading promise for:', filePath);
		const loadingPromise = this.performDataLoad(file, options);
		this.loadingPromises.set(filePath, loadingPromise);

		try {
			const data = await loadingPromise;
			svnInfo('Load completed for:', {
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
	async refreshFileData(file: TFile, options: DataLoadOptions = {}): Promise<SVNFileData> {
		const filePath = file.path;
		const now = Date.now();
		const lastRefresh = this.lastRefreshTime.get(filePath) || 0;
		
		// Throttle rapid consecutive refreshes
		if (now - lastRefresh < this.refreshThrottleMs) {
			svnInfo(`Throttling refresh for ${filePath} (last refresh ${now - lastRefresh}ms ago)`);
			// Return existing cached data or current loading promise if available
			const cached = this.dataCache.get(filePath);
			if (cached) return cached;
			
			const loadingPromise = this.loadingPromises.get(filePath);
			if (loadingPromise) return loadingPromise;
		}

		svnInfo(`Refreshing data for ${filePath}`);
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
	 */
	forceClearCache(): void {
		svnInfo('Force clearing all cache data');
		this.dataCache.clear();
		this.loadingPromises.clear();
		this.lastRefreshTime.clear();
		this.directStatusMap.clear();
		this.lastCacheClearTime = Date.now(); // Update clear timestamp
	}

	/**
	 * Update SVN client reference
	 */
	updateSvnClient(svnClient: SVNClient): void {
		this.svnClient = svnClient;
		// Clear cache since client changed
		this.clearCache();
	}

	private async performDataLoad(file: TFile, options: DataLoadOptions): Promise<SVNFileData> {
		const filePath = file.path;
		
		// Create initial loading state
		const loadingData: SVNFileData = {
			file,
			isLoading: true,
			error: null,
			isWorkingCopy: false,
			isFileInSvn: false,
			status: [],
			info: null,
			history: [],
			hasLocalChanges: false,
			currentRevision: null,
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

			svnInfo('Core checks completed:', {
				filePath,
				isWorkingCopy,
				isFileInSvn
			});

			// Early exit if not in working copy
			if (!isWorkingCopy) {
				const finalData: SVNFileData = {
					...loadingData,
					isLoading: false,
					isWorkingCopy: false,
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
				? this.svnClient.getFileHistory(filePath).catch(() => [])
				: Promise.resolve([]);			// Wait for all data to load
			const [status, info, history] = await Promise.all([
				statusPromise,
				infoPromise,
				historyPromise
			]);

			// IMPORTANT: Re-validate isFileInSvn based on actual status results
			// If status is empty and there's no info, the file is definitely unversioned
			let finalIsFileInSvn = isFileInSvn;
			if (isFileInSvn && status.length === 0 && !info) {
				svnInfo('Re-evaluating isFileInSvn: empty status and no info suggests unversioned file');
				// Double-check with a direct status call to be absolutely sure
				try {
					const recheck = await this.svnClient.isFileInSvn(filePath);
					finalIsFileInSvn = recheck;
					svnInfo('Re-check result:', { filePath, originalCheck: isFileInSvn, recheckResult: recheck });
				} catch (error) {
					finalIsFileInSvn = false;
					svnInfo('Re-check failed, assuming unversioned:', error.message);
				}
			}

			// Compute derived properties
			const hasLocalChanges = status.some(s => s.status === 'M' || s.status === 'A' || s.status === 'D');
			const currentRevision = info?.revision || null;

			// Create final data object
			const finalData: SVNFileData = {
				file,
				isLoading: false,
				error: null,
				isWorkingCopy,
				isFileInSvn: finalIsFileInSvn,
				status,
				info,
				history,
				hasLocalChanges,
				currentRevision,
				lastUpdateTime: Date.now()
			};// Cache and notify
			svnInfo('Final data loaded:', {
				filePath: filePath,
				isWorkingCopy: finalData.isWorkingCopy,
				isFileInSvn: finalData.isFileInSvn,
				statusCount: finalData.status.length,
				statusItems: finalData.status.map(s => ({ path: s.filePath, status: s.status }))
			});
			this.dataCache.set(filePath, finalData);
			this.notifySubscribers(filePath, finalData);
			return finalData;

		} catch (error) {
			const errorData: SVNFileData = {
				...loadingData,
				isLoading: false,
				error: error.message,
				lastUpdateTime: Date.now()
			};

			this.dataCache.set(filePath, errorData);
			this.notifySubscribers(filePath, errorData);
			return errorData;
		}
	}

	private notifySubscribers(filePath: string, data: SVNFileData): void {
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




