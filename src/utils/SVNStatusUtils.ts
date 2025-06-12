import { SVNConstants } from './SVNConstants';
import { SvnStatusCode, SvnPropertyStatus } from '@/types';

/**
 * Centralized SVN status utilities with type safety
 * 
 * Uses constants from SVNConstants for consistent icons, messages, and CSS classes.
 * All methods now work exclusively with SvnStatusCode enum values.
 */
export class SVNStatusUtils {
	/**
	 * Get human-readable status text
	 */
	static getStatusText(status: SvnStatusCode): string {
		switch (status) {
			case SvnStatusCode.MODIFIED: return SVNConstants.MESSAGES.MODIFIED;
			case SvnStatusCode.ADDED: return SVNConstants.MESSAGES.ADDED;
			case SvnStatusCode.DELETED: return SVNConstants.MESSAGES.DELETED;
			case SvnStatusCode.REPLACED: return SVNConstants.MESSAGES.REPLACED;
			case SvnStatusCode.CONFLICTED: return SVNConstants.MESSAGES.CONFLICTED;
			case SvnStatusCode.UNVERSIONED: return SVNConstants.MESSAGES.UNVERSIONED;
			case SvnStatusCode.MISSING: return SVNConstants.MESSAGES.MISSING;
			case SvnStatusCode.IGNORED: return SVNConstants.MESSAGES.IGNORED;
			case SvnStatusCode.EXTERNAL: return SVNConstants.MESSAGES.EXTERNAL;
			case SvnStatusCode.NORMAL: return SVNConstants.MESSAGES.UP_TO_DATE;
			default: 
				return SVNConstants.MESSAGES.UNKNOWN_STATUS;
		}
	}

	/**
	 * Get icon for status
	 */
	static getStatusIcon(status: SvnStatusCode): string {
		switch (status) {
			case SvnStatusCode.MODIFIED: return SVNConstants.ICONS.MODIFIED;
			case SvnStatusCode.ADDED: return SVNConstants.ICONS.ADDED;
			case SvnStatusCode.DELETED: return SVNConstants.ICONS.DELETED;
			case SvnStatusCode.REPLACED: return SVNConstants.ICONS.REPLACED;
			case SvnStatusCode.CONFLICTED: return SVNConstants.ICONS.CONFLICTED;
			case SvnStatusCode.UNVERSIONED: return SVNConstants.ICONS.UNVERSIONED;
			case SvnStatusCode.MISSING: return SVNConstants.ICONS.MISSING;
			case SvnStatusCode.IGNORED: return SVNConstants.ICONS.IGNORED;
			case SvnStatusCode.EXTERNAL: return SVNConstants.ICONS.EXTERNAL;
			case SvnStatusCode.NORMAL: return SVNConstants.ICONS.UP_TO_DATE;
			default:
				return SVNConstants.ICONS.UNKNOWN;
		}
	}

	/**
	 * Get CSS class for status
	 */
	static getStatusClass(status: SvnStatusCode): string {
		switch (status) {
			case SvnStatusCode.MODIFIED: return SVNConstants.CSS_CLASSES.MODIFIED;
			case SvnStatusCode.ADDED: return SVNConstants.CSS_CLASSES.ADDED;
			case SvnStatusCode.DELETED: return SVNConstants.CSS_CLASSES.DELETED;
			case SvnStatusCode.REPLACED: return SVNConstants.CSS_CLASSES.REPLACED;
			case SvnStatusCode.CONFLICTED: return SVNConstants.CSS_CLASSES.CONFLICTED;
			case SvnStatusCode.UNVERSIONED: return SVNConstants.CSS_CLASSES.UNVERSIONED;
			case SvnStatusCode.MISSING: return SVNConstants.CSS_CLASSES.MISSING;
			case SvnStatusCode.IGNORED: return SVNConstants.CSS_CLASSES.IGNORED;
			case SvnStatusCode.EXTERNAL: return SVNConstants.CSS_CLASSES.EXTERNAL;
			case SvnStatusCode.NORMAL: return SVNConstants.CSS_CLASSES.UP_TO_DATE;
			default:
				return SVNConstants.CSS_CLASSES.UNKNOWN;
		}
	}

	/**
	 * Check if a status indicates the file has changes
	 */
	static hasChanges(status: SvnStatusCode): boolean {
		return status === SvnStatusCode.MODIFIED || 
			   status === SvnStatusCode.ADDED || 
			   status === SvnStatusCode.DELETED || 
			   status === SvnStatusCode.REPLACED ||
			   status === SvnStatusCode.CONFLICTED;
	}

	/**
	 * Check if a status indicates the file is under version control
	 */
	static isVersioned(status: SvnStatusCode): boolean {
		return status !== SvnStatusCode.UNVERSIONED && 
			   status !== SvnStatusCode.IGNORED;
	}

	/**
	 * Convert status character to SvnStatusCode enum
	 */
	static fromChar(char: string): SvnStatusCode {
		switch (char) {
			case 'M': return SvnStatusCode.MODIFIED;
			case 'A': return SvnStatusCode.ADDED;
			case 'D': return SvnStatusCode.DELETED;
			case 'R': return SvnStatusCode.REPLACED;
			case 'C': return SvnStatusCode.CONFLICTED;
			case '?': return SvnStatusCode.UNVERSIONED;
			case '!': return SvnStatusCode.MISSING;
			case 'I': return SvnStatusCode.IGNORED;
			case 'X': return SvnStatusCode.EXTERNAL;
			case ' ': return SvnStatusCode.NORMAL;
			default:
				// Consider logging a warning for unknown status characters
				return SvnStatusCode.UNVERSIONED; // Or a specific 'UNKNOWN' enum if added
		}
	}

	/**
	 * Convert property status character to SvnPropertyStatus enum
	 */
	static propStatusFromChar(char: string): SvnPropertyStatus {
		switch (char) {
			case 'M': return SvnPropertyStatus.MODIFIED;
			case 'C': return SvnPropertyStatus.CONFLICTED;
			case ' ': return SvnPropertyStatus.NORMAL;
			default:
				// Consider logging a warning for unknown property status characters
				return SvnPropertyStatus.NORMAL; // Or a specific 'UNKNOWN' enum if added
		}
	}
}



