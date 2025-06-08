import { UIState } from '../SVNUIController';
import { SvnStatusCode } from '@/types';
import { debug, info, error, registerLoggerClass } from '@/utils/obsidian-logger';

/**
 * Manages state tracking and hash calculations for the FileHistoryView
 * Extracted from FileHistoryView to reduce complexity
 */
export class SVNViewStateManager {
	// State tracking for intelligent updates
	private lastDataHash: string | null = null;
	private lastFileId: string | null = null;
	private lastStatusHash: string | null = null;
	private lastContentType: string | null = null;
	private lastHistoryHash: string | null = null;
	private lastDirectStatusUpdateTime = 0;
	private lastDirectStatusData: { isWorkingCopy: boolean; status: any[]; info: any | null } | null = null;

	// User interaction protection (prevent DOM rebuilding during clicks)
	private userInteractionWindow = 0;
	private static readonly USER_INTERACTION_WINDOW_MS = 1000; // 1 second protection
	
	// Centralized protection window constant
	private static readonly PROTECTION_WINDOW_MS = 5000;

	/**
	 * Calculate a hash of the current state for change detection
	 */
	calculateStateHash(state: UIState): string {
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
	}

	/**
	 * Calculate hash for status display to detect changes
	 */
	calculateStatusHash(state: UIState, currentFilePath?: string): string {
		// During loading states, return a stable hash to avoid rebuilds
		if (state.showLoading) {
			return `loading-${currentFilePath || 'no-file'}`;
		}
		
		if (!state.data) return 'no-data';
		
		// Find the current file's specific status
		const currentFileStatus = state.data.status.find((item: any) => 
			item.filePath.includes(currentFilePath?.split('\\').pop() || '') || 
			item.filePath.endsWith(currentFilePath || '')
		);
		
		const statusData = {
			isWorkingCopy: state.data.isWorkingCopy,
			revision: state.data.info?.revision,
			author: state.data.info?.lastChangedAuthor,
			date: state.data.info?.lastChangedDate,
			filePath: currentFilePath,
			fileStatus: currentFileStatus?.status,
			fileStatusPath: currentFileStatus?.filePath,
			totalStatusItems: state.data.status.length,			hasModifications: state.data.status.some((item: any) => {
				return item.status === SvnStatusCode.MODIFIED || 
					   item.status === SvnStatusCode.ADDED || 
					   item.status === SvnStatusCode.DELETED;
			}),
			timeSinceDirectUpdate: Date.now() - this.lastDirectStatusUpdateTime
		};
		
		return JSON.stringify(statusData);
	}

	/**
	 * Calculate status hash from raw data (for direct status updates)
	 */
	calculateStatusHashFromData(data: { isWorkingCopy: boolean, status: any[], info: any }, currentFilePath?: string, currentFileName?: string): string {
		// More robust file matching - try multiple approaches
		const filePath = currentFilePath || '';
		const fileName = currentFileName || '';
		
		// Try different matching strategies
		let currentFileStatus = data.status.find(item => {
			return item.filePath === filePath ||
				   item.filePath.endsWith('/' + fileName) ||
				   item.filePath.endsWith('\\' + fileName) ||
				   item.filePath.includes(fileName);
		});
		
		// If we still haven't found it, try normalizing paths
		if (!currentFileStatus && filePath) {
			const normalizedPath = filePath.replace(/\\/g, '/');
			currentFileStatus = data.status.find(item => {
				const normalizedItemPath = item.filePath.replace(/\\/g, '/');
				return normalizedItemPath === normalizedPath ||
					   normalizedItemPath.endsWith(normalizedPath) ||
					   normalizedPath.endsWith(normalizedItemPath);
			});
		}
		
		const statusData = {
			isWorkingCopy: data.isWorkingCopy,
			revision: data.info?.revision,
			author: data.info?.lastChangedAuthor,
			date: data.info?.lastChangedDate,
			filePath: filePath,
			fileStatus: currentFileStatus?.status,
			fileStatusPath: currentFileStatus?.filePath,
			fileModified: currentFileStatus?.modified,
			fileConflicted: currentFileStatus?.conflicted,
			totalStatusItems: data.status.length,
			allStatuses: data.status.map(item => ({ path: item.filePath, status: item.status })),
			statusChecksum: this.calculateStatusChecksum(currentFileStatus, data.status.length)
		};
		
		return JSON.stringify(statusData);
	}

