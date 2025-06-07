import { SVNConstants } from './SVNConstants';

/**
 * Centralized SVN status utilities
 * 
 * Uses constants from SVNConstants for consistent icons, messages, and CSS classes.
 */
export class SVNStatusUtils {
	/**
	 * Get human-readable status text
	 */
	static getStatusText(status: string): string {
		switch (status) {
			case 'M': return SVNConstants.MESSAGES.MODIFIED;
			case 'A': return SVNConstants.MESSAGES.ADDED;
			case 'D': return SVNConstants.MESSAGES.DELETED;
			case 'R': return SVNConstants.MESSAGES.REPLACED;
			case 'C': return SVNConstants.MESSAGES.CONFLICTED;
			case '?': return SVNConstants.MESSAGES.UNVERSIONED;
			case '!': return SVNConstants.MESSAGES.MISSING;
			default: return status || SVNConstants.MESSAGES.UNKNOWN_STATUS;
		}
	}

	/**
	 * Get icon for status
	 */
	static getStatusIcon(status: string): string {
		switch (status) {
			case 'M': return SVNConstants.ICONS.MODIFIED;
			case 'A': return SVNConstants.ICONS.ADDED;
			case 'D': return SVNConstants.ICONS.DELETED;
			case 'R': return SVNConstants.ICONS.REPLACED;
			case 'C': return SVNConstants.ICONS.CONFLICTED;
			case '?': return SVNConstants.ICONS.UNVERSIONED;
			case '!': return SVNConstants.ICONS.MISSING;
			default: return SVNConstants.ICONS.UP_TO_DATE;
		}
	}

	/**
	 * Get CSS class for status
	 */
	static getStatusClass(status: string): string {
		switch (status) {
			case 'M': return SVNConstants.CSS_CLASSES.MODIFIED;
			case 'A': return SVNConstants.CSS_CLASSES.ADDED;
			case 'D': return SVNConstants.CSS_CLASSES.DELETED;
			case 'R': return SVNConstants.CSS_CLASSES.REPLACED;
			case 'C': return SVNConstants.CSS_CLASSES.CONFLICTED;
			case '?': return SVNConstants.CSS_CLASSES.UNVERSIONED;
			case '!': return SVNConstants.CSS_CLASSES.MISSING;
			default: return SVNConstants.CSS_CLASSES.UNKNOWN;
		}
	}
}



