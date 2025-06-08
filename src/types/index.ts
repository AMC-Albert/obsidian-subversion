/**
 * Core types and interfaces for the SVN plugin
 */

/**
 * SVN file status codes as defined by SVN
 * @see https://svnbook.red-bean.com/en/1.7/svn.ref.svn.html#svn.ref.svn.sw.status
 */
export enum SvnStatusCode {
    /** Modified - File has local modifications */
    MODIFIED = 'M',
    /** Added - File scheduled for addition */
    ADDED = 'A',
    /** Deleted - File scheduled for deletion */
    DELETED = 'D',
    /** Replaced - File was replaced */
    REPLACED = 'R',
    /** Conflicted - File has merge conflicts */
    CONFLICTED = 'C',
    /** Unversioned - File is not under version control */
    UNVERSIONED = '?',
    /** Missing - File is missing from working copy */
    MISSING = '!',
    /** Ignored - File matches an ignore pattern */
    IGNORED = 'I',
    /** External - File is external */
    EXTERNAL = 'X',
    /** Normal - File is up to date (no status output) */
    NORMAL = ' '
}

/**
 * SVN property status codes (second column in svn status output)
 */
export enum SvnPropertyStatus {
    /** Property modified */
    MODIFIED = 'M',
    /** Property conflicted */
    CONFLICTED = 'C',
    /** Normal - no property changes */
    NORMAL = ' '
}

/**
 * Enhanced SVN status with strict typing
 */
export interface SvnStatus {
    /** Primary status code for the file content */
    status: SvnStatusCode;
    /** Property status (usually space for most files) */
    propertyStatus?: SvnPropertyStatus;
    /** Absolute path to the file */
    filePath: string;
    /** Whether the file is locked (SVN lock) */
    locked?: boolean;
    /** Whether there's a working copy lock */
    workingCopyLocked?: boolean;
}

/**
 * SVN log entry with enhanced type safety
 */
export interface SvnLogEntry {
    /** Revision number (always numeric in SVN) */
    revision: number;
    /** Author of the commit */
    author: string;
    /** ISO 8601 formatted date string */
    date: string;
    /** Commit message */
    message: string;
    /** File size in bytes (optional, for specific file queries) */
    size?: number;
    /** Repository storage size for this revision in bytes (optional) */
    repoSize?: number;
    /** Changed paths in this revision */
    changedPaths?: SvnChangedPath[];
}

/**
 * SVN changed path information
 */
export interface SvnChangedPath {
    /** The action performed (A=Added, M=Modified, D=Deleted, R=Replaced) */
    action: 'A' | 'M' | 'D' | 'R';
    /** Path that was changed */
    path: string;
    /** Copy source path (for moves/copies) */
    copyFromPath?: string;
    /** Copy source revision (for moves/copies) */
    copyFromRevision?: number;
}

/**
 * SVN blame entry with enhanced type safety
 */
export interface SvnBlameEntry {
    /** Line number (1-based) */
    lineNumber: number;
    /** Revision number where this line was last changed */
    revision: number;
    /** Author who last modified this line */
    author: string;
    /** ISO 8601 formatted date when line was last changed */
    date: string;
    /** The actual line content (optional) */
    content?: string;
}

/**
 * SVN repository information with enhanced type safety
 */
export interface SvnInfo {
    /** Repository URL for this working copy */
    url: string;
    /** Root URL of the repository */
    repositoryRoot: string;
    /** Repository UUID */
    repositoryUuid: string;
    /** Current working copy revision */
    revision: number;
    /** Last changed revision */
    lastChangedRev: number;
    /** Author of last change */
    lastChangedAuthor: string;
    /** ISO 8601 formatted date of last change */
    lastChangedDate: string;
    /** Node kind (file, dir, etc.) */
    nodeKind?: 'file' | 'dir' | 'none' | 'unknown';
    /** Working copy schedule */
    schedule?: 'normal' | 'add' | 'delete' | 'replace';
}

/**
 * Plugin settings with enhanced validation and type safety
 */
