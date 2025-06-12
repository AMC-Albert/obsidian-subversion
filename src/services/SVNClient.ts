import { spawn } from 'child_process'; // Added spawn
import { join, dirname, isAbsolute, relative, basename } from 'path'; // Added basename
import { existsSync, statSync, createWriteStream } from 'fs'; // Added createWriteStream
import * as fs from 'fs/promises'; // For async file operations
import { SvnLogEntry, SvnStatus, SvnCommandResult, SvnBlameEntry, SvnInfo, SvnStatusCode, SvnPropertyStatus, SvnOperationOptions } from '@/types';
import { SvnError, SvnNotInstalledError, NotWorkingCopyError, SvnCommandError } from '@/utils/errors';
// import { SVNStatusUtils } from '@/utils'; // No longer directly used for parsing here
import { loggerDebug, loggerInfo, loggerWarn, loggerError, registerLoggerClass } from '@/utils/obsidian-logger';
import { execPromise } from '@/utils/AsyncUtils'; // Import centralized execPromise
import { App } from 'obsidian';
import { SVNOutputParser } from './svn/SVNOutputParser';
import { SVNPathResolver } from './svn/SVNPathResolver';
import { SVNCacheManager } from './svn/SVNCacheManager';
import { SVNOperationManager } from './svn/SVNOperationManager';
import { SVNSidecarManager } from './svn/SVNSidecarManager'; 

export class SVNClient {
	private svnPath: string;
	private previewCacheDir: string; // For SVNClient's own direct caching, if any.
	private app: App;
	private outputParser: SVNOutputParser;
	private pathResolver: SVNPathResolver;
	private cacheManager: SVNCacheManager;
	private operationManager: SVNOperationManager;
	private sidecarManager: SVNSidecarManager;
	private cacheInvalidationCallback?: () => void;
	constructor(app: App, svnPath: string = 'svn', vaultPath: string = '') {		this.app = app;
		this.svnPath = svnPath;
		
		this.outputParser = new SVNOutputParser();
		this.pathResolver = new SVNPathResolver(vaultPath);
		this.cacheManager = new SVNCacheManager();
		// Corrected SVNOperationManager instantiation
		this.operationManager = new SVNOperationManager(app, svnPath, this.pathResolver, this.outputParser, this.cacheManager);
		// Corrected SVNSidecarManager instantiation
		this.sidecarManager = new SVNSidecarManager(app, svnPath, this.pathResolver);
		
		// Connect operation manager's cache invalidation to this client's callback
		this.operationManager.setCacheInvalidationCallback(() => {
			// Forward the invalidation to any registered callback
			if (this.cacheInvalidationCallback) {
				this.cacheInvalidationCallback();
			}
		});
		
		const currentVaultPath = this.pathResolver.getVaultPath();
		
		if (currentVaultPath) {
			// Distinct cache dir for SVNClient itself, if it ever needs one.
			this.previewCacheDir = join(currentVaultPath, '.obsidian', 'plugins', 'obsidian-subversion', 'preview_cache_svnclient');
		} else {
			this.previewCacheDir = ''; 
		}
		registerLoggerClass(this, 'SVNClient');
	}

	// Delegate path operations to SVNPathResolver
	resolveAbsolutePath(filePath: string): string {
		return this.pathResolver.resolveAbsolutePath(filePath);
	}

	// Add getDisplayPath to SVNClient, delegating to SVNPathResolver
	getDisplayPath(filePath: string): string {
		return this.pathResolver.getDisplayPath(filePath);
	}

	// Add isSubpath to SVNClient, delegating to SVNPathResolver
	isSubpath(parent: string, child: string): boolean {
		return this.pathResolver.isSubpath(parent, child);
	}

	findSvnWorkingCopy(filePathOrDirPath: string): string | null {
		return this.pathResolver.findSvnWorkingCopy(filePathOrDirPath);
	}

	dirname(filePath: string): string {
		return this.pathResolver.dirname(filePath);
	}

