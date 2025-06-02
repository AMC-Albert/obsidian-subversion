/**
 * Centralized constants for the SVN plugin
 * All user-facing text, icons, and other constants are defined here.
 */
export class SVNConstants {
	/**
	 * 🎨 ICON CUSTOMIZATION
	 * All icons used throughout the SVN plugin are defined here.
	 * You can customize any icon by changing the unicode symbol below:
	 */
	static readonly ICONS = {
		// 📁 File Status Icons - Used for actual SVN file states
		MODIFIED: '🔄', // Files with local changes
		ADDED: '➕', // Files staged for addition
		DELETED: '➖', // Files staged for deletion
		REPLACED: '🔄', // Files that were replaced
		CONFLICTED: '⚠️', // Files with merge conflicts
		UNVERSIONED: '❓', // Files not tracked by SVN
		MISSING: '❌', // Files missing from working copy
		UP_TO_DATE: '✅', // Files with no changes
		
		// 🚀 Special Status Icons - Used for system states
		NOT_IN_WORKING_COPY: '📁',  // File/folder not in SVN repository
		ERROR: '❌', // Error states (failed operations)
		LOADING: '⏳', // Loading/processing states
		UNKNOWN: '❔' // Unknown or unexpected states
	} as const;

	/**
	 * 📝 MESSAGE CUSTOMIZATION
	 * All user-facing messages are defined here.
	 */
	static readonly MESSAGES = {
		// File Status Messages
		MODIFIED: 'Modified',
		ADDED: 'Added',
		DELETED: 'Deleted',
		REPLACED: 'Replaced',
		CONFLICTED: 'Conflicted',
		UNVERSIONED: 'Unversioned',
		MISSING: 'Missing',
		UP_TO_DATE: 'Up to date',
		
		// Special Status Messages
		NOT_IN_WORKING_COPY: 'Not in SVN working copy',
		ERROR_GETTING_STATUS: 'Error getting status',
		LOADING: 'Loading...',
		UNKNOWN_STATUS: 'Unknown status',
		
		// General Messages
		NO_FILE_SELECTED: 'No file selected',
		FILE_NOT_FOUND: 'File not found',
		OPERATION_FAILED: 'Operation failed',
		OPERATION_SUCCESSFUL: 'Operation successful'
	} as const;

	/**
	 * 🎨 CSS CLASS NAMES
	 * CSS classes used for styling different status types
	 */
	static readonly CSS_CLASSES = {
		MODIFIED: 'svn-status-modified',
		ADDED: 'svn-status-added',
		DELETED: 'svn-status-deleted',
		REPLACED: 'svn-status-replaced',
		CONFLICTED: 'svn-status-conflicted',
		UNVERSIONED: 'svn-status-unversioned',
		MISSING: 'svn-status-missing',
		UP_TO_DATE: 'svn-status-clean',
		WARNING: 'svn-status-warning',
		ERROR: 'svn-status-error',
		UNKNOWN: 'svn-status-unknown'
	} as const;
}