export interface SvnPluginSettings {
    /** Path to SVN binary executable */
    svnBinaryPath: string;
    /** Default commit message template */
    commitMessage: string;
    /** Whether to auto-commit changes */
    autoCommit: boolean;
    /** Repository display name */
    repositoryName: string;
    /** Maximum number of log entries to fetch */
    maxLogEntries?: number;
    /** Timeout for SVN operations in milliseconds */
    operationTimeout?: number;
    /** Whether to show unversioned files */
    showUnversioned?: boolean;
    /** Whether to show ignored files */
    showIgnored?: boolean;
}

/**
 * Plugin constants with strict typing
 */
export interface PluginConstants {
    readonly VIEW_TYPE: string;
    readonly ICON_ID: string;
    readonly PLUGIN_NAME: string;
}

/**
 * SVN commands with strict typing
 */
export type SvnCommand = 
    | 'status'
    | 'log'
    | 'diff'
    | 'commit'
    | 'revert'
    | 'add'
    | 'remove'
    | 'info'
    | 'blame'
    | 'update'
    | 'checkout'
    | 'cleanup'
    | 'resolve'
    | 'lock'
    | 'unlock';

/**
 * Enhanced SVN command result with better error handling
 */
export interface SvnCommandResult<T = string> {
    /** Whether the command succeeded */
    success: boolean;
    /** Command output (parsed data for typed commands) */
    output: T;
    /** Error message if command failed */
    error?: string;
    /** Command that was executed */
    command?: string;
    /** Exit code from the command */
    exitCode?: number;
    /** Execution time in milliseconds */
    executionTime?: number;
}

/**
 * SVN operation options
 */
export interface SvnOperationOptions {
    /** Working directory for the command */
    cwd?: string;
    /** Command timeout in milliseconds */
    timeout?: number;
    /** Additional arguments to pass to the command */
    args?: string[];
    /** Whether to include output in the result */
    includeOutput?: boolean;
}

/**
 * Utility types for type-safe operations
 */

/** Utility type for SVN status filters */
export type SvnStatusFilter = 
    | 'all'
    | 'modified'
    | 'unversioned'
    | 'versioned'
    | 'conflicted'
    | 'missing';

/** Event payload types for type-safe event handling */
export interface SvnStatusChangeEvent {
    filePath: string;
    oldStatus?: SvnStatus;
    newStatus: SvnStatus;
    timestamp: Date;
}

export interface SvnOperationEvent {
    operation: SvnCommand;
    filePaths: string[];
    success: boolean;
    timestamp: Date;
    message?: string;
}

/** Repository state information */
export interface RepositoryState {
    /** Whether we're in a valid SVN working copy */
    inWorkingCopy: boolean;
    /** Repository root URL if available */
    repositoryRoot?: string;
    /** Current working copy revision */
    revision?: number;
    /** Whether there are uncommitted changes */
    hasChanges: boolean;
    /** Last update timestamp */
    lastChecked: Date;
}

/**
 * File state information for enhanced UI rendering
 */
export interface FileState {
    /** File path */
    path: string;
    /** SVN status */
    status?: SvnStatus;
    /** Whether file exists in working copy */
    exists: boolean;
    /** Whether file is under version control */
    versioned: boolean;
    /** File type/extension */
    fileType?: string;
    /** File size in bytes */
    size?: number;
    /** Last modified timestamp */
    lastModified?: Date;
}

/**
 * Enhanced async operation wrapper for better error handling
 */
export type AsyncResult<T> = Promise<{
    success: true;
    data: T;
} | {
    success: false;
    error: string;
    details?: any;
}>;

/**
 * Debounced function type for performance optimization
 */
export type DebouncedFunction<T extends (...args: any[]) => any> = (
    ...args: Parameters<T>
) => void;

/**
 * Cache entry with expiration
 */
export interface CacheEntry<T> {
    data: T;
    timestamp: number;
    expiresAt: number;
}

/**
 * Progress callback for long-running operations
 */
export type ProgressCallback = (
    current: number,
    total: number,
    message?: string
) => void;

/**
 * Operation cancellation token
 */
export interface CancellationToken {
    isCancelled: boolean;
    cancel: () => void;
    onCancelled: (callback: () => void) => void;
}