	basename(filePath: string): string {
		return this.pathResolver.basename(filePath);
	}

	/**
	 * Compare two file paths for equality, handling different path separators and relative/absolute paths
	 */
	comparePaths(path1: string, path2: string): boolean {
		return this.pathResolver.comparePaths(path1, path2);
	}	/**
	 * Set callback for cache invalidation notifications
	 */
	setCacheInvalidationCallback(callback: () => void): void {
		this.cacheInvalidationCallback = callback;
		this.cacheManager.setCacheInvalidationCallback(callback);
	}

	setVaultPath(vaultPath: string) {
		this.pathResolver.setVaultPath(vaultPath); 
		this.sidecarManager.setVaultPath(vaultPath); // Update sidecarManager too
		
		const currentVaultPath = this.pathResolver.getVaultPath();
		if (currentVaultPath) {
			this.previewCacheDir = join(currentVaultPath, '.obsidian', 'plugins', 'obsidian-subversion', 'preview_cache_svnclient');
		} else {
			this.previewCacheDir = '';
		}		// Clear all caches as vault path change can affect many things.
		this.cacheManager.clearAllCaches();
	}

	getVaultPath(): string {
		return this.pathResolver.getVaultPath();
	}

	// Public accessors for SVNOperationManager methods
	async createRepository(repoName: string): Promise<SvnCommandResult> {
		return this.operationManager.createRepository(repoName);
	}

	async getDiff(filePath: string, revision1?: string, revision2?: string): Promise<string> {
		return this.operationManager.getDiff(filePath, revision1, revision2);
	}

	async getInfo(filePath: string): Promise<SvnInfo | null> {
		return this.operationManager.getInfo(filePath);
	}

	async getProperties(filePath: string): Promise<SvnPropertyStatus> {
		return this.operationManager.getProperties(filePath);
	}

	async remove(filePaths: string[], options: SvnOperationOptions = {}): Promise<SvnCommandResult> {
		return this.operationManager.remove(filePaths, options);
	}

	/**
	 * Moves or renames a file or directory in SVN.
	 * @param sourcePath The current path of the item.
	 * @param destPath The new path for the item.
	 * @param options Additional options for the move operation.
	 * @returns A promise that resolves with the command result.
	 */	async move(sourcePath: string, destPath: string, options: SvnOperationOptions = {}): Promise<SvnCommandResult & { skipped?: boolean; message?: string }> {		try {
			const result = await this.operationManager.move(sourcePath, destPath, options);
			return result;
		} catch (error: any) {
			loggerError(this, `SVNClient: Error during move operation from "${sourcePath}" to "${destPath}"`, { error: error.message, stack: error.stack });
			throw new Error(`SVN move failed: ${error.message}`);
		}
	}

	/**
	 * Update a file or directory to a specific revision
	 */
	async updateToRevision(filePath: string, revision: string): Promise<string> {
		return this.operationManager.updateToRevision(filePath, revision);
	}

	/**
	 * Update a file or directory to HEAD revision
	 */
	async updateToHead(filePath: string): Promise<string> {
		return this.operationManager.updateToHead(filePath);
	}

	/**
	 * Check if a file is versioned in SVN
	 */
	async isFileInSvn(filePath: string): Promise<boolean> {
		return this.operationManager.isFileInSvn(filePath);
	}

	/**
	 * Get SVN status for a path
	 */
	async getStatus(path?: string, options: SvnOperationOptions = {}): Promise<SvnStatus[]> {
		return this.operationManager.getStatus(path, options);
	}

	/**
	 * Ensure a file is added to SVN if it's not already versioned
	 */
	private async ensureFileIsAdded(filePath: string): Promise<void> {
		try {
			const workingCopyRoot = this.findSvnWorkingCopy(filePath);
			if (!workingCopyRoot) {
				throw new Error(`File ${filePath} is not in an SVN working copy`);
			}			const isVersioned = await this.isFileInSvn(filePath);
			if (!isVersioned) {
				await this.add(filePath, { addParents: true }); 
			} else {
				const status = await this.getStatus(filePath);
				const fileStatus = status.find(s => this.comparePaths(s.filePath, filePath));

				if (fileStatus && fileStatus.status === SvnStatusCode.ADDED) {
					// File is already added to SVN
				} else {
					// File is already versioned
				}
			}
		} catch (error) {
			loggerError(this, `Error ensuring file is added: ${(error as Error).message}`);
			throw new Error(`Failed to ensure file is added to SVN: ${(error as Error).message}`);
		}
	}

