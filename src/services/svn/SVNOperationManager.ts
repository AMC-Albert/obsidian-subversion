import { SvnLogEntry, SvnStatus, SvnStatusCode, SvnOperationOptions, SvnCommandResult } from '@/types';
import { NotWorkingCopyError, SvnCommandError } from '@/utils/errors';
import { loggerDebug, loggerInfo, loggerWarn, loggerError } from '@/utils/obsidian-logger';
import { App } from 'obsidian';
import { SVNPathResolver } from './SVNPathResolver';
import { SVNOutputParser } from './SVNOutputParser';
import { SVNCacheManager } from './SVNCacheManager';
import { execPromise } from '@/utils/AsyncUtils';
import { join } from 'path'; // Added join import

/**
 * Manages high-level SVN operations and business logic
 */
export class SVNOperationManager {
	private app: App;
	private svnPath: string;
	private pathResolver: SVNPathResolver;
	private outputParser: SVNOutputParser;
	private cacheManager: SVNCacheManager;
	private cacheInvalidationCallback?: () => void;

	constructor(
		app: App,
		svnPath: string,
		pathResolver: SVNPathResolver,
		outputParser: SVNOutputParser,
		cacheManager: SVNCacheManager
	) {
		this.app = app;
		this.svnPath = svnPath;
		this.pathResolver = pathResolver;
		this.outputParser = outputParser;
		this.cacheManager = cacheManager;

		// Connect cache manager's invalidation to our callback
		this.cacheManager.setCacheInvalidationCallback(() => {
			if (this.cacheInvalidationCallback) {
				this.cacheInvalidationCallback();
			}
		});
	}
	/**
	 * Check if a file is versioned in SVN
	 */
	async isFileInSvn(filePath: string): Promise<boolean> {
		const cacheKey = this.pathResolver.resolveAbsolutePath(filePath);
		
		if (this.cacheManager.hasFileInSvnCache(cacheKey)) {
			return this.cacheManager.getFileInSvnCache(cacheKey)!;
		}

		try {
			const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(filePath);
			if (!workingCopyRoot) {
				this.cacheManager.setFileInSvnCache(cacheKey, false);
				return false;
			}

			// First try svn info - this is the most reliable way to check if file is versioned
			try {
				const info = await this.getInfo(filePath);
				if (info && info.url) {
					this.cacheManager.setFileInSvnCache(cacheKey, true);
					return true;
				}
			} catch (infoError) {
				// Info failed, fall back to status check
			}

			// Fall back to status check for files that might be added but not committed
			const status = await this.getStatus(filePath);
			const fileStatus = status.find(s => this.pathResolver.comparePaths(s.filePath, filePath));
			
			const isVersioned = fileStatus && fileStatus.status !== SvnStatusCode.UNVERSIONED;
			this.cacheManager.setFileInSvnCache(cacheKey, !!isVersioned);
			return !!isVersioned;
		} catch (error: any) {
			loggerWarn(this, `Error checking if file is in SVN: ${error.message}`);
			this.cacheManager.setFileInSvnCache(cacheKey, false);
			return false;
		}
	}
	/**
	 * Get SVN status for a path
	 */
	async getStatus(path?: string, options: SvnOperationOptions = {}): Promise<SvnStatus[]> {
		// Use absolute path for cache key to ensure consistency with invalidation
		const absolutePath = path ? this.pathResolver.resolveAbsolutePath(path) : '__vault_root__';
		const cacheKey = absolutePath + JSON.stringify(options);

		if (this.cacheManager.hasStatusResultCache(cacheKey)) {
			loggerDebug(this, 'Returning cached SVN status for key:', cacheKey);
			return this.cacheManager.getStatusResultCache(cacheKey)!;
		}

		const result = await this._doGetStatus(path, options);
		this.cacheManager.setStatusResultCache(cacheKey, result);
		return result;
	}

