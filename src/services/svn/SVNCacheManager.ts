import { SvnStatus, SvnLogEntry } from '@/types'; // Added import for SvnStatus and SvnLogEntry
import { loggerDebug, loggerInfo, loggerWarn } from '@/utils/obsidian-logger';

/**
 * Manages caching for SVN operations to improve performance
 */
export class SVNCacheManager {
	private statusResultCache = new Map<string, SvnStatus[]>(); // Renamed and stores SvnStatus[]
	private isFileInSvnResultCache = new Map<string, boolean>();
	private logCache = new Map<string, SvnLogEntry[]>(); // Added logCache
	private cacheInvalidationCallback?: () => void;

	constructor() {
		// registerLoggerClass if needed
	}

	/**
	 * Set callback for cache invalidation notifications
	 */
	setCacheInvalidationCallback(callback: () => void): void {
		this.cacheInvalidationCallback = callback;
	}

	/**
	 * Check if status result cache has a key
	 */
	hasStatusResultCache(key: string): boolean { // Renamed
		return this.statusResultCache.has(key);
	}

	/**
	 * Get status result from cache
	 */
	getStatusResultCache(key: string): SvnStatus[] | undefined { // Renamed
		return this.statusResultCache.get(key);
	}

	/**
	 * Set status result cache
	 */
	setStatusResultCache(key: string, result: SvnStatus[]): void { // Renamed, takes SvnStatus[]
		this.statusResultCache.set(key, result);
	}

	/**
	 * Clear status result cache
	 */
	clearStatusResultCache(): void { // Renamed
		const sizeBefore = this.statusResultCache.size;
		this.statusResultCache.clear();
		loggerDebug(this, `SVN status result cache cleared. Removed ${sizeBefore} entries.`);
	}

	/**
	 * Check if file in SVN cache has a key
	 */
	hasFileInSvnCache(key: string): boolean {
		return this.isFileInSvnResultCache.has(key);
	}

	/**
	 * Get file in SVN result from cache
	 */
	getFileInSvnCache(key: string): boolean | undefined {
		return this.isFileInSvnResultCache.get(key);
	}

	/**
	 * Set file in SVN cache
	 */
	setFileInSvnCache(key: string, value: boolean): void {
		this.isFileInSvnResultCache.set(key, value);
	}

	/**
	 * Clear file in SVN cache
	 */
	clearFileInSvnCache(): void {
		const sizeBefore = this.isFileInSvnResultCache.size;
		this.isFileInSvnResultCache.clear();
		loggerDebug(this, `isFileInSvn cache cleared. Removed ${sizeBefore} entries.`);
	}	/**
	 * Set log cache for a given path.
	 * @param key The absolute path of the file/directory.
	 * @param entries The log entries to cache.
	 */
	setLogCache(key: string, entries: SvnLogEntry[]): void {
		this.logCache.set(key, entries);
		// Reduce logging frequency for performance - only log significant operations
		if (entries.length > 20) {
			loggerDebug(this, `Cached ${entries.length} log entries for: ${key}`);
		}
	}

	/**
	 * Get log entries from cache.
	 * @param key The absolute path of the file/directory.
	 * @returns Cached log entries or undefined.
	 */
	getLogCache(key: string): SvnLogEntry[] | undefined {
		return this.logCache.get(key);
	}

	/**
	 * Clear log cache.
	 */
	clearLogCache(): void {
		const sizeBefore = this.logCache.size;
		this.logCache.clear();
		loggerDebug(this, `Log cache cleared. Removed ${sizeBefore} entries.`);
	}

	/**
	 * Invalidate status cache for a specific key (e.g., path + options string).
	 */
	invalidateStatusCacheByKey(key: string): void {
		if (this.statusResultCache.has(key)) {
			this.statusResultCache.delete(key);
			loggerDebug(this, `Invalidated status cache for key: ${key}`);
			this.notifyInvalidation();
		}
	}

	/**
	 * Invalidate status cache entries where the key starts with a given path prefix.
	 * This is useful when a directory is added/modified, affecting status of its children.
	 */
	invalidateStatusCacheForPathPrefix(pathPrefix: string): void {
		let invalidatedCount = 0;
		for (const key of this.statusResultCache.keys()) {
			// A simple check: if the key (often path or path + options) starts with the prefix.
			// This might need refinement based on how keys are constructed in SVNOperationManager.
			if (key.startsWith(pathPrefix)) {
				this.statusResultCache.delete(key);
				invalidatedCount++;
			}
		}
		if (invalidatedCount > 0) {
			loggerDebug(this, `Invalidated ${invalidatedCount} status cache entries for path prefix: ${pathPrefix}`);
			this.notifyInvalidation();
		}
	}
	/**
	 * Invalidate cache for a specific path and its parent directories.
	 * For status cache, all entries are cleared due to complexity of targeted invalidation.
	 */
	invalidateCacheForPath(absolutePath: string, vaultPath?: string): void {
		// Reduce logging noise - only log the main invalidation
		loggerDebug(this, `Invalidating caches for: ${absolutePath}`);

		// Invalidate isFileInSvn cache for the path and its parents
		let currentPath = absolutePath;
		const pathModule = require('path');

		let invalidatedFileCacheCount = 0;
		while (currentPath && currentPath !== pathModule.dirname(currentPath) && currentPath !== '.') {
			if (!vaultPath || currentPath.startsWith(vaultPath) || currentPath === vaultPath) {
				if (this.isFileInSvnResultCache.has(currentPath)) {
					this.isFileInSvnResultCache.delete(currentPath);
					invalidatedFileCacheCount++;
				}
				if (currentPath === vaultPath) break;
				const parent = pathModule.dirname(currentPath);
				if (parent === currentPath) break; // Reached root or error
				currentPath = parent;
			} else {
				// currentPath is outside vaultPath, stop.
				break;
			}
		}
		
		// Only log if we actually invalidated something significant
		if (invalidatedFileCacheCount > 3) {
			loggerDebug(this, `Invalidated ${invalidatedFileCacheCount} entries from isFileInSvn cache.`);
		}		// Invalidate log cache for the specific path
		// Log cache keys are in format: "path_limit" (e.g., "path/file_all", "path/file_10")
		// So we need to find and delete all keys that start with the absolutePath
		const logKeysToDelete: string[] = [];
		for (const key of this.logCache.keys()) {
			if (key.startsWith(absolutePath)) {
				logKeysToDelete.push(key);
			}
		}
		if (logKeysToDelete.length > 0) {
			logKeysToDelete.forEach(key => {
				this.logCache.delete(key);
			});
			loggerDebug(this, `Invalidated ${logKeysToDelete.length} log cache entries for path: ${absolutePath}`, logKeysToDelete);
		}

		// For status cache, use the more targeted prefix invalidation.
		this.invalidateStatusCacheForPathPrefix(absolutePath);

		this.notifyInvalidation();
	}

	/**
	 * Clear all caches
	 */
	clearAllCaches(): void {
		this.clearStatusResultCache();
		this.clearFileInSvnCache();
		this.clearLogCache(); // Clear log cache as well
		loggerInfo(this, 'All SVN caches cleared.');
		this.notifyInvalidation(); // Notify after clearing all
	}

	/**
	 * Notify cache invalidation callback
	 */
	notifyInvalidation(): void {
		if (this.cacheInvalidationCallback) {
			loggerDebug(this, 'Notifying cache invalidation callback.');
			this.cacheInvalidationCallback();
		}
	}
}