	/**
	 * Check if a directory is committed to the repository (not just added)
	 */
	private async isDirectoryVersioned(dirPath: string): Promise<boolean> {
		return this.operationManager.isDirectoryVersioned(dirPath);
	}
	/**
	 * Clears all SVN related caches.
	 */
	public clearAllCaches(): void {
		loggerInfo(this, 'clearAllCaches: Clearing all SVN caches via CacheManager');
		this.cacheManager.clearAllCaches();
	}

	/**
	 * Invalidate cache for a specific path.
	 */	public invalidateCacheForPath(filePath: string): void {
		loggerDebug(this, `invalidateCacheForPath: Invalidating caches for ${this.getDisplayPath(filePath)} via OperationManager`);
		this.operationManager.invalidateCacheForPath(filePath);
	}

	/**
	 * Get sidecar/preview suffix for a file path using SVNSidecarManager.
	 */
	getSidecarSuffix(filePath: string): string {
		return this.sidecarManager.getSidecarSuffix(filePath);
	}

	/**
	 * Get local preview image path using SVNSidecarManager.
	 * This checks the cache; it does not perform an SVN export.
	 */
	async getLocalPreviewImage(filePath: string, revision?: number): Promise<string | null> {
		return this.sidecarManager.getLocalPreviewImage(filePath, revision);
	}

	/**
	 * Check if a path is part of an SVN working copy.
	 * @param filePath The path to check.
	 * @returns True if the path is in a working copy, false otherwise.
	 */
	async isWorkingCopy(filePath: string): Promise<boolean> {
		return !!this.pathResolver.findSvnWorkingCopy(filePath);
	}    /**
	 * Get the SVN log for a file or directory.
	 * @param filePath The path to get the log for.
	 * @param limit Optional limit for the number of log entries.
	 * @returns A promise that resolves with an array of log entries.
	 */	async getFileHistory(filePath: string, limit?: number): Promise<SvnLogEntry[]> {
		return this.operationManager.getLog(filePath, limit);
	}

	// Method to get the underlying SVNOperationManager instance
	getOperationManager(): SVNOperationManager {
		return this.operationManager;
	}

	// Method to get the underlying SVNSidecarManager instance
	getSidecarManager(): SVNSidecarManager {
		return this.sidecarManager;
	}

	// Method to get the underlying SVNPathResolver instance
	getPathResolver(): SVNPathResolver {
		return this.pathResolver;
	}

	// Method to get the underlying SVNCacheManager instance
	getCacheManager(): SVNCacheManager {
		return this.cacheManager;
	}

	// Method to get the underlying SVNOutputParser instance
	getOutputParser(): SVNOutputParser {
		return this.outputParser;
	}