	/**
	 * Internal status implementation
	 */
	private async _doGetStatus(path?: string, options: SvnOperationOptions = {}): Promise<SvnStatus[]> {
		try {
			let workingCopyRoot: string | null;
			let targetPath: string;
			const currentVaultPath = this.pathResolver.getVaultPath();

			loggerInfo(this, '_doGetStatus called with path:', path, 'options:', options);

			if (path) {
				const absolutePath = this.pathResolver.resolveAbsolutePath(path);
				workingCopyRoot = this.pathResolver.findSvnWorkingCopy(absolutePath);
				targetPath = absolutePath;
				loggerInfo(this, 'Resolved paths:', {
					originalPath: path,
					absolutePath,
					workingCopyRoot,
					targetPath
				});
			} else {
				workingCopyRoot = this.pathResolver.findSvnWorkingCopy(currentVaultPath || process.cwd());
				targetPath = workingCopyRoot || '';
				loggerInfo(this, 'Using vault path or CWD:', {
					vaultPath: currentVaultPath,
					workingCopyRoot
				});
			}

			if (!workingCopyRoot) {
				if (path) {
					throw new NotWorkingCopyError(targetPath);
				} else if (currentVaultPath && !this.pathResolver.findSvnWorkingCopy(currentVaultPath)) {
					throw new NotWorkingCopyError(currentVaultPath);
				} else if (!currentVaultPath && !this.pathResolver.findSvnWorkingCopy(process.cwd())) {
					throw new NotWorkingCopyError(process.cwd());
				} else {
					const effectiveWcRoot = this.pathResolver.findSvnWorkingCopy(targetPath || currentVaultPath || process.cwd());
					if (!effectiveWcRoot) {
						throw new NotWorkingCopyError(targetPath || currentVaultPath || process.cwd());
					}
					workingCopyRoot = effectiveWcRoot;
					if (!path) targetPath = workingCopyRoot;
				}
			}

			let command = `${this.svnPath} status`;
			command += ` "${targetPath || workingCopyRoot}"`;

			loggerInfo(this, 'Executing SVN status command:', { command, cwd: workingCopyRoot });

			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			if (stderr && stderr.trim() !== '') {
				loggerWarn(this, 'SVN status command produced stderr:', stderr);
				// Handle the case where the node/directory doesn't exist in SVN yet
				if (stderr.includes('was not found') || stderr.includes('W155010')) {
					loggerInfo(this, 'Path not found in SVN working copy, returning empty status');
					return [];
				}
				if (!stdout || stdout.trim() === '') {
					throw new Error(`SVN status failed: ${stderr}`);
				}
			}

			loggerDebug(this, 'Raw SVN status output length:', stdout.length);
			const result = this.outputParser.parseStatus(stdout);
			loggerInfo(this, 'Parsed SVN status result count:', result.length);
			return result;
		} catch (error: any) {
			loggerError(this, 'Error occurred in _doGetStatus:', error.message, error.stack);
			if (error instanceof NotWorkingCopyError) throw error;
			throw new Error(`Failed to get SVN status: ${error.message}`);
		}
	}

	/**
	 * Check if a directory is committed to the repository (not just added)
	 */
	async isDirectoryVersioned(dirPath: string): Promise<boolean> {
		try {
			const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(dirPath);
			if (!workingCopyRoot) {
				return false;
			}
			const command = `${this.svnPath} info "${dirPath}"`;
			loggerInfo(this, `Checking if directory is versioned: ${dirPath}`);
			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			if (stdout && stdout.includes('Path:')) {
				if (stdout.includes('Schedule: add')) {
					loggerInfo(this, `Directory ${dirPath} is added but not committed yet`);
					return false;
				}
				loggerInfo(this, `Directory ${dirPath} is versioned and committed`);
				return true;
			}
			loggerInfo(this, `Directory ${dirPath} is not versioned (no info output)`);
			return false;
		} catch (error: any) {
			loggerInfo(this, `Directory ${dirPath} is not versioned (svn info failed): ${error.message}`);
			return false;
		}
	}

	/**
	 * Invalidate cache for a specific path
	 */
	invalidateCacheForPath(filePath: string): void {
		const absPath = this.pathResolver.resolveAbsolutePath(filePath);
		this.cacheManager.invalidateCacheForPath(absPath, this.pathResolver.getVaultPath());
	}

