import { SvnStatus, SvnLogEntry, SvnInfo } from '@/types';
import { loggerDebug, loggerWarn } from '@/utils/obsidian-logger';

/**
 * Validation utilities for SVN data structures
 */
export class SVNValidationUtils {
	/**
	 * Validates and normalizes an SVN status object
	 */
	static validateStatus(status: any): SvnStatus | null {
		if (!status || typeof status !== 'object') {
			loggerWarn(this, 'Invalid status object:', status);
			return null;
		}

		if (typeof status.filePath !== 'string' || !status.filePath.trim()) {
			loggerWarn(this, 'Status missing valid filePath:', status);
			return null;
		}

		// Normalize the status code
		const normalizedStatus: SvnStatus = {
			status: status.status || ' ',
			filePath: status.filePath.trim(),
			propertyStatus: status.propertyStatus || undefined,
			locked: Boolean(status.locked),
			workingCopyLocked: Boolean(status.workingCopyLocked)
		};

		loggerDebug(this, 'Validated status:', normalizedStatus);
		return normalizedStatus;
	}

	/**
	 * Validates and normalizes an SVN log entry
	 */
	static validateLogEntry(entry: any): SvnLogEntry | null {
		if (!entry || typeof entry !== 'object') {
			loggerWarn(this, 'Invalid log entry object:', entry);
			return null;
		}

		// Parse revision as number
		let revision: number;
		if (typeof entry.revision === 'number') {
			revision = entry.revision;
		} else if (typeof entry.revision === 'string') {
			revision = parseInt(entry.revision, 10);
			if (isNaN(revision)) {
				loggerWarn(this, 'Invalid revision in log entry:', entry.revision);
				return null;
			}
		} else {
			loggerWarn(this, 'Missing or invalid revision in log entry:', entry);
			return null;
		}

		const normalizedEntry: SvnLogEntry = {
			revision,
			author: String(entry.author || 'Unknown'),
			date: String(entry.date || ''),
			message: String(entry.message || ''),
			size: typeof entry.size === 'number' ? entry.size : undefined,
			repoSize: typeof entry.repoSize === 'number' ? entry.repoSize : undefined,
			changedPaths: Array.isArray(entry.changedPaths) ? entry.changedPaths : undefined
		};

		loggerDebug(this, 'Validated log entry:', normalizedEntry);
		return normalizedEntry;
	}

	/**
	 * Validates and normalizes SVN info
	 */
	static validateInfo(info: any): SvnInfo | null {
		if (!info || typeof info !== 'object') {
			loggerWarn(this, 'Invalid info object:', info);
			return null;
		}

		if (typeof info.url !== 'string' || !info.url.trim()) {
			loggerWarn(this, 'Info missing valid URL:', info);
			return null;
		}

		// Parse numeric fields
		const revision = typeof info.revision === 'number' ? info.revision :
			typeof info.revision === 'string' ? parseInt(info.revision, 10) : 0;

		const lastChangedRev = typeof info.lastChangedRev === 'number' ? info.lastChangedRev :
			typeof info.lastChangedRev === 'string' ? parseInt(info.lastChangedRev, 10) : 0;

		const normalizedInfo: SvnInfo = {
			url: info.url.trim(),
			repositoryRoot: String(info.repositoryRoot || info.url),
			repositoryUuid: String(info.repositoryUuid || ''),
			revision,
			lastChangedRev,
			lastChangedAuthor: String(info.lastChangedAuthor || 'Unknown'),
			lastChangedDate: String(info.lastChangedDate || ''),
			nodeKind: this.validateNodeKind(info.nodeKind),
			schedule: this.validateSchedule(info.schedule)
		};

		loggerDebug(this, 'Validated info:', normalizedInfo);
		return normalizedInfo;
	}

	/**
	 * Validates node kind
	 */
	private static validateNodeKind(nodeKind: any): 'file' | 'dir' | 'none' | 'unknown' | undefined {
		if (typeof nodeKind === 'string') {
			const normalized = nodeKind.toLowerCase();
			if (['file', 'dir', 'none', 'unknown'].includes(normalized)) {
				return normalized as 'file' | 'dir' | 'none' | 'unknown';
			}
		}
		return undefined;
	}

	/**
	 * Validates schedule
	 */
	private static validateSchedule(schedule: any): 'normal' | 'add' | 'delete' | 'replace' | undefined {
		if (typeof schedule === 'string') {
			const normalized = schedule.toLowerCase();
			if (['normal', 'add', 'delete', 'replace'].includes(normalized)) {
				return normalized as 'normal' | 'add' | 'delete' | 'replace';
			}
		}
		return undefined;
	}

	/**
	 * Validates a file path for SVN operations
	 */
	static validateFilePath(filePath: string): string | null {
		if (typeof filePath !== 'string' || !filePath.trim()) {
			loggerWarn(this, 'Invalid file path:', filePath);
			return null;
		}

		const normalized = filePath.trim().replace(/\\/g, '/');
		
		// Check for invalid characters
		if (normalized.includes('//') || normalized.includes('/../')) {
			loggerWarn(this, 'File path contains invalid sequences:', normalized);
			return null;
		}

		return normalized;
	}

	/**
	 * Validates an array of status objects
	 */
	static validateStatusArray(statusArray: any[]): SvnStatus[] {
		if (!Array.isArray(statusArray)) {
			loggerWarn(this, 'Expected array for status validation, got:', typeof statusArray);
			return [];
		}

		return statusArray
			.map(status => this.validateStatus(status))
			.filter((status): status is SvnStatus => status !== null);
	}

	/**
	 * Validates an array of log entries
	 */
	static validateLogEntryArray(logArray: any[]): SvnLogEntry[] {
		if (!Array.isArray(logArray)) {
			loggerWarn(this, 'Expected array for log validation, got:', typeof logArray);
			return [];
		}

		return logArray
			.map(entry => this.validateLogEntry(entry))
			.filter((entry): entry is SvnLogEntry => entry !== null);
	}
}