	async add(filePath: string, options: SvnOperationOptions = {}): Promise<SvnCommandResult> {
		const absolutePath = this.resolveAbsolutePath(filePath);
		const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
		if (!workingCopyRoot) {
			throw new NotWorkingCopyError(absolutePath);
		}

		const addParentsOption = options.addParents !== undefined ? options.addParents : true;

		if (addParentsOption) {
			const parentsToEnsureAdded = [];
			let currentParent = this.dirname(absolutePath);

			while (currentParent && currentParent !== workingCopyRoot && this.isSubpath(workingCopyRoot, currentParent)) {
				loggerInfo(this, `SVNClient.add: Checking parent ${this.getDisplayPath(currentParent)} for version status (getInfo then getStatus).`);
				this.invalidateCacheForPath(currentParent); // Ensure fresh data
				const parentInfo = await this.getInfo(currentParent);
				if (parentInfo?.url) {
					loggerInfo(this, `SVNClient.add: Parent directory ${this.getDisplayPath(currentParent)} is already versioned (URL). Stop collecting parents.`);
					break;
				}
				const parentStatusArray = await this.getStatus(currentParent);
				const parentSvnStatus = parentStatusArray.find(s => this.comparePaths(s.filePath, currentParent));
				if (parentSvnStatus && [SvnStatusCode.ADDED, SvnStatusCode.NORMAL, SvnStatusCode.MODIFIED, SvnStatusCode.REPLACED, SvnStatusCode.CONFLICTED].includes(parentSvnStatus.status)) {
					loggerInfo(this, `SVNClient.add: Parent directory ${this.getDisplayPath(currentParent)} is already managed (status ${parentSvnStatus.status}). Stop collecting parents.`);
					break;
				}
				parentsToEnsureAdded.unshift(currentParent);
				const nextParent = this.dirname(currentParent);
				if (nextParent === currentParent) break;
				currentParent = nextParent;
			}

			for (const dirToEnsure of parentsToEnsureAdded) {
				loggerInfo(this, `SVNClient.add: Ensuring parent directory ${this.getDisplayPath(dirToEnsure)} is added (recursively calling add).`);
				try {
					// Recursive call with addParents: false
					await this.add(dirToEnsure, { addParents: false });
					loggerInfo(this, `SVNClient.add: Successfully ensured parent ${this.getDisplayPath(dirToEnsure)} is managed.`);
				} catch (parentAddError: any) {
					loggerError(this, `SVNClient.add: Failed to ensure parent directory ${this.getDisplayPath(dirToEnsure)} was added. Error: ${parentAddError.message}`);
					throw parentAddError;
				}
			}
		}

		// Now, handle the main file/directory to be added (absolutePath)
		loggerInfo(this, `SVNClient.add: Checking main target ${this.getDisplayPath(absolutePath)} before 'svn add' command.`);
		this.invalidateCacheForPath(absolutePath); // Ensure fresh info/status for checks below
		const infoPreAdd = await this.getInfo(absolutePath);
		if (infoPreAdd?.url) {
			loggerInfo(this, `SVNClient.add: Main target ${this.getDisplayPath(absolutePath)} already has URL: ${infoPreAdd.url}. Skipping add.`);
			return { success: true, output: 'Already managed (has URL).' };
		}
		const statusArrayPreAdd = await this.getStatus(absolutePath);
		const fileStatusPreAdd = statusArrayPreAdd.find(s => this.comparePaths(s.filePath, absolutePath));
		if (fileStatusPreAdd && [SvnStatusCode.ADDED, SvnStatusCode.MODIFIED, SvnStatusCode.NORMAL, SvnStatusCode.REPLACED, SvnStatusCode.CONFLICTED].includes(fileStatusPreAdd.status)) {
			loggerInfo(this, `SVNClient.add: Main target ${this.getDisplayPath(absolutePath)} already has status ${fileStatusPreAdd.status}. Skipping add.`);
			return { success: true, output: `Already managed (status ${fileStatusPreAdd.status}).` };
		}
		loggerInfo(this, `SVNClient.add: Main target ${this.getDisplayPath(absolutePath)} appears unmanaged (no URL, status: ${fileStatusPreAdd?.status}). Proceeding with 'svn add'.`);
		
		let command = `${this.svnPath} add "${absolutePath}" --non-interactive`;
		// --parents is added here only if the original call to this.add specified it.
		// The loop above handles parents for the primary call. Recursive calls for parents have addParents: false.
		if (options.addParents) { 
			command += ' --parents';
		}
		loggerInfo(this, 'SVNClient.add: Executing SVN add command for main target:', { command, cwd: workingCopyRoot });

		try {
			await execPromise(command, { cwd: workingCopyRoot });
			this.invalidateCacheForPath(absolutePath); // Invalidate after successful operation
			const statusArrayPostAdd = await this.getStatus(absolutePath); // Check status after add
			const fileStatusPostAdd = statusArrayPostAdd.find(s => this.comparePaths(s.filePath, absolutePath));

			if (fileStatusPostAdd && fileStatusPostAdd.status === SvnStatusCode.ADDED) {
				loggerInfo(this, `SVNClient.add: 'svn add' successful for ${this.getDisplayPath(absolutePath)}, status is ADDED.`);
				return { success: true, output: 'Successfully added.' };
			} else {
				loggerWarn(this, `SVNClient.add: 'svn add' for ${this.getDisplayPath(absolutePath)} executed, but status is ${fileStatusPostAdd?.status} (expected ADDED).`);
				// Check if the status is something other than unversioned or ignored. 
				// If it's ADDED, NORMAL, MODIFIED, etc., it's likely okay.
				if (fileStatusPostAdd && 
					fileStatusPostAdd.status !== SvnStatusCode.UNVERSIONED && 
					fileStatusPostAdd.status !== SvnStatusCode.IGNORED &&
					fileStatusPostAdd.status !== SvnStatusCode.MISSING // Added MISSING as another non-managed state
				) {
					return { success: true, output: `Add command run, final status for ${this.getDisplayPath(absolutePath)}: ${fileStatusPostAdd.status}` };
				}
				throw new SvnCommandError(command, 0, `SVN add command run for ${this.getDisplayPath(absolutePath)} but status remains ${fileStatusPostAdd?.status}.`);
			}
		} catch (error: any) {
			this.invalidateCacheForPath(absolutePath); // Invalidate on error too
			if (error.stderr && error.stderr.includes('W150002')) {
				loggerInfo(this, `SVNClient.add: 'svn add' for ${this.getDisplayPath(absolutePath)} resulted in W150002. Verifying status.`);
				const statusArrayPostW150002 = await this.getStatus(absolutePath); // Check status
				const fileStatusPostW150002 = statusArrayPostW150002.find(s => this.comparePaths(s.filePath, absolutePath));

				if (fileStatusPostW150002 && [SvnStatusCode.ADDED, SvnStatusCode.MODIFIED, SvnStatusCode.NORMAL, SvnStatusCode.REPLACED, SvnStatusCode.CONFLICTED].includes(fileStatusPostW150002.status)) {
					loggerInfo(this, `SVNClient.add: Confirmed ${this.getDisplayPath(absolutePath)} is managed (status: ${fileStatusPostW150002.status}) after W150002.`);
					return { success: true, output: error.stdout || error.stderr || `Already managed (W150002, status ${fileStatusPostW150002.status}).` };
				} else {
					const errorMessage = `W150002 for ${this.getDisplayPath(absolutePath)}, but status is ${fileStatusPostW150002?.status}. This is inconsistent.`;
					loggerError(this, `SVNClient.add: ${errorMessage} Original stderr: ${error.stderr}`);
					throw new SvnCommandError(command, error.code, `${errorMessage} Original stderr: ${error.stderr}`);
				}
			}
			loggerError(this, 'SVNClient.add: SVN add failed for main target:', { filePath: this.getDisplayPath(absolutePath), error: error.message, stderr: error.stderr });
			throw new SvnCommandError(command, error.code, error.stderr || error.message);
		}
	}