	async createRepository(repoName: string): Promise<any> { // SvnCommandResult type to be used
		const vaultPath = this.pathResolver.getVaultPath();
		if (!vaultPath) {
			throw new Error('Vault path is not set. Cannot create repository.');
		}
		const hiddenRepoName = `.${repoName}`;
		const repoPath = join(vaultPath, hiddenRepoName);

		// Check if repository already exists
		const fs = require('fs');
		if (fs.existsSync(repoPath)) {
			loggerWarn(this, `Repository already exists at ${repoPath}. Skipping creation.`);
			return { success: true, output: `Repository ${hiddenRepoName} already exists.` };
		}

		const command = `${this.svnPath}admin create "${repoPath}"`;
		loggerInfo(this, 'Executing svnadmin create command:', { command });
		try {
			// svnadmin create doesn't typically need a CWD if paths are absolute, 
			// but providing vaultPath or its parent might be safer depending on svnadmin version/behavior.
			// For simplicity, not setting CWD here as repoPath is absolute.
			const { stdout, stderr } = await execPromise(command);
			loggerInfo(this, 'SVN repository creation successful:', { repoPath, stdout, stderr });
			return { success: true, output: stdout || stderr };
		} catch (error: any) {
			loggerError(this, 'SVN repository creation failed:', { repoPath, error: error.message, stderr: error.stderr });
			throw new Error(`Failed to create repository ${hiddenRepoName}: ${error.message}`); // SvnCommandError to be used
		}
	}

	async getDiff(filePath: string, revision1?: string, revision2?: string): Promise<string> {
		const absolutePath = this.pathResolver.resolveAbsolutePath(filePath);
		const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(absolutePath);
		if (!workingCopyRoot) {
			throw new NotWorkingCopyError(absolutePath);
		}

		let command = `${this.svnPath} diff "${absolutePath}"`;
		if (revision1 && revision2) {
			command += ` -r ${revision1}:${revision2}`;
		} else if (revision1) {
			command += ` -r ${revision1}`;
		}

		loggerInfo(this, 'Executing SVN diff command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			return stdout;
		} catch (error: any) {
			loggerError(this, 'SVN diff failed:', { filePath, error: error.message, stderr: error.stderr });
			throw new Error(`Failed to get diff for ${filePath}: ${error.message}`);
		}
	}

	async getInfo(filePath: string): Promise<any | null> { // SvnInfo type to be used here
		const absolutePath = this.pathResolver.resolveAbsolutePath(filePath);
		const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(absolutePath);
		if (!workingCopyRoot) {
			return null; // Not an error, just no info if not in WC
		}

		const command = `${this.svnPath} info --xml "${absolutePath}"`;
		loggerInfo(this, 'Executing SVN info command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			const info = this.outputParser.parseInfoXml(stdout);
			return info;
		} catch (error: any) {
			loggerWarn(this, `SVN info failed for ${filePath}, likely not versioned or other issue:`, error.message);
			// If info fails (e.g. file not versioned), return null instead of throwing
			return null;
		}
	}

	async getProperties(filePath: string): Promise<any> { // SvnPropertyStatus type to be used here
		const absolutePath = this.pathResolver.resolveAbsolutePath(filePath);
		const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(absolutePath);
		if (!workingCopyRoot) {
			return {}; // Not an error, just no properties if not in WC
		}

		const command = `${this.svnPath} proplist --xml "${absolutePath}"`;
		loggerInfo(this, 'Executing SVN proplist command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			const properties = this.outputParser.parsePropertiesXml(stdout);
			return properties;
		} catch (error: any) {
			loggerWarn(this, `SVN proplist failed for ${filePath}:`, error.message);
			return {}; // Return empty if error (e.g. no properties or not versioned)
		}
	}

	async remove(filePaths: string[], options: SvnOperationOptions = {}): Promise<any> { // SvnCommandResult type to be used
		const absolutePaths = filePaths.map(fp => this.pathResolver.resolveAbsolutePath(fp));
		const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(absolutePaths[0]);
		if (!workingCopyRoot) {
			throw new NotWorkingCopyError(absolutePaths[0]);
		}

		const pathArgs = absolutePaths.map(p => `"${p}"`).join(' ');
		let command = `${this.svnPath} delete ${pathArgs} --non-interactive`;
		if (options.keepLocal) {
			command += ' --keep-local';
		}

		loggerInfo(this, 'Executing SVN delete command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			absolutePaths.forEach(p => this.invalidateCacheForPath(p));
			loggerInfo(this, 'SVN delete successful:', { filePaths, stdout, stderr });
			return { success: true, output: stdout || stderr };
		} catch (error: any) {
			loggerError(this, 'SVN delete failed:', { filePaths, error: error.message, stderr: error.stderr });
			absolutePaths.forEach(p => this.invalidateCacheForPath(p));
			throw new Error(`SVN delete failed: ${error.message}`); // SvnCommandError to be used
		}
	}