	/**
	 * Calculate a checksum based on the actual file status to ensure changes are detected
	 */
	private calculateStatusChecksum(fileStatus: any, totalItems: number): string {
		if (!fileStatus) {
			return `no-status-${totalItems}-${Math.floor(Date.now() / 5000)}`;
		}
		
		// Include key status properties that would change
		const checksumData = {
			status: fileStatus.status,
			path: fileStatus.filePath,
			modified: fileStatus.modified,
			conflicted: fileStatus.conflicted,
			totalItems,
			timeSlice: Math.floor(Date.now() / 5000)
		};
		
		return JSON.stringify(checksumData);
	}

	/**
	 * Check if history data has meaningfully changed
	 */	hasHistoryChanged(state: UIState): boolean {
		if (!state.data) {
			debug(this, 'hasHistoryChanged: No data, returning true');
			return true;
		}
		
		const historyData = {
			count: state.data.history.length,
			firstRevision: state.data.history[0]?.revision,
			lastRevision: state.data.history[state.data.history.length - 1]?.revision,
			revisions: state.data.history.slice(0, 5).map((h: any) => h.revision).join(',')
		};
		
		const currentHistoryHash = JSON.stringify(historyData);
		const changed = currentHistoryHash !== this.lastHistoryHash;
		
		info(this, 'hasHistoryChanged check:', {
			currentHash: currentHistoryHash,
			lastHash: this.lastHistoryHash,
			changed,
			showLoading: state.showLoading,
			historyCount: state.data.history.length
		});
		
		// Only update the stored hash if we're not in loading state
		if (!state.showLoading) {
			this.lastHistoryHash = currentHistoryHash;
			info(this, 'Updated lastHistoryHash to:', this.lastHistoryHash);
		}
		return changed;
	}
	/**
	 * Determine the type of content being displayed
	 */
	getContentType(state: UIState): string {
		if (state.showLoading) return 'loading';
		if (state.error) return 'error';
		if (!state.data) return 'no-file';
		
		const data = state.data;
		if (!data.isWorkingCopy) return 'repository-setup';
		if (!data.isFileInSvn && data.status?.length === 0) return 'not-in-svn';
		
		const isAddedNotCommitted = data.status?.some((s: any) => s.status === SvnStatusCode.ADDED);
		if (isAddedNotCommitted) return 'added-not-committed';
		
		if (!data.history || data.history.length === 0) return 'no-history';
		return 'history';
	}

	// Getters and setters for state tracking
	getLastDataHash(): string | null { return this.lastDataHash; }
	setLastDataHash(hash: string | null): void { this.lastDataHash = hash; }
	
	getLastFileId(): string | null { return this.lastFileId; }
	setLastFileId(id: string | null): void { this.lastFileId = id; }
	
	getLastStatusHash(): string | null { return this.lastStatusHash; }
	setLastStatusHash(hash: string | null): void { this.lastStatusHash = hash; }
	
	getLastContentType(): string | null { return this.lastContentType; }
	setLastContentType(type: string | null): void { this.lastContentType = type; }
	
	getLastHistoryHash(): string | null { return this.lastHistoryHash; }
	setLastHistoryHash(hash: string | null): void { this.lastHistoryHash = hash; }

	// Direct status update methods
	setLastDirectStatusData(data: { isWorkingCopy: boolean; status: any[]; info: any | null } | null): void {
		this.lastDirectStatusData = data;
		this.lastDirectStatusUpdateTime = Date.now();
	}

	getLastDirectStatusData(): { isWorkingCopy: boolean; status: any[]; info: any | null } | null {
		return this.lastDirectStatusData;
	}    isWithinProtectionWindow(): boolean {
		return !!(this.lastDirectStatusData && Date.now() - this.lastDirectStatusUpdateTime < SVNViewStateManager.PROTECTION_WINDOW_MS);
	}    getProtectionWindowMs(): number {
		return SVNViewStateManager.PROTECTION_WINDOW_MS;
	}

	/**
	 * Mark the start of a user interaction to prevent DOM rebuilding
	 */
	startUserInteraction(): void {
		this.userInteractionWindow = Date.now();
	}

	/**
	 * Check if we're within the user interaction protection window
	 */
	isInUserInteractionWindow(): boolean {
		return Date.now() - this.userInteractionWindow < SVNViewStateManager.USER_INTERACTION_WINDOW_MS;
	}
	
	/**
	 * Reset all state tracking for clean slate
	 */
	resetStateTracking(): void {
		this.lastDataHash = null;
		this.lastFileId = null;
		this.lastStatusHash = null;
		this.lastContentType = null;
		this.lastHistoryHash = null;
		this.lastDirectStatusUpdateTime = 0;
		this.lastDirectStatusData = null;
		this.userInteractionWindow = 0;
	}
}