	async commit(filePaths: string[], message: string, options: SvnOperationOptions = {}): Promise<SvnCommandResult> {
		if (!filePaths || filePaths.length === 0) {
			return { success: false, output: '', error: 'No files provided to commit.' };
		}

		const absoluteFilePaths = filePaths.map(p => this.resolveAbsolutePath(p));
		const workingCopyRoot = this.findSvnWorkingCopy(absoluteFilePaths[0]); 

		if (!workingCopyRoot) {
			throw new NotWorkingCopyError(absoluteFilePaths[0]);
		}
		const finalPathsToCommit: string[] = [];
		const parentPathsToEnsureExist = new Set<string>();
		for (const absoluteFilePath of absoluteFilePaths) {
			let currentParent = this.dirname(absoluteFilePath);
			loggerDebug(this, `SVNClient.commit: Starting parent collection from: ${this.getDisplayPath(currentParent)}`);
			
			while (currentParent && currentParent !== workingCopyRoot) {
				const isSubpathResult = this.isSubpath(workingCopyRoot, currentParent);
				
				if (!isSubpathResult) {
					loggerDebug(this, `SVNClient.commit: Parent ${this.getDisplayPath(currentParent)} is not a subpath of working copy root, stopping collection`);
					break;
				}
				
				parentPathsToEnsureExist.add(currentParent);
				const nextParent = this.dirname(currentParent);
				if (nextParent === currentParent) {
					break; // Reached root
				}
				currentParent = nextParent;
			}
		}		const sortedParentPaths = Array.from(parentPathsToEnsureExist).sort((a, b) => a.length - b.length);
		
		if (sortedParentPaths.length > 0) {
			loggerInfo(this, `SVNClient.commit: Need to ensure ${sortedParentPaths.length} parent directories are versioned: ${sortedParentPaths.map(p => this.getDisplayPath(p)).join(', ')}`);
		}
		for (const dirToAdd of sortedParentPaths) { 
			loggerDebug(this, `SVNClient.commit: Checking parent directory ${this.getDisplayPath(dirToAdd)} before potential add.`);
			this.invalidateCacheForPath(dirToAdd); // Ensure fresh data for checks
			const svnInfo = await this.getInfo(dirToAdd);

			if (svnInfo?.url) {
				loggerDebug(this, `SVNClient.commit: Parent directory ${this.getDisplayPath(dirToAdd)} is already versioned (URL: ${svnInfo.url}). No add needed.`);
			} else {
				const statusArrayParent = await this.getStatus(dirToAdd);
				const parentSvnStatus = statusArrayParent.find(s => this.comparePaths(s.filePath, dirToAdd));
				if (parentSvnStatus && [SvnStatusCode.ADDED, SvnStatusCode.NORMAL, SvnStatusCode.MODIFIED, SvnStatusCode.REPLACED, SvnStatusCode.CONFLICTED].includes(parentSvnStatus.status)) {
					loggerDebug(this, `SVNClient.commit: Parent directory ${this.getDisplayPath(dirToAdd)} is already managed (status ${parentSvnStatus.status}). No add needed.`);
				} else {
					loggerInfo(this, `SVNClient.commit: Parent directory ${this.getDisplayPath(dirToAdd)} is not versioned by URL and status is ${parentSvnStatus?.status}. Attempting to add.`);
					try {
						await this.add(dirToAdd, { addParents: false }); // Calls the refined add method
						loggerInfo(this, `SVNClient.commit: Successfully ensured parent directory ${this.getDisplayPath(dirToAdd)} is managed after add attempt.`);
						
						// Verify after add attempt
						this.invalidateCacheForPath(dirToAdd);
						const postAddInfo = await this.getInfo(dirToAdd);
						if (!postAddInfo?.url) {
							const postAddStatusArray = await this.getStatus(dirToAdd);
							const postAddStatus = postAddStatusArray.find(s => this.comparePaths(s.filePath, dirToAdd));
							if (postAddStatus && [SvnStatusCode.ADDED, SvnStatusCode.NORMAL].includes(postAddStatus.status)) {
								loggerInfo(this, `SVNClient.commit: Parent ${this.getDisplayPath(dirToAdd)} confirmed managed (status: ${postAddStatus.status}) post-add.`);
							} else {
								loggerWarn(this, `SVNClient.commit: Parent ${this.getDisplayPath(dirToAdd)} not confirmed versioned by getInfo (no URL) AND status is ${postAddStatus?.status} after add. Commit may fail.`);
							}
						} else {
							loggerInfo(this, `SVNClient.commit: Parent ${this.getDisplayPath(dirToAdd)} confirmed versioned by getInfo (URL) post-add.`);
						}
					} catch (parentAddError: any) {
						loggerError(this, `SVNClient.commit: Failed to add parent directory ${this.getDisplayPath(dirToAdd)}. Error: ${parentAddError.message}. Commit will likely fail.`);
						throw parentAddError;
					}
				}
			}
		}
		// Collect any parent directories that need to be committed (status A)
		const parentDirsToCommit = new Set<string>();
		for (const dirToAdd of sortedParentPaths) {
			const statusArrayParent = await this.getStatus(dirToAdd);
			const parentSvnStatus = statusArrayParent.find(s => this.comparePaths(s.filePath, dirToAdd));
			if (parentSvnStatus && parentSvnStatus.status === SvnStatusCode.ADDED) {
				parentDirsToCommit.add(dirToAdd);
				loggerInfo(this, `SVNClient.commit: Parent directory ${this.getDisplayPath(dirToAdd)} has status ADDED and will be included in commit.`);
			}
		}

		for (const absoluteFilePath of absoluteFilePaths) {
			loggerInfo(this, `SVNClient.commit: Ensuring file ${this.getDisplayPath(absoluteFilePath)} itself is managed before commit.`);
			this.invalidateCacheForPath(absoluteFilePath); // Ensure fresh data
			const fileInfo = await this.getInfo(absoluteFilePath);
			if (fileInfo?.url) {
				loggerInfo(this, `SVNClient.commit: File ${this.getDisplayPath(absoluteFilePath)} is already versioned (URL: ${fileInfo.url}).`);
			} else {
				const statusArrayFile = await this.getStatus(absoluteFilePath);
				const fileSvnStatus = statusArrayFile.find(s => this.comparePaths(s.filePath, absoluteFilePath));
				if (fileSvnStatus && [SvnStatusCode.ADDED, SvnStatusCode.MODIFIED, SvnStatusCode.NORMAL, SvnStatusCode.REPLACED, SvnStatusCode.CONFLICTED].includes(fileSvnStatus.status)) {
					loggerInfo(this, `SVNClient.commit: File ${this.getDisplayPath(absoluteFilePath)} is already managed (status ${fileSvnStatus.status}).`);
				} else {
					loggerInfo(this, `SVNClient.commit: File ${this.getDisplayPath(absoluteFilePath)} not versioned by URL and status is ${fileSvnStatus?.status}. Attempting to add.`);
					try {
						await this.add(absoluteFilePath, { addParents: false });
						loggerInfo(this, `SVNClient.commit: Successfully ensured file ${this.getDisplayPath(absoluteFilePath)} is managed.`);
					} catch (fileAddError: any) {
						loggerError(this, `SVNClient.commit: Failed to add file ${this.getDisplayPath(absoluteFilePath)} before commit. Error: ${fileAddError.message}.`);
						throw fileAddError; 
					}
				}
			}
			finalPathsToCommit.push(absoluteFilePath); 
		}

		// Add parent directories with status ADDED to the commit
		parentDirsToCommit.forEach(parentDir => {
			finalPathsToCommit.push(parentDir);
		});

		const uniqueAbsolutePathsToCommit = new Set<string>(finalPathsToCommit.map(p => this.resolveAbsolutePath(p)));
		const finalPathsArray = Array.from(uniqueAbsolutePathsToCommit);		if (finalPathsArray.length === 0) {
			loggerWarn(this, "SVNClient.commit: No paths to commit after processing.");
			return { success: true, output: "No files to commit or files were not versionable." };
		}

		loggerInfo(this, `SVNClient.commit: Preparing to commit. Final absolute paths for operationManager: ${JSON.stringify(finalPathsArray)} (includes ${parentDirsToCommit.size} parent directories)`);

		try {
			await this.operationManager.commit(finalPathsArray, message);
			finalPathsToCommit.forEach(p => this.invalidateCacheForPath(p));
			// Also invalidate caches for parent directories that might have been added
			for (const filePath of finalPathsToCommit) {
				let parentDir = dirname(filePath);
				while (parentDir && parentDir !== workingCopyRoot && parentDir !== dirname(parentDir)) {
					this.invalidateCacheForPath(parentDir);
					parentDir = dirname(parentDir);
				}			}
			loggerInfo(this, 'SVN commit successful:', { filePaths: finalPathsToCommit });
			return { success: true, output: `Successfully committed ${finalPathsToCommit.length} file(s)` };
		} catch (error: any) {
			loggerError(this, 'SVN commit failed:', { filePaths: finalPathsToCommit, error: error.message, stderr: error.stderr });
			finalPathsToCommit.forEach(p => this.invalidateCacheForPath(p));
			// Also invalidate caches for parent directories on error
			for (const filePath of finalPathsToCommit) {
				let parentDir = dirname(filePath);
				while (parentDir && parentDir !== workingCopyRoot && parentDir !== dirname(parentDir)) {
					this.invalidateCacheForPath(parentDir);
					parentDir = dirname(parentDir);
				}
			}
			throw new SvnCommandError('', error.code, error.stderr || error.message);
		}
	}