	async move(sourcePath: string, destPath: string, options: SvnOperationOptions = {}): Promise<any> { // SvnCommandResult type to be used
		const absoluteSourcePath = this.pathResolver.resolveAbsolutePath(sourcePath);
		const absoluteDestPath = this.pathResolver.resolveAbsolutePath(destPath);
		
		const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(absoluteSourcePath);
		if (!workingCopyRoot) {
			// If source is not in a WC, we might not want to proceed, or handle differently.
			// For now, let's assume SVN move is intended if the source is part of a WC.
			// If the operation is purely a file system move outside SVN, this method shouldn't be called.
			loggerWarn(this, `SVN move: Source path ${sourcePath} is not in a working copy. Skipping SVN move operation.`);
			// We might return a specific status or let the caller handle this based on context.
			// For Obsidian's rename, if SVN move fails or is skipped, Obsidian handles the FS rename.
			return { success: false, skipped: true, message: `Source ${sourcePath} not in SVN working copy.` };
		}

		// Ensure destination parent directory exists for SVN, if it's part of the same WC.
		// SVN move should handle this, but complex scenarios might need checks.

		let command = `${this.svnPath} move "${absoluteSourcePath}" "${absoluteDestPath}" --non-interactive`;
		if (options.force) {
			command += ' --force';
		}
		if (options.addParents) { // SVN move has --parents implicitly for the destination if needed.
			command += ' --parents'; // Explicitly adding, though often default for `svn move`
		}

		loggerInfo(this, 'Executing SVN move command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			this.invalidateCacheForPath(absoluteSourcePath);
			this.invalidateCacheForPath(absoluteDestPath);
			// Invalidate parent directories as well, as their content list changes.
			const sourceDir = this.pathResolver.dirname(absoluteSourcePath);
			const destDir = this.pathResolver.dirname(absoluteDestPath);
			if (sourceDir) this.invalidateCacheForPath(sourceDir);
			if (destDir && destDir !== sourceDir) this.invalidateCacheForPath(destDir);
			
			loggerInfo(this, 'SVN move successful:', { sourcePath, destPath, stdout, stderr });
			return { success: true, output: stdout || stderr };
		} catch (error: any) {
			loggerError(this, 'SVN move failed:', { sourcePath, destPath, error: error.message, stderr: error.stderr });
			// Invalidate caches even on error, as partial operations might have occurred or state is uncertain.
			this.invalidateCacheForPath(absoluteSourcePath);
			this.invalidateCacheForPath(absoluteDestPath);
			const sourceDir = this.pathResolver.dirname(absoluteSourcePath);
			const destDir = this.pathResolver.dirname(absoluteDestPath);
			if (sourceDir) this.invalidateCacheForPath(sourceDir);
			if (destDir && destDir !== sourceDir) this.invalidateCacheForPath(destDir);

			// Check for specific SVN error codes if needed, e.g., if dest already exists and --force not used.
			// For now, rethrow a generic error.
			throw new Error(`SVN move from ${sourcePath} to ${destPath} failed: ${error.message}`); // SvnCommandError to be used
		}
	}

	public async commit(absoluteFilePaths: string[], message: string): Promise<void> {
		if (absoluteFilePaths.length === 0) {
			loggerWarn("SVNOperationManager.commit: No file paths provided to commit.");
			return;
		}		// Ensure message is properly escaped for the command line.
		const processedMessage = message.replace(/"/g, '\\"'); // Escape double quotes within the message for safety.

		// Ensure paths are normalized and quoted. SVN CLI generally prefers forward slashes.
		const pathsString = absoluteFilePaths
			.map(p => `"${p.replace(/\\/g, '/')}"`)
			.join(" ");
		
		const command = `svn commit -m "${processedMessage}" ${pathsString} --non-interactive`;
		
		const vaultPath = this.pathResolver.getVaultPath();
		loggerInfo(`SVNOperationManager.commit: Executing SVN commit. Command: [${command}], CWD: [${vaultPath}], Original Paths Arg: ${JSON.stringify(absoluteFilePaths)}`);
		try {
			await execPromise(command, { cwd: vaultPath });
			loggerInfo(this, `SVNOperationManager.commit: Successfully committed: ${pathsString}`);
			// Invalidate cache for committed paths
			absoluteFilePaths.forEach(filePath => {
				this.cacheManager.invalidateCacheForPath(filePath);
				const parentDir = this.pathResolver.dirname(filePath);
				if (parentDir && parentDir !== filePath) {
					this.cacheManager.invalidateCacheForPath(parentDir); // Also invalidate parent
				}
			});
		} catch (error: any) {
			loggerError(this, "SVNOperationManager.commit: SVN commit command failed.", {
				command,
				cwd: vaultPath,
				error,
			});
			// Construct a more informative error object
			const commandError = new SvnCommandError(
				command,
				error.exitCode ?? 1, // Preserve exit code if available
				error.stderr || error.message || String(error)
			);
			throw commandError;
		}	}	/**
	 * Get SVN log/history for a file or path
	 */
	async getLog(filePath: string, limit?: number): Promise<SvnLogEntry[]> {
		const absolutePath = this.pathResolver.resolveAbsolutePath(filePath);
		
		try {
			const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(filePath);
			if (!workingCopyRoot) {
				throw new Error(`Not in SVN working copy: ${filePath}`);
			}			// Get current working copy info to determine if we're on a past revision
			const svnInfo = await this.getInfo(filePath);
			const currentRevision = svnInfo?.revision;
			
			// Get HEAD revision to check if we're on a past checkout
			const headRevision = await this.getHeadRevision(workingCopyRoot);
			
			loggerDebug(this, `Revision check for ${filePath}: current=${currentRevision}, head=${headRevision}`);
			
			// Determine if we're on a past revision and need full history
			const isPastRevision = currentRevision && headRevision && currentRevision < headRevision;
			
			// Create cache key that includes past revision state
			const cacheKey = `${absolutePath}_${limit || 'all'}_${isPastRevision ? 'past' : 'current'}`;
			
			// Check cache first
			const cached = this.cacheManager.getLogCache(cacheKey);
			if (cached) {
				return cached;
			}

			let command = `${this.svnPath} log --xml --verbose "${absolutePath}"`;
			
			// If we're on a past revision, show full history including future revisions
			if (isPastRevision) {
				loggerInfo(this, `Past revision detected: current=${currentRevision}, head=${headRevision}. Showing full history including future revisions.`);
				// Show from first revision to HEAD to include both past and future
				command += ` -r 1:HEAD`;
			} else if (limit && limit > 0) {
				command += ` --limit ${limit}`;
			}
			
			loggerInfo(this, 'Executing SVN log command:', { command, cwd: workingCopyRoot });
			
			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			
			if (stderr && stderr.trim()) {
				loggerWarn(this, 'SVN log command had warnings:', stderr);
			}
			
			if (!stdout || !stdout.trim()) {
				loggerInfo(this, 'SVN log returned empty output - file may have no history');
				return [];
			}

			// Parse the XML log output
			const logEntries = this.outputParser.parseXmlLog(stdout);
			
			// Enhance log entries with file size information
			const startTime = Date.now();
			const enhancedEntries = await this.enhanceLogEntriesWithSizeInfo(logEntries, absolutePath, workingCopyRoot);
			const enhanceTime = Date.now() - startTime;
			
			// Cache the enhanced results
			const cacheStartTime = Date.now();
			this.cacheManager.setLogCache(cacheKey, enhancedEntries);
			const cacheTime = Date.now() - cacheStartTime;
			
			if (enhanceTime > 1000 || cacheTime > 100) {
				loggerInfo(this, `SVN log performance: enhance=${enhanceTime}ms, cache=${cacheTime}ms for ${enhancedEntries.length} entries`);
			}
			
			loggerInfo(this, `SVN log retrieved ${enhancedEntries.length} entries for: ${filePath}`);
			return enhancedEntries;
			
		} catch (error: any) {
			loggerError(this, 'SVN log command failed:', { filePath, error: error.message });
			// Don't cache errors, but return empty array for graceful handling
			return [];
		}
	}
	/**
	 * Get the HEAD revision number for the repository
	 */
	private async getHeadRevision(workingCopyRoot: string): Promise<number | null> {
		try {
			// Get the HEAD revision from the repository, not the working copy
			const command = `${this.svnPath} info --xml -r HEAD "${workingCopyRoot}"`;
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			
			// Parse HEAD revision from repository info
			const headRevisionMatch = stdout.match(/<entry[^>]*revision="(\d+)"/);
			if (headRevisionMatch) {
				const headRevision = parseInt(headRevisionMatch[1], 10);
				loggerDebug(this, `Found HEAD revision: ${headRevision}`);
				return headRevision;
			}
			
			return null;
		} catch (error: any) {
			loggerDebug(this, `Could not get HEAD revision: ${error.message}`);
			return null;
		}
	}
	public async update(paths?: string[]): Promise<string> {
		if (!paths || paths.length === 0) {
			throw new Error('Update requires at least one path');
		}

		// Update specific paths
		const absolutePaths = paths.map(path => this.pathResolver.resolveAbsolutePath(path));
		const firstPath = absolutePaths[0];
		const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(firstPath);
		
		if (!workingCopyRoot) {
			throw new Error(`Not in SVN working copy: ${firstPath}`);
		}

		const pathArgs = absolutePaths.map(path => `"${path}"`).join(' ');
		const command = `${this.svnPath} update ${pathArgs}`;
		
		loggerInfo(this, 'Executing SVN update command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			
			// Invalidate caches for all updated paths
			absolutePaths.forEach(path => {
				this.cacheManager.invalidateCacheForPath(path);
			});
			
			return stdout;
		} catch (error: any) {
			loggerError(this, 'SVN update failed:', { paths, error: error.message });
			throw new Error(`Failed to update: ${error.message}`);
		}
	}
	/**
	 * Update a file or directory to a specific revision (checkout)
	 */
	public async updateToRevision(filePath: string, revision: string): Promise<string> {
		const absolutePath = this.pathResolver.resolveAbsolutePath(filePath);
		const workingCopyRoot = this.pathResolver.findSvnWorkingCopy(absolutePath);
		
		if (!workingCopyRoot) {
			throw new Error(`Not in SVN working copy: ${filePath}`);
		}

		// Add conflict resolution options to the command
		const command = `${this.svnPath} update -r ${revision} --accept postpone "${absolutePath}"`;
		
		loggerInfo(this, 'Executing SVN update to revision command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			
			// Check if there were conflicts in the output
			if (stderr && (stderr.includes('conflicts') || stderr.includes('conflict'))) {
				loggerWarn(this, 'SVN update resulted in conflicts:', stderr);
			}
			if (stdout && (stdout.includes('conflicts') || stdout.includes('conflict'))) {
				loggerWarn(this, 'SVN update resulted in conflicts:', stdout);
			}
			
			// Invalidate caches for the updated path
			this.cacheManager.invalidateCacheForPath(absolutePath);
			
			return stdout;
		} catch (error: any) {
			loggerError(this, 'SVN update to revision failed:', { filePath, revision, error: error.message });
			throw new Error(`Failed to update to revision ${revision}: ${error.message}`);
		}
	}

	/**
	 * Update a file or directory to HEAD revision
	 */
	public async updateToHead(filePath: string): Promise<string> {
		return this.updateToRevision(filePath, 'HEAD');
	}

	/**
	 * Set callback for cache invalidation notifications
	 */
	setCacheInvalidationCallback(callback: () => void): void {
		this.cacheInvalidationCallback = callback;
	}	/**
	 * Enhance log entries with file size and repository size information
	 */
	private async enhanceLogEntriesWithSizeInfo(
		logEntries: SvnLogEntry[], 
		filePath: string, 
		workingCopyRoot: string
	): Promise<SvnLogEntry[]> {
		// Fetch size info for all entries since parallel execution makes it fast
		const maxSizeEntries = logEntries.length; // No limit on file size entries
		const maxRepoSizeEntries = logEntries.length; // No limit on repo size entries either
		
		// Create enhanced entries array first
		const enhancedEntries: SvnLogEntry[] = logEntries.map(entry => ({ ...entry }));
		
		// Get repository path once for all operations
		let repoPath: string | null = null;
		try {
			repoPath = await this.getRepositoryPath(workingCopyRoot);
		} catch (error) {
			loggerDebug(this, 'Could not get repository path, skipping repo size enhancement');
		}
		
		// Create promises for all size operations to run in parallel
		const sizePromises: Promise<void>[] = [];
		
		// File size promises
		for (let i = 0; i < maxSizeEntries; i++) {
			const entry = enhancedEntries[i];
			if (!entry) continue;
					const fileSizePromise = this.getFileSizeForRevision(entry.revision, filePath, workingCopyRoot)
				.then((size: number | null) => {
					if (size !== null) {
						entry.size = size;
					}
				})
				.catch((error: any) => {
					loggerDebug(this, `Could not get file size for revision ${entry.revision}:`, error.message);
				});
			
			sizePromises.push(fileSizePromise);
		}
		
		// Repository size promises (only for first few entries)
		if (repoPath) {
			for (let i = 0; i < maxRepoSizeEntries; i++) {
				const entry = enhancedEntries[i];
				if (!entry) continue;
						const repoSizePromise = this.getRepoSizeForRevision(entry.revision, repoPath)
					.then((size: number | null) => {
						if (size !== null) {
							entry.repoSize = size;
						}
					})
					.catch((error: any) => {
						loggerDebug(this, `Could not get repo size for revision ${entry.revision}:`, error.message);
					});
				
				sizePromises.push(repoSizePromise);
			}
		}
				// Wait for all size operations to complete in parallel
		await Promise.allSettled(sizePromises);
		
		loggerInfo(this, `Enhanced all ${logEntries.length} log entries with size information`);
		return enhancedEntries;
	}

	/**
	 * Get repository path from working copy
	 */
	private async getRepositoryPath(workingCopyRoot: string): Promise<string | null> {
		try {
			const infoCommand = `${this.svnPath} info --xml "${workingCopyRoot}"`;
			const { stdout } = await execPromise(infoCommand, { cwd: workingCopyRoot });
			
			// Extract repository root from info output
			const repoRootMatch = stdout.match(/<root>([^<]+)<\/root>/);
			if (repoRootMatch) {
				const repoUrl = repoRootMatch[1];
				// Convert file:// URL to local path if it's a local repository
				if (repoUrl.startsWith('file:///')) {
					return repoUrl.replace('file:///', '').replace(/\//g, '\\');
				}
			}
			return null;
		} catch (error) {
			loggerDebug(this, 'Could not determine repository path:', error);
			return null;
		}
	}
	/**
	 * Get file size for a specific revision
	 */
	private async getFileSizeForRevision(revision: number, filePath: string, workingCopyRoot: string): Promise<number | null> {
		try {
			const listCommand = `${this.svnPath} list --xml -r ${revision} "${filePath}"`;
			const { stdout: listOutput } = await execPromise(listCommand, { 
				cwd: workingCopyRoot,
				timeout: 5000 // 5 second timeout
			});
			
			// Parse file size from svn list XML output
			const sizeMatch = listOutput.match(/<size>(\d+)<\/size>/);
			if (sizeMatch) {
				const size = parseInt(sizeMatch[1], 10);
				loggerDebug(this, `Found file size for revision ${revision}: ${size} bytes`);
				return size;
			}
			return null;
		} catch (error: any) {
			loggerDebug(this, `Could not get file size for revision ${revision}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Get repository size for a specific revision
	 */
	private async getRepoSizeForRevision(revision: number, repoPath: string): Promise<number | null> {
		try {
			const revSizeCommand = `svnadmin rev-size "${repoPath}" -r ${revision} -q`;
			const { stdout: revSizeOutput } = await execPromise(revSizeCommand, {
				timeout: 3000 // 3 second timeout for repo size
			});
			
			if (revSizeOutput) {
				const revSize = parseInt(revSizeOutput.trim(), 10);
				if (!isNaN(revSize)) {
					loggerDebug(this, `Found repository size for revision ${revision}: ${revSize} bytes`);
					return revSize;
				}
			}
			return null;
		} catch (error: any) {
			loggerDebug(this, `Could not get repository size for revision ${revision}: ${error.message}`);
			return null;
		}
	}
}