	async revert(filePaths: string[], options: SvnOperationOptions = {}): Promise<SvnCommandResult> {
		const absolutePaths = filePaths.map(fp => this.resolveAbsolutePath(fp));
		const workingCopyRoot = this.findSvnWorkingCopy(absolutePaths[0]);
		if (!workingCopyRoot) {
			throw new NotWorkingCopyError(absolutePaths[0]);
		}

		const pathArgs = absolutePaths.map(p => `"${p}"`).join(' ');
		let command = `${this.svnPath} revert ${pathArgs} --non-interactive`;
		if (options.recursive) {
			command += ' --recursive';
		}

		loggerInfo(this, 'SVNClient.revert: Executing SVN revert command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			absolutePaths.forEach(p => this.invalidateCacheForPath(p));
			loggerInfo(this, 'SVN revert successful:', { filePaths, stdout, stderr });
			return { success: true, output: stdout || stderr };
		} catch (error: any) {
			loggerError(this, 'SVN revert failed:', { filePaths, error: error.message, stderr: error.stderr });
			absolutePaths.forEach(p => this.invalidateCacheForPath(p));
			throw new SvnCommandError(command, error.code, error.stderr || error.message);
		}
	}

	/**
	 * Alias for revert, taking a single file path.
	 */
	async revertFile(filePath: string, options: SvnOperationOptions = {}): Promise<SvnCommandResult> {
		return this.revert([filePath], options);
	}

	/**
	 * Alias for commit, taking a single file path.
	 */
	async commitFile(filePath: string, message: string, options: SvnOperationOptions = {}): Promise<SvnCommandResult> {
		return this.commit([filePath], message, options);
	}

	async update(filePath?: string, revision?: string): Promise<SvnCommandResult> {
		const targetPath = filePath ? this.resolveAbsolutePath(filePath) : this.getVaultPath();
		const workingCopyRoot = this.findSvnWorkingCopy(targetPath) || this.getVaultPath(); 

		if (!workingCopyRoot) {
			throw new NotWorkingCopyError(targetPath || 'Vault Root');
		}

		let command = `${this.svnPath} update`;
		if (targetPath) {
			command += ` "${targetPath}"`;
		}
		if (revision) {
			command += ` -r ${revision}`;
		}
		command += ' --accept postpone --non-interactive'; 

		loggerInfo(this, 'SVNClient.update: Executing SVN update command:', { command, cwd: workingCopyRoot });
		try {
			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			this.invalidateCacheForPath(targetPath || workingCopyRoot); 
			loggerInfo(this, 'SVN update successful:', { path: targetPath, stdout, stderr });
			return { success: true, output: stdout || stderr };
		} catch (error: any) {
			loggerError(this, 'SVN update failed:', { path: targetPath, error: error.message, stderr: error.stderr });
			this.invalidateCacheForPath(targetPath || workingCopyRoot);
			throw new SvnCommandError(command, error.code, error.stderr || error.message);
		}
	}
}