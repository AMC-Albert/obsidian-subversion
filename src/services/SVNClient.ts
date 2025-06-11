import { exec, spawn } from 'child_process'; // Added spawn
import { promisify } from 'util';
import { join, dirname, isAbsolute, relative, basename } from 'path'; // Added basename
import { existsSync, statSync, createWriteStream } from 'fs'; // Added createWriteStream
import * as fs from 'fs/promises'; // For async file operations
import { SvnLogEntry, SvnStatus, SvnCommandResult, SvnBlameEntry, SvnInfo, SvnStatusCode, SvnPropertyStatus, SvnOperationOptions } from '@/types';
import { SvnError, SvnNotInstalledError, NotWorkingCopyError, SvnCommandError } from '@/utils/errors';
import { SVNStatusUtils } from '@/utils';
import { loggerDebug, loggerInfo, loggerWarn, loggerError, registerLoggerClass } from '@/utils/obsidian-logger';

const execPromise = promisify(exec);

export class SVNClient {
	private svnPath: string;
	private vaultPath: string;
	private statusRequestCache = new Map<string, Promise<SvnStatus[]>>();
	private findWorkingCopyCache = new Map<string, string | null>();
	private isFileInSvnResultCache = new Map<string, boolean>();
	private previewCacheDir: string;
	
	// Callback for notifying when cache should be cleared
	private cacheInvalidationCallback?: () => void;
	constructor(svnPath: string = 'svn', vaultPath: string = '') {
		this.svnPath = svnPath;
		this.vaultPath = vaultPath;
		if (this.vaultPath) {
			this.previewCacheDir = join(this.vaultPath, '.obsidian', 'plugins', 'obsidian-subversion', 'preview_cache');
		} else {
			this.previewCacheDir = ''; // Will be set properly by setVaultPath
		}
		registerLoggerClass(this, 'SVNClient');
	}

	/**
	 * Set callback for cache invalidation notifications
	 */
	setCacheInvalidationCallback(callback: () => void): void {
		this.cacheInvalidationCallback = callback;
	}

	setVaultPath(vaultPath: string) {
		this.vaultPath = vaultPath;
		if (this.vaultPath) {
			this.previewCacheDir = join(this.vaultPath, '.obsidian', 'plugins', 'obsidian-subversion', 'preview_cache');
		} else {
			this.previewCacheDir = '';
		}
		// Clear caches that might depend on vaultPath
		this.findWorkingCopyCache.clear();
		this.isFileInSvnResultCache.clear();
		// this.statusRequestCache.clear(); // Status cache might be path-specific, consider implications
		loggerInfo(this, 'Vault path set and preview cache directory updated:', { vaultPath, previewCacheDir: this.previewCacheDir });
	}

	getVaultPath(): string {
		return this.vaultPath;
	}

	private resolveAbsolutePath(filePath: string): string {
		if (isAbsolute(filePath)) {
			return filePath; // Return as-is if already absolute
		}
		if (!this.vaultPath) {
			throw new Error('Vault path not set');
		}
		return join(this.vaultPath, filePath);
	}

	private findSvnWorkingCopy(absolutePath: string): string | null {
		// Check cache first
		if (this.findWorkingCopyCache.has(absolutePath)) {
			return this.findWorkingCopyCache.get(absolutePath)!;
		}

		// Start from the path itself, then check parent directories
		let currentPath = absolutePath;
		loggerDebug(this, 'findWorkingCopyRoot', `Looking for SVN working copy starting from: ${currentPath}`);
		
		// If the path is a file, start from its directory
		if (existsSync(currentPath) && !statSync(currentPath).isDirectory()) {
			currentPath = dirname(currentPath);
			loggerDebug(this, `Path is a file, starting from directory: ${currentPath}`);
		}
		
		let result: string | null = null;
		let searchPath = currentPath;
		while (searchPath && searchPath !== dirname(searchPath)) {
			const svnPath = join(searchPath, '.svn');
			loggerDebug(this, `Checking for .svn directory at: ${svnPath}`);
			if (existsSync(svnPath)) {
				loggerInfo(this, 'findSvnWorkingCopy', `Found SVN working copy at: ${searchPath}`);
				result = searchPath;
				break;
			}
			searchPath = dirname(searchPath);
		}
		
		if (!result) {
			loggerError(this, `No SVN working copy found starting from: ${absolutePath}`);
		}

		this.findWorkingCopyCache.set(absolutePath, result);
		return result;
	}
	async getFileHistory(filePath: string): Promise<SvnLogEntry[]> {
		// Helper function defined at the start of the method to be accessible throughout
		const isKnownNotFoundError = (message: string): boolean => {
			const lowerMessage = message.toLowerCase();
			return lowerMessage.includes('svn: e160013') || // path not found
				   lowerMessage.includes('svn: e195002') || // no committed revision
				   lowerMessage.includes('node was not found') ||
				   lowerMessage.includes('is not under version control');
		};

		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			if (!workingCopyRoot) {
				// This is a legitimate error if we expect a working copy.
				loggerWarn(this, `File "${filePath}" is not in an SVN working copy. Cannot get history.`);
				return []; // Return empty history as it's not versioned here.
			}
			
			let entries: SvnLogEntry[] = [];
			let lastError: Error | null = null;
			
			// Strategy 1: Try getting history with follow-copies to track renames/moves
			try {
				const followCommand = `${this.svnPath} log --xml --verbose --limit 100 --use-merge-history -r HEAD:1 "${absolutePath}"`;
				loggerDebug(this, 'getFileHistory (Strategy 1 - Merge History) command:', followCommand, 'CWD:', workingCopyRoot);
				const { stdout } = await execPromise(followCommand, { cwd: workingCopyRoot });
				loggerDebug(this, 'getFileHistory raw XML output (merge history):', stdout);

				entries = this.parseXmlLog(stdout);
				loggerDebug(this, 'getFileHistory parsed entries (merge history):', entries.length);
				
				if (entries.length > 0) {
					// Enrich entries with size information
					const entriesWithSize = await this.enrichHistoryWithSizes(filePath, entries);
					return entriesWithSize;
				}
			} catch (followError) {
				lastError = followError as Error;
				const errorMessage = (followError as Error).message || '';
				if (isKnownNotFoundError(errorMessage)) {
					loggerInfo(this, 'getFileHistory (Strategy 1 - Merge History) failed as expected for new/uncommitted file:', errorMessage.split('\n')[0]);
				} else {
					loggerWarn(this, 'getFileHistory (Strategy 1 - Merge History) failed, trying basic log:', errorMessage.split('\n')[0]);
				}
			}
			
			// Strategy 2: Try basic log command with HEAD revision
			try {
				const basicCommand = `${this.svnPath} log --xml --verbose --limit 100 -r HEAD:1 "${absolutePath}"`;
				loggerDebug(this, 'getFileHistory (Strategy 2 - Basic Log) command:', basicCommand, 'CWD:', workingCopyRoot);
				const { stdout } = await execPromise(basicCommand, { cwd: workingCopyRoot });
				loggerDebug(this, 'getFileHistory raw XML output (basic):', stdout);

				entries = this.parseXmlLog(stdout);
				loggerDebug(this, 'getFileHistory parsed entries (basic):', entries.length);
				
				if (entries.length > 0) {
					// Enrich entries with size information
					const entriesWithSize = await this.enrichHistoryWithSizes(filePath, entries);
					return entriesWithSize;
				}
			} catch (basicError) {
				lastError = basicError as Error;
				const errorMessage = (basicError as Error).message || '';
				if (isKnownNotFoundError(errorMessage)) {
					loggerInfo(this, 'getFileHistory (Strategy 2 - Basic Log) failed as expected for new/uncommitted file:', errorMessage.split('\n')[0]);
				} else {
					loggerWarn(this, 'getFileHistory (Strategy 2 - Basic Log) failed, trying repository URL:', errorMessage.split('\n')[0]);
				}
			}
			
			// Strategy 3: Try repository URL as fallback for renamed files
			try {
				const infoResult = await execPromise(`${this.svnPath} info --xml "${workingCopyRoot}"`, { cwd: workingCopyRoot });
				const rootMatch = infoResult.stdout.match(/<root>(.*?)<\/root>/);
			
				if (rootMatch) {
					const repositoryRoot = rootMatch[1];
					const relativePath = relative(workingCopyRoot, absolutePath).replace(/\\/g, '/');
					const repositoryUrl = `${repositoryRoot}/${relativePath}`;
					
					const repoCommand = `${this.svnPath} log --xml --verbose --limit 100 --use-merge-history -r HEAD:1 "${repositoryUrl}"`;
					
					loggerDebug(this, 'getFileHistory (Strategy 3 - Repo URL) command:', repoCommand, 'CWD:', workingCopyRoot);
					
					const { stdout } = await execPromise(repoCommand, { cwd: workingCopyRoot });
					loggerDebug(this, 'getFileHistory raw XML output (repo URL):', stdout);

					entries = this.parseXmlLog(stdout);
					loggerDebug(this, 'getFileHistory parsed entries (repo URL):', entries.length);

					if (entries.length > 0) {
						// Enrich entries with size information
						const entriesWithSize = await this.enrichHistoryWithSizes(filePath, entries);
						return entriesWithSize;
					}
				} else {
					loggerWarn(this, 'getFileHistory (Strategy 3 - Repo URL) could not determine repository root from svn info.');
				}
			} catch (repoError) {
				lastError = repoError as Error;
				const errorMessage = (repoError as Error).message || '';
				if (isKnownNotFoundError(errorMessage)) {
					loggerInfo(this, 'getFileHistory (Strategy 3 - Repo URL) failed as expected for new/uncommitted file:', errorMessage.split('\n')[0]);
				} else {
					loggerError(this, `getFileHistory (Strategy 3 - Repo URL) failed:`, errorMessage.split('\n')[0]);
				}
			}
			
			// If we reach here, all strategies failed or found no entries.
			// The final decision to throw or return empty is handled by the outer catch.
			if (lastError) {
				throw lastError; // Re-throw the last encountered error to be handled by the main catch block.
			}
			// If no error but also no entries, it implies the file has no history (e.g. added but not committed)
			loggerInfo(this, `getFileHistory: No history found for "${filePath}" after all strategies and no errors thrown.`);
			return [];

		} catch (error) {
			const errorMessage = (error as Error).message?.toLowerCase() || '';
			// Log the actual error details for debugging, but only the first line for general info if it's a known not-found type.
			const firstLineOfError = ((error as Error).message || '').split('\n')[0];

			if (
				isKnownNotFoundError(errorMessage) || // Consolidates checks for E160013, E195002, etc.
				errorMessage.includes('no such file or directory') ||
				errorMessage.includes('path not found') || // More generic path not found
				errorMessage.includes('svn: e155010') || // node not found (another variant)
				errorMessage.includes('svn: e200009')    // node not found (yet another variant)
			) {
				loggerInfo(this, `getFileHistory: File "${filePath}" not found in SVN history or has no committed revisions. Returning empty history. Detail: ${firstLineOfError}`);
				return [];
			} else {
				// For unexpected errors, log the full error and re-throw.
				loggerError(this, 'getFileHistory encountered an unexpected error:', { filePath, error: (error as Error).message });
				throw new Error(`Failed to get file history for "${filePath}": ${(error as Error).message}`);
			}
		}
	}
	/**
	 * Enrich log entries with file size information for each revision
	 */
	private async enrichHistoryWithSizes(filePath: string, entries: SvnLogEntry[]): Promise<SvnLogEntry[]> {
		const enrichedEntries: SvnLogEntry[] = [];
		
		for (const entry of entries) {			try {				const [size, repoSize] = await Promise.all([
					this.getFileSizeAtRevision(filePath, entry.revision.toString()),
					this.getRevisionStorageSize(entry.revision.toString())
				]);

				// Check for preview image in the repository at this revision
				const previewImagePath = await this.getPreviewImageForRevision(filePath, entry.revision.toString());
				
				enrichedEntries.push({
					...entry,
					size: size !== null ? size : undefined,
					repoSize: repoSize !== null ? repoSize : undefined,
					previewImagePath: previewImagePath || undefined // Add preview image path
				});
			} catch (error) {
				loggerError(this, `Failed to get size/preview info for revision ${entry.revision}:`, error.message);
				// Add entry without size or preview information
				enrichedEntries.push(entry);
			}
		}
		
		return enrichedEntries;
	}

	/**
	 * Check if a preview image exists for a given file and revision in the repository.
	 * Returns the repository path to the preview image if it exists, otherwise null.
	 */
	private async getPreviewImageForRevision(filePath: string, revision: string): Promise<string | null> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			if (!workingCopyRoot) {
				return null; // Not in a working copy
			}

			// Construct the preview file name based on the original file's name
			// e.g., if filePath is "MyProject/File.blend", previewFileName is "File.blend.preview.png"
			const originalFileName = basename(filePath); // "File.blend"
			const previewFileName = originalFileName + '.preview.png'; // "File.blend.preview.png"
			
			// The preview is expected to be in the same directory in the repo as the original file.
			// We need the repo-relative path of the original file's directory.
			const repoInfoForFile = await this.getInfo(absolutePath);
			if (!repoInfoForFile || !repoInfoForFile.url || !repoInfoForFile.repositoryRoot) {
				loggerWarn(this, `Could not get repo URL or root for ${absolutePath}`);
				return null;
			}
			
			const fileUrlInRepo = repoInfoForFile.url; // Full URL like svn://server/repo/trunk/MyProject/File.blend
			const repoRootDirUrl = repoInfoForFile.repositoryRoot; // svn://server/repo
			
			let fileDirInRepoFullUrl = dirname(fileUrlInRepo); // svn://server/repo/trunk/MyProject
			if (fileDirInRepoFullUrl === '.' || fileDirInRepoFullUrl === repoRootDirUrl) { // Handle files in repo root
				fileDirInRepoFullUrl = repoRootDirUrl;
			}

			const potentialPreviewFullUrl = (fileDirInRepoFullUrl.endsWith('/') ? fileDirInRepoFullUrl : fileDirInRepoFullUrl + '/') + previewFileName;
			
			// Use svn list to check if the preview file exists at the specified revision
			const command = `${this.svnPath} list "${potentialPreviewFullUrl}@${revision}" --non-interactive`;
			loggerDebug(this, 'Checking for preview with command:', command);
			await execPromise(command, { cwd: workingCopyRoot });
			
			// If the command succeeds, the file exists. We need its relative path from the repo root.
			if (potentialPreviewFullUrl.startsWith(repoRootDirUrl)) {
				let relativePathToRepo = potentialPreviewFullUrl.substring(repoRootDirUrl.length);
				if (!relativePathToRepo.startsWith('/')) {
					relativePathToRepo = '/' + relativePathToRepo;
				}
				loggerInfo(this, `Preview image found for ${filePath} at revision ${revision}: ${relativePathToRepo}`);
				return relativePathToRepo;
			}
			loggerWarn(this, "Could not form relative path for preview:", {potentialPreviewFullUrl, repoRootDirUrl});
			return null;

		} catch (error) {
			// If svn list fails (e.g., file not found), it will throw an error.
			// This means the preview image does not exist at this revision.
			loggerDebug(this, `Preview image not found for ${filePath} at revision ${revision} (svn list failed):`, error.message);
			return null;
		}
	}

	private async ensurePreviewCacheDirExists(): Promise<void> {
		if (!this.previewCacheDir) {
			loggerError(this, 'Preview cache directory path is not set. Vault path might be missing or plugin not fully initialized.');
			throw new Error('Preview cache directory not configured.');
		}
		try {
			await fs.mkdir(this.previewCacheDir, { recursive: true });
		} catch (error) {
			loggerError(this, `Failed to create preview cache directory ${this.previewCacheDir}:`, error);
			// Don't re-throw, allow operations to fail gracefully if cache dir can't be made
		}
	}

	public async getLocalPreviewImage(
		originalFileWorkingPath: string, // e.g., "MyProject/Assets/MyMaterial.mat" (vault relative)
		previewFileRepoRelativePath: string, // e.g., "/trunk/Assets/MyMaterial.mat.preview.png"
		revision: string
	): Promise<string | null> {
		if (!this.previewCacheDir) {
			loggerWarn(this, 'Preview cache directory is not configured (vaultPath likely not set). Cannot get/store preview image.');
			return null;
		}
		// Attempt to create cache dir, log error if fails but try to continue if possible (e.g. read-only cache)
		await this.ensurePreviewCacheDirExists().catch(err => {
			loggerError(this, "Failed to ensure preview cache directory exists, previews may not work:", err);
			// Potentially return null here if cache is essential for writing
			// For now, we'll let it try, it might fail later at fs.access or write.
		});


		const absoluteOriginalPath = this.resolveAbsolutePath(originalFileWorkingPath);
		const workingCopyRoot = this.findSvnWorkingCopy(absoluteOriginalPath);
		if (!workingCopyRoot) {
			loggerWarn(this, `Cannot find SVN working copy for ${originalFileWorkingPath} to fetch preview.`);
			return null;
		}

		const baseName = basename(originalFileWorkingPath);
		const safeBaseName = baseName.replace(/[^a-zA-Z0-9_.-]/g, '_');
		const cachedFileName = `${safeBaseName}_r${revision}.png`;
		const localCachedPath = join(this.previewCacheDir, cachedFileName);

		try {
			await fs.access(localCachedPath);
			loggerInfo(this, `Preview image found in cache: ${localCachedPath}`);
			return localCachedPath;
		} catch {
			// Not cached or not accessible, proceed to fetch
		}

		let repoRootUrl: string;
		try {
			const info = await this.getInfo(workingCopyRoot);
			if (!info || !info.repositoryRoot) {
				loggerError(this, `Could not determine repository root for working copy: ${workingCopyRoot}`);
				return null;
			}
			repoRootUrl = info.repositoryRoot;
		} catch (error) {
			loggerError(this, `Failed to get SVN info for ${workingCopyRoot}:`, error);
			return null;
		}

		let fullPreviewUrl = repoRootUrl;
		if (fullPreviewUrl.endsWith('/') && previewFileRepoRelativePath.startsWith('/')) {
			fullPreviewUrl += previewFileRepoRelativePath.substring(1);
		} else if (!fullPreviewUrl.endsWith('/') && !previewFileRepoRelativePath.startsWith('/')) {
			fullPreviewUrl += '/' + previewFileRepoRelativePath;
		} else {
			fullPreviewUrl += previewFileRepoRelativePath;
		}
		
		const fullPreviewUrlWithRevision = `${fullPreviewUrl}@${revision}`;
		const tempFilePath = localCachedPath + '.tmp';

		loggerInfo(this, `Fetching preview image: ${fullPreviewUrlWithRevision} into ${localCachedPath}`);

		try {
			await new Promise<void>((resolve, reject) => {
				const svnProcess = spawn(this.svnPath, ['cat', fullPreviewUrlWithRevision, '--non-interactive'], { cwd: workingCopyRoot });
				const fileStream = createWriteStream(tempFilePath);

				svnProcess.stdout.pipe(fileStream);
				let stderrData = '';
				svnProcess.stderr.on('data', (data) => {
					stderrData += data.toString();
				});
				svnProcess.on('error', (err) => {
					fileStream.close();
					fs.unlink(tempFilePath).catch(() => {});
					// Corrected SvnCommandError constructor call
					reject(new SvnCommandError(`svn cat ${fullPreviewUrlWithRevision}`, -1, `Failed to start svn cat process: ${err.message}`));
				});
				
				fileStream.on('finish', () => {
					// This can be called even if svn process exits with error, if stdout had some data.
					// Rely on 'close' event for final status.
					resolve(); 
				});
				fileStream.on('error', (err) => {
					svnProcess.kill(); // Ensure process is killed
					fs.unlink(tempFilePath).catch(() => {});
					reject(new Error(`Failed to write preview image to temp file ${tempFilePath}: ${err.message}`));
				});

				svnProcess.on('close', (code) => {
					fileStream.end(() => { // Ensure filestream is closed and flushed before resolving/rejecting
						if (code !== 0) {
							loggerWarn(this, `SVN cat process for ${fullPreviewUrlWithRevision} exited with code ${code}. Stderr: ${stderrData}`);
							fs.unlink(tempFilePath).catch(() => {});
							// Corrected SvnCommandError constructor call
							reject(new SvnCommandError(`svn cat ${fullPreviewUrlWithRevision}`, code || -1, stderrData || 'SVN cat failed. Preview might not exist at this revision.'));
						} else {
							// If code is 0, 'finish' on writestream should have handled resolve.
							// However, if stdout was empty, finish might not be enough.
							// Check if file has content if necessary, or assume svn cat success means content.
							resolve(); // Resolve here again to be sure if finish didn't fire or was premature.
						}
					});
				});
			});

			await fs.rename(tempFilePath, localCachedPath);
			loggerInfo(this, `Successfully cached preview image: ${localCachedPath}`);
			return localCachedPath;

		} catch (error) {
			loggerError(this, `Failed to fetch or save preview image ${fullPreviewUrlWithRevision}:`, error.message);
			await fs.unlink(tempFilePath).catch(() => {});
			return null;
		}
	}

	/**
	 * Check if a file exists at a specific revision
	 * This is useful for handling renamed/moved files gracefully
	 */
	private async fileExistsAtRevision(filePath: string, revision: string): Promise<boolean> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			if (!workingCopyRoot) {
				return false;
			}

			const command = `${this.svnPath} cat -r ${revision} "${absolutePath}" --depth empty`;
			await execPromise(command, { cwd: workingCopyRoot });
			return true;
		} catch (error) {
			loggerDebug(this, `File ${filePath} does not exist at revision ${revision}:`, error.message);
			return false;
		}
	}

	/**
	 * Get the actual file path at a specific revision (handles renames)
	 */
	private async getFilePathAtRevision(filePath: string, revision: string): Promise<string | null> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			if (!workingCopyRoot) {
				return null;
			}

			// Try to get file info at the specific revision
			const command = `${this.svnPath} info -r ${revision} "${absolutePath}" --xml`;
			const result = await execPromise(command, { cwd: workingCopyRoot });
			
			// Parse the XML to get the actual path
			const pathMatch = result.stdout.match(/<relative-url>\^?\/?([^<]*)<\/relative-url>/);
			if (pathMatch) {
				return pathMatch[1];
			}
			
			return null;
		} catch (error) {
			loggerDebug(this, `Could not get file path at revision ${revision}:`, error.message);
			return null;
		}
	}

	async getFileRevisions(filePath: string): Promise<string[]> {
		try {
			const history = await this.getFileHistory(filePath);
			return history.map(entry => entry.revision.toString());
		} catch (error) {
			throw new Error(`Failed to get file revisions: ${error.message}`);
		}
	}

	/**
	 * Get the file size for a specific revision
	 */
	async getFileSizeAtRevision(filePath: string, revision: string): Promise<number | null> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}

			// Use svn list --verbose with revision specifier to get file size
			const command = `${this.svnPath} list --verbose "${absolutePath}@${revision}"`;
			const result = await execPromise(command, { cwd: workingCopyRoot });
			
			// Parse the output: "    revision author    size date filename"
			// Example: "      6 osheaa         577328 Jun 03 15:49 ASSETFILER.blend"
			const lines = result.stdout.trim().split('\n');
			if (lines.length === 0) {
				return null;
			}
			
			const line = lines[0].trim();
			const parts = line.split(/\s+/);
			
			// The size should be the 3rd column (index 2)
			if (parts.length >= 3) {
				const size = parseInt(parts[2], 10);
				if (!isNaN(size)) {
					return size;
				}
			}
			
			return null;
		} catch (error: any) {
			loggerError(this, `Failed to get file size for revision ${revision}:`, error.message);
			return null;
		}
	}	/**
	 * Get the repository storage size for a specific revision
	 */
	async getRevisionStorageSize(revision: string): Promise<number | null> {
		try {
			// Try multiple strategies to find working copy
			let workingCopyRoot = null;
			
			// Strategy 1: Try vault path
			if (this.vaultPath) {
				workingCopyRoot = this.findSvnWorkingCopy(this.vaultPath);
				loggerDebug(this, `Strategy 1 - Vault path ${this.vaultPath}, found working copy:`, workingCopyRoot);
			}
			
			// Strategy 2: Try parent of vault path
			if (!workingCopyRoot && this.vaultPath) {
				const parentPath = dirname(this.vaultPath);
				workingCopyRoot = this.findSvnWorkingCopy(parentPath);
				loggerDebug(this, `Strategy 2 - Parent of vault path ${parentPath}, found working copy:`, workingCopyRoot);
			}
			
			// Strategy 3: Try current working directory
			if (!workingCopyRoot) {
				workingCopyRoot = this.findSvnWorkingCopy(process.cwd());
				loggerDebug(this, `Strategy 3 - CWD ${process.cwd()}, found working copy:`, workingCopyRoot);
			}
			
			// Strategy 4: Try parent of current working directory
			if (!workingCopyRoot) {
				const parentCwd = dirname(process.cwd());
				workingCopyRoot = this.findSvnWorkingCopy(parentCwd);
				loggerDebug(this, `Strategy 4 - Parent of CWD ${parentCwd}, found working copy:`, workingCopyRoot);
			}
			
			if (!workingCopyRoot) {
				loggerError(this, `Could not find SVN working copy. Vault path: ${this.vaultPath}, CWD: ${process.cwd()}`);
				return null;
			}

			loggerInfo(this, `Getting repository size for revision ${revision}, working copy: ${workingCopyRoot}`);

			// Get repository information using svn info
			const infoCommand = `${this.svnPath} info --xml "${workingCopyRoot}"`;
			const infoResult = await execPromise(infoCommand, { cwd: workingCopyRoot });
			
			// Parse multiple potential repository paths
			const rootMatch = infoResult.stdout.match(/<root>(.*?)<\/root>/);
			const urlMatch = infoResult.stdout.match(/<url>(.*?)<\/url>/);
			const uuidMatch = infoResult.stdout.match(/<uuid>(.*?)<\/uuid>/);
			
			if (!rootMatch) {
				loggerError(this, 'Could not determine repository root from svn info');
				return null;
			}
			
			const repositoryUrl = rootMatch[1];
			loggerDebug(this, 'Repository URL found:', repositoryUrl);
			
			// Check if this is a file:// URL pointing to a local repository
			if (repositoryUrl.startsWith('file://')) {
				// Convert file:// URL to local path for svnadmin
				let repositoryPath = repositoryUrl.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
				
				// Properly decode URL-encoded characters (like %20 for spaces)
				try {
					repositoryPath = decodeURIComponent(repositoryPath);
				} catch (decodeError) {
					loggerWarn(this, 'Failed to decode repository path, using as-is:', repositoryPath);
				}
				
				// Convert forward slashes to backslashes on Windows
				if (process.platform === 'win32') {
					repositoryPath = repositoryPath.replace(/\//g, '\\');
				}
				
				loggerDebug(this, 'Repository path converted:', repositoryPath);
				
				// Verify the repository path exists
				if (!existsSync(repositoryPath)) {
					loggerError(this, `Repository path does not exist: ${repositoryPath}`);
					return null;
				}
				
				// Verify it's actually an SVN repository by checking for required files
				const formatFile = join(repositoryPath, 'format');
				if (!existsSync(formatFile)) {
					loggerError(this, `Not a valid SVN repository (missing format file): ${repositoryPath}`);
					return null;
				}
				
				// Use svnadmin rev-size to get the actual repository storage size
				const command = `svnadmin rev-size "${repositoryPath}" -r ${revision} -q`;
				loggerDebug(this, 'Executing svnadmin command:', command);
				
				try {
					const result = await execPromise(command);
					
					const size = parseInt(result.stdout.trim(), 10);
					if (!isNaN(size)) {
						loggerInfo(this, `Repository size for revision ${revision}: ${size} bytes`);
						return size;
					}
					
					loggerError(this, `Could not parse repository size from output: ${result.stdout}`);
					return null;
				} catch (svnadminError) {
					loggerError(this, `svnadmin rev-size failed:`, svnadminError.message);
					return null;
				}
			} else {
				// For remote repositories, we can't use svnadmin
				loggerWarn(this, 'Remote repository detected, cannot get precise revision size with svnadmin:', repositoryUrl);
				return null;
			}
		} catch (error: any) {
			loggerError(this, `Failed to get repository size for revision ${revision}:`, error.message);
			return null;
		}
	}

	async checkoutRevision(filePath: string, revision: string): Promise<void> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}
			  // First, revert any local changes to the file to avoid conflicts
			try {
				const revertCommand = `${this.svnPath} revert "${absolutePath}"`;
				await execPromise(revertCommand, { cwd: workingCopyRoot });
				loggerInfo(this, 'Reverted local changes before checkout');
			} catch (revertError) {
				// Ignore revert errors if file has no local changes
				loggerError(this, 'No local changes to revert:', revertError.message);
			}
			
			// Use svn update with specific revision for the single file
			// This properly updates the working copy metadata while changing just this file
			const updateCommand = `${this.svnPath} update -r ${revision} "${absolutePath}"`;
			const result = await execPromise(updateCommand, { cwd: workingCopyRoot });
			loggerInfo(this, 'SVN update result:', result.stdout);
			
			loggerInfo(this, `Checked out revision ${revision} for file ${filePath}`);
		} catch (error) {
			throw new Error(`Failed to checkout revision ${revision}: ${error.message}`);
		}
	}
	
	async commitFile(filePath: string, message: string): Promise<void> {
		const fullPath = this.resolveAbsolutePath(filePath);
		loggerInfo(this, 'commitFile called with:', { fullPath, message });

		try {
			// Ensure parent directories are versioned before committing
			await this.ensureParentDirectoriesAreVersioned(fullPath);
			
			// Ensure the file itself is added to SVN
			await this.ensureFileIsAdded(fullPath);

			// Check for and add .preview.png file
			const previewPath = fullPath + '.preview.png';
			const previewFileExists = existsSync(previewPath);
			let commitPaths = [fullPath];

			if (previewFileExists) {
				loggerInfo(this, 'Preview file found, ensuring it is added:', { previewPath });
				await this.ensureFileIsAdded(previewPath);
				commitPaths.push(previewPath);
			}

			const commitPathsString = commitPaths.map(p => `\"${p}\"`).join(' ');
			const command = `svn commit -m \"${message}\" ${commitPathsString}`;
			loggerInfo(this, 'Executing command:', { command });
			const { stdout, stderr } = await execPromise(command);

			if (stderr) {
				loggerError(this, `Error committing file ${fullPath}: ${stderr}`);

				// Check for the specific error about parent directory not being versioned
				if (stderr.includes('is not known to exist in the repository')) {
					throw new Error(`Failed to commit file: Parent directory is not versioned. This should have been handled automatically. ${stderr}`);
				}
				
				throw new Error(`Failed to commit file: ${stderr}`);
			}
			loggerInfo(this, `File ${fullPath} committed successfully: ${stdout}`);
		} catch (error) {
			loggerError(this, `Exception in commitFile for ${fullPath}: ${error}`);
			throw error; // Re-throw the original error for higher-level handling
		}
		
		// Clear cache after commit operation to ensure fresh status data
		this.clearStatusCache();
	}
	
	async ensureParentDirectoriesAreVersioned(filePath: string): Promise<void> {
		let parentDir = dirname(filePath);
		const repoRoot = this.findSvnWorkingCopy(filePath);

		if (!repoRoot) {
			loggerError(this, `Could not determine repository root for ${filePath}. Skipping parent directory check.`);
			return;
		}

		const dirsToAdd: string[] = [];
		const dirsToCommit: string[] = [];

		// Traverse up from the file's parent directory to the repository root
		while (parentDir && parentDir.startsWith(repoRoot) && parentDir !== repoRoot) {
			const isVersioned = await this.isDirectoryVersioned(parentDir);

			if (!isVersioned) {
				// Check if the directory is already added but not committed
				const status = await this.getStatus(parentDir);
				const dirStatus = status.find(s => this.comparePaths(s.filePath, parentDir));
				
				if (dirStatus && dirStatus.status === SvnStatusCode.ADDED) {
					// Directory is added but not committed
					dirsToCommit.unshift(parentDir);
					loggerInfo(this, `Directory ${parentDir} is added but needs to be committed`);
				} else {
					// Directory is not versioned at all
					dirsToAdd.unshift(parentDir);
					loggerInfo(this, `Directory ${parentDir} needs to be added`);
				}
			}
			
			const grandParentDir = dirname(parentDir);
			if (grandParentDir === parentDir) { // Reached the top or an invalid path
				break;
			}
			parentDir = grandParentDir;
		}

		// First, add directories that aren't versioned yet
		for (const dirToAdd of dirsToAdd) {
			loggerInfo(this, `Adding directory ${dirToAdd} with --depth empty`);
			try {
				await this.add(dirToAdd, true); // true for --depth empty
			} catch (addError) {
				loggerError(this, `Failed to add directory ${dirToAdd}: ${addError}`);
				throw new Error(`Failed to add directory ${dirToAdd} during pre-commit check: ${addError}`);
			}
		}

		// Then, commit directories that are added but not committed
		for (const dirToCommit of dirsToCommit) {
			loggerInfo(this, `Committing directory ${dirToCommit}`);
			try {
				const command = `svn commit -m "Add directory" "${dirToCommit}"`;
				await execPromise(command);
				loggerInfo(this, `Successfully committed directory ${dirToCommit}`);
			} catch (commitError) {
				loggerError(this, `Failed to commit directory ${dirToCommit}: ${commitError}`);
				throw new Error(`Failed to commit directory ${dirToCommit} during pre-commit check: ${commitError}`);
			}
		}
	}

	async add(filePath: string, depthEmpty: boolean = false): Promise<void> {
		const fullPath = this.resolveAbsolutePath(filePath);
		loggerInfo(this, 'add called with:', { fullPath, depthEmpty });
		const depthOption = depthEmpty ? '--depth empty ' : '';
		const command = `svn add ${depthOption}"${fullPath}"`;
		loggerInfo(this, 'Executing command:', { command });
		try {
			const { stdout, stderr } = await execPromise(command);
			if (stderr) {
				// Ignore "already under version control" error for adds
				if (!stderr.includes("is already under version control")) {
					loggerError(this, `Error adding file/directory ${fullPath}: ${stderr}`);
					throw new Error(`Failed to add file/directory: ${stderr}`);
				} else {
					loggerInfo(this, `${fullPath} is already under version control. No action needed.`);
				}
			}
			if (stdout) {
				loggerInfo(this, `${fullPath} added successfully: ${stdout}`);
			}
		} catch (error) {
			loggerError(this, `Exception in add for ${fullPath}: ${error}`);
			// Check if the error is because the file is already versioned
			if (error.message && error.message.includes("is already under version control")) {
				loggerInfo(this, `${fullPath} is already under version control. No action needed.`);
			} else {
				throw error; // Re-throw other errors
			}
		}
		
		// Clear cache after addFile operation to ensure fresh status data
		this.clearStatusCache();
	}

	async revertFile(filePath: string): Promise<void> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}
					const command = `${this.svnPath} revert "${absolutePath}"`;
			await execPromise(command, { cwd: workingCopyRoot });
		} catch (error) {
			throw new Error(`Failed to revert file: ${error.message}`);
		}
		
		// Clear cache after revert operation to ensure fresh status data
		this.clearStatusCache();
	}
	
	async getStatus(path?: string): Promise<SvnStatus[]> {
		// Create cache key for request deduplication
		const cacheKey = path || '__vault_root__';
		
		// If we already have a pending request for this path, return the existing promise
		if (this.statusRequestCache.has(cacheKey)) {
			loggerInfo(this, cacheKey);
			return this.statusRequestCache.get(cacheKey)!;
		}
		
		// Create new request
		const statusPromise = this.doGetStatus(path);
		
		// Cache the promise
		this.statusRequestCache.set(cacheKey, statusPromise);
		
		// Clean up cache when request completes (success or failure)
		statusPromise.finally(() => {
			this.statusRequestCache.delete(cacheKey);
		});
		
		return statusPromise;
	}
	
	private async doGetStatus(path?: string): Promise<SvnStatus[]> {
		try {
			let workingCopyRoot: string | null;
			let targetPath: string;

			loggerInfo(this, 'Called with path:', path);

			if (path) {
				const absolutePath = this.resolveAbsolutePath(path);
				workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
				targetPath = absolutePath;
				loggerInfo(this, 'Resolved paths:', {
					originalPath: path,
					absolutePath,
					workingCopyRoot,
					targetPath
				});
			} else {
				workingCopyRoot = this.findSvnWorkingCopy(this.vaultPath);
				targetPath = '';
				loggerInfo(this, 'Using vault path:', {
					vaultPath: this.vaultPath,
					workingCopyRoot
				});
			}
			
			if (!workingCopyRoot) {
				throw new Error('Path is not in an SVN working copy');
			}
			
			const command = targetPath ? 
				`${this.svnPath} status "${targetPath}"` : 
				`${this.svnPath} status`;

			loggerInfo(this, 'Executing command:', {
				command,
				cwd: workingCopyRoot
			});
			
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			
			loggerInfo(this, 'Raw status output:', {
				stdout: stdout.substring(0, 200) + (stdout.length > 200 ? '...' : ''),
				outputLength: stdout.length
			});
			
			const result = this.parseStatus(stdout);
			loggerInfo(this, 'Parsed status result:', {
				resultCount: result.length,
				results: result
			});
			
			return result;
		} catch (error) {
			loggerError(this, 'Error occurred:', error);
			throw new Error(`Failed to get SVN status: ${error.message}`);
		}
	}

	async getDiff(filePath: string, revision?: string): Promise<string> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}
			
			const command = revision ? 
				`${this.svnPath} diff -r ${revision} "${absolutePath}"` :
				`${this.svnPath} diff "${absolutePath}"`;
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			return stdout;
		} catch (error) {
			throw new Error(`Failed to get diff: ${error.message}`);
		}
	}

	async isWorkingCopy(filePath: string): Promise<boolean> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			return workingCopyRoot !== null;
		} catch (error) {
			return false;
		}
	}

	async addFile(filePath: string): Promise<void> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);

			loggerInfo(this, 'addFile paths resolved:', {
				filePath,
				absolutePath,
				workingCopyRoot
			});
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}

			// Add parent directories first if they're not already in SVN
			await this.addParentDirectories(absolutePath, workingCopyRoot);
			
			// Now add the file itself
			const command = `${this.svnPath} add "${absolutePath}"`;
			loggerInfo(this, 'Executing add command:', { command, cwd: workingCopyRoot });

			const result = await execPromise(command, { cwd: workingCopyRoot });
			loggerInfo(this, 'Add command result:', {
				stdout: result.stdout,
				stderr: result.stderr
			});
		} catch (error) {
			loggerError(this, 'addFile failed:', error);
			throw new Error(`Failed to add file to SVN: ${error.message}`);
		}
		
		// Clear cache after addFile operation to ensure fresh status data
		loggerInfo(this, 'Clearing status cache after add operation');
		this.clearStatusCache();
	}

	async removeFile(filePath: string): Promise<void> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}			// Remove the file from SVN tracking (keeps local copy)
			const command = `${this.svnPath} remove --keep-local "${absolutePath}"`;
			await execPromise(command, { cwd: workingCopyRoot });
		} catch (error) {
			throw new Error(`Failed to remove file from SVN: ${error.message}`);
		}
		
		// Clear cache after remove operation to ensure fresh status data
		this.clearStatusCache();
	}

	private async addParentDirectories(absolutePath: string, workingCopyRoot: string): Promise<void> {
		const path = require('path');
		const fs = require('fs');
		
		let currentDir = path.dirname(absolutePath);
		const dirsToAdd: string[] = [];
		
		// Walk up the directory tree and collect directories that need to be added
		while (currentDir !== workingCopyRoot && currentDir !== path.dirname(currentDir)) {
			// Check if this directory is already in SVN
			try {
				const command = `${this.svnPath} info "${currentDir}"`;
				await execPromise(command, { cwd: workingCopyRoot });
				// If we get here, the directory is already in SVN, so we can stop
				break;
			} catch (error) {
				// Directory is not in SVN, add it to our list
				if (fs.existsSync(currentDir)) {
					dirsToAdd.unshift(currentDir); // Add to beginning so we add parent first
				}
				currentDir = path.dirname(currentDir);
			}
		}
		
		// Add directories in order (parent first)
		for (const dir of dirsToAdd) {
			try {
				const command = `${this.svnPath} add --depth=empty "${dir}"`;
				await execPromise(command, { cwd: workingCopyRoot });
			} catch (error) {
				// Ignore errors for directories that might already be added
				if (!error.message.includes('is already under version control')) {
					throw error;
				}
			}
		}
	}
		async isFileInSvn(filePath: string): Promise<boolean> {
		const absolutePath = this.resolveAbsolutePath(filePath);

		// Check cache first
		if (this.isFileInSvnResultCache.has(absolutePath)) {
			return this.isFileInSvnResultCache.get(absolutePath)!;
		}

		try {
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				loggerInfo(this, `No working copy for ${filePath}`);
				this.isFileInSvnResultCache.set(absolutePath, false);
				return false;
			}

			// Use svn info directly to definitively check if file is tracked by SVN
			try {
				const infoCommand = `${this.svnPath} info "${absolutePath}"`;
				await execPromise(infoCommand, { cwd: workingCopyRoot });
				// If svn info succeeds, file is definitely versioned
				loggerInfo(this, `${filePath} is in SVN`);
				this.isFileInSvnResultCache.set(absolutePath, true);
				return true;
			} catch (infoError) {
				// If svn info fails, file is not versioned
				loggerInfo(this, `${filePath} not in SVN (info error): ${infoError.message}`);
				this.isFileInSvnResultCache.set(absolutePath, false);
				return false;
			}
		} catch (error) {
			loggerInfo(this, 'Error occurred:', { filePath, error: error.message });
			this.isFileInSvnResultCache.set(absolutePath, false);
			return false;
		}
	}

	async getBlame(filePath: string, revision?: string): Promise<SvnBlameEntry[]> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new NotWorkingCopyError(filePath);
			}

			const revisionFlag = revision ? `-r ${revision}` : '';
			const { stdout } = await execPromise(
				`"${this.svnPath}" blame --xml ${revisionFlag} "${absolutePath}"`, 
				{ cwd: workingCopyRoot }
			);

			return this.parseBlameXml(stdout);
		} catch (error: any) {
			if (error.stderr?.includes('not found')) {
				loggerError(this, `File not found in repository: ${filePath}`);
			}
			throw new SvnCommandError(`Failed to get blame for ${filePath}`, error.message, error.code);
		}
	}

	private parseBlameXml(xmlOutput: string): SvnBlameEntry[] {
		const entries: SvnBlameEntry[] = [];
		const lines = xmlOutput.split('\n');
		
		let currentEntry: Partial<SvnBlameEntry> = {};
		let lineNumber = 1;
		
		for (const line of lines) {
			if (line.includes('<entry')) {
				const lineNumMatch = line.match(/line-number="(\d+)"/);
				if (lineNumMatch) {
					lineNumber = parseInt(lineNumMatch[1]);
				}
			}
					if (line.includes('<commit')) {
				const revMatch = line.match(/revision="(\d+)"/);
				if (revMatch) {
					currentEntry.revision = parseInt(revMatch[1], 10);
				}
			}
			
			if (line.includes('<author>')) {
				currentEntry.author = line.replace(/<\/?author>/g, '').trim();
			}
			
			if (line.includes('<date>')) {
				currentEntry.date = line.replace(/<\/?date>/g, '').trim();
			}
			
			if (line.includes('</entry>')) {
				if (currentEntry.revision && currentEntry.author) {
					entries.push({
						lineNumber,
						revision: currentEntry.revision,
						author: currentEntry.author,
						date: currentEntry.date || ''
					});
				}
				currentEntry = {};
			}
		}
		
		return entries;
	}

	async getInfo(filePath: string): Promise<SvnInfo | null> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new NotWorkingCopyError(filePath);
			}

			const { stdout } = await execPromise(
				`"${this.svnPath}" info --xml "${absolutePath}"`, 
				{ cwd: workingCopyRoot }
			);

			return this.parseInfoXml(stdout);
		} catch (error: any) {
			if (error.stderr?.includes('not found')) {
				return null;
			}
			throw new SvnCommandError(`Failed to get info for ${filePath}`, error.message, error.code);
		}
	}

	private parseInfoXml(xmlOutput: string): SvnInfo | null {
		const lines = xmlOutput.split('\n');
		const info: Partial<SvnInfo> = {};
		let inCommitSection = false;
		
		// Extract basic info
		const urlMatch = xmlOutput.match(/<url>(.*?)<\/url>/);
		if (urlMatch) info.url = urlMatch[1];
		
		const repositoryRootMatch = xmlOutput.match(/<repository>[\s\S]*?<root>(.*?)<\/root>/);
		if (repositoryRootMatch) info.repositoryRoot = repositoryRootMatch[1];
		
		const repositoryUuidMatch = xmlOutput.match(/<uuid>(.*?)<\/uuid>/);
		if (repositoryUuidMatch) info.repositoryUuid = repositoryUuidMatch[1];
		// Look for entry revision (working copy revision)
		const entryRevisionMatch = xmlOutput.match(/<entry[^>]*revision="(\d+)"/);
		if (entryRevisionMatch) {
			info.revision = parseInt(entryRevisionMatch[1], 10);
			loggerDebug(this, `Entry revision: ${entryRevisionMatch[1]}`);
		}
		  // Look for last changed revision, author, and date in the commit section
		for (const line of lines) {
			if (line.includes('<commit')) {
				inCommitSection = true;				// Check for revision attribute on the same line
				const commitRevMatch = line.match(/revision="(\d+)"/);
				if (commitRevMatch) {
					loggerDebug(this, `Commit revision: ${commitRevMatch[1]}`);
					info.lastChangedRev = parseInt(commitRevMatch[1], 10);
				}
			}			// Check for revision attribute on the next line after <commit
			if (inCommitSection && !info.lastChangedRev && line.includes('revision=')) {
				const revMatch = line.match(/revision="(\d+)"/);
				if (revMatch) {
					loggerDebug(this, `Revision: ${revMatch[1]}`);
					info.lastChangedRev = parseInt(revMatch[1], 10);
				}
			}
			
			if (inCommitSection) {				if (line.includes('<author>')) {
					const authorMatch = line.match(/<author>(.*?)<\/author>/);
					if (authorMatch) {
						loggerDebug(this, `Author: ${authorMatch[1]}`);
						info.lastChangedAuthor = authorMatch[1];
					}
				}				if (line.includes('<date>')) {
					const dateMatch = line.match(/<date>(.*?)<\/date>/);
					if (dateMatch) {
						loggerDebug(this, `Date: ${dateMatch[1]}`);
						info.lastChangedDate = dateMatch[1];
					}
				}
			}
			
			if (line.includes('</commit>')) {
				inCommitSection = false;
			}
		}
		
		loggerInfo(this, 'Parsed SVN Info:', info);
		return info.url ? info as SvnInfo : null;
	}

	async getProperties(filePath: string): Promise<Record<string, string>> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new NotWorkingCopyError(filePath);
			}

			const { stdout } = await execPromise(
				`"${this.svnPath}" proplist --verbose --xml "${absolutePath}"`, 
				{ cwd: workingCopyRoot }
			);

			return this.parsePropertiesXml(stdout);
		} catch (error: any) {
			if (error.stderr?.includes('not found')) {
				return {};
			}
			throw new SvnCommandError(`Failed to get properties for ${filePath}`, error.message, error.code);
		}
	}

	private parsePropertiesXml(xmlOutput: string): Record<string, string> {
		const properties: Record<string, string> = {};
		const lines = xmlOutput.split('\n');
		
		let currentProp = '';
		let inValue = false;
		
		for (const line of lines) {
			if (line.includes('<property') && line.includes('name=')) {
				const nameMatch = line.match(/name="([^"]+)"/);
				if (nameMatch) {
					currentProp = nameMatch[1];
				}
				inValue = true;
			} else if (line.includes('</property>')) {
				inValue = false;
				currentProp = '';
			} else if (inValue && currentProp) {
				const value = line.trim();
				if (value && !value.startsWith('<')) {
					properties[currentProp] = value;
				}
			}
		}
		
		return properties;
	}

	private parseXmlLog(xmlOutput: string): SvnLogEntry[] {
		const entries: SvnLogEntry[] = [];

		loggerInfo(this, 'parseXmlLog: Starting to parse XML, length:', String(xmlOutput.length));
		loggerInfo(this, 'parseXmlLog: First 500 chars:', xmlOutput.substring(0, 500));

		// Simple XML parsing for SVN log entries
		const logEntryRegex = /<logentry[^>]*revision="([^"]+)"[^>]*>([\s\S]*?)<\/logentry>/g;
		let match;
		let matchCount = 0;
		
		while ((match = logEntryRegex.exec(xmlOutput)) !== null) {
			matchCount++;
			const entryContent = match[2];
			const revision = match[1];

			loggerInfo(this, `parseXmlLog: Found logentry ${matchCount}, revision: ${revision}`);

			const authorMatch = entryContent.match(/<author>(.*?)<\/author>/);
			const dateMatch = entryContent.match(/<date>(.*?)<\/date>/);
			const messageMatch = entryContent.match(/<msg>([\s\S]*?)<\/msg>/);
					const entry: SvnLogEntry = {
				revision: parseInt(revision, 10),
				author: authorMatch ? authorMatch[1] : 'Unknown',
				date: dateMatch ? dateMatch[1] : '',
				message: messageMatch ? messageMatch[1].trim() : ''
			};
			
			loggerInfo(this, 'parseXmlLog: Parsed entry:', entry);
			entries.push(entry);
		}

		loggerInfo(this, `parseXmlLog: Finished parsing, found ${entries.length} entries`);
		return entries;
	}	private parseStatus(statusOutput: string): SvnStatus[] {
		const lines = statusOutput.split('\n').filter(line => line.trim() !== '');
		return lines.map(line => {
			// SVN status format: first char is content status, second is property status, then spaces, then path
			const contentStatusChar = line.charAt(0) || ' ';
			const propertyStatusChar = line.charAt(1) || ' ';
			const filePath = line.substring(8).trim(); // Skip the status columns and spaces
					// Convert string status codes to enums
			const contentStatus = this.convertCharToStatusCode(contentStatusChar);
			const propertyStatus = propertyStatusChar !== ' ' ? 
				(propertyStatusChar === 'M' ? SvnPropertyStatus.MODIFIED : 
				 propertyStatusChar === 'C' ? SvnPropertyStatus.CONFLICTED : 
				 SvnPropertyStatus.NORMAL) : undefined;
			
			return {
				status: contentStatus,
				propertyStatus: propertyStatus,
				filePath: filePath,
				locked: line.charAt(2) === 'L', // Third column indicates lock status
				workingCopyLocked: line.charAt(5) === 'K' // Sixth column indicates working copy lock
			};
		});
	}
	
	/**
	 * Convert single character SVN status code to enum
	 */
	private convertCharToStatusCode(statusChar: string): SvnStatusCode {
		switch (statusChar) {
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
				loggerWarn(this, `Unknown SVN status code: ${statusChar}, defaulting to NORMAL`);
				return SvnStatusCode.NORMAL;
		}
	}

	async createRepository(repoName: string): Promise<void> {
		try {
			if (!this.vaultPath) {
				throw new Error('Vault path not set');
			}

			// The repoName should already be cleaned by the modal
			const hiddenRepoName = `.${repoName}`;
			const repoPath = join(this.vaultPath, hiddenRepoName);

			// Create the repository using svnadmin create
			const command = `svnadmin create "${repoPath}"`;
			await execPromise(command);

			loggerInfo(this, `SVN repository created at: ${repoPath}`);
		} catch (error) {
			throw new Error(`Failed to create SVN repository: ${error.message}`);
		}
	}
	
	/**
	 * Compare two file paths for equality, handling different path separators and relative/absolute paths
	 */
	comparePaths(path1: string, path2: string): boolean {
		// Normalize both paths to absolute paths and standardize separators
		const normalizedPath1 = this.resolveAbsolutePath(path1).replace(/\\/g, '/').toLowerCase();
		const normalizedPath2 = this.resolveAbsolutePath(path2).replace(/\\/g, '/').toLowerCase();
		
		loggerDebug(this, `comparePaths: "${path1}" -> "${normalizedPath1}"`);
		loggerDebug(this, `comparePaths: "${path2}" -> "${normalizedPath2}"`);

		// Direct comparison first
		if (normalizedPath1 === normalizedPath2) {
			loggerDebug(this, `comparePaths: Direct match - TRUE`);
			return true;
		}

		loggerDebug(this, `comparePaths: No direct match - FALSE`);
		return false;
	}
	
	/**
	 * Check if a directory is committed to the repository (not just added)
	 */
	private async isDirectoryVersioned(dirPath: string): Promise<boolean> {
		try {
			const workingCopyRoot = this.findSvnWorkingCopy(dirPath);
			if (!workingCopyRoot) {
				return false;
			}

			// First check svn info to see if the directory exists in SVN
			const command = `${this.svnPath} info "${dirPath}"`;
			loggerInfo(this, `Checking if directory is versioned: ${dirPath}`);

			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			
			// If svn info succeeds and returns output, check if it's actually committed
			if (stdout && stdout.includes('Path:')) {
				// Check if the directory has "Schedule: add" which means it's added but not committed
				if (stdout.includes('Schedule: add')) {
					loggerInfo(this, `Directory ${dirPath} is added but not committed yet`);
					return false; // Not yet committed to repository
				}

				loggerInfo(this, `Directory ${dirPath} is versioned and committed`);
				return true;
			}

			loggerInfo(this, `Directory ${dirPath} is not versioned (no info output)`);
			return false;
		} catch (error) {
			// If svn info fails, the directory is likely not versioned
			loggerInfo(this, `Directory ${dirPath} is not versioned (svn info failed): ${error.message}`);
			return false;
		}
	}

	/**
	 * Ensure a file is added to SVN if it's not already versioned
	 */
	private async ensureFileIsAdded(filePath: string): Promise<void> {
		try {
			const workingCopyRoot = this.findSvnWorkingCopy(filePath);
			if (!workingCopyRoot) {
				throw new Error(`File ${filePath} is not in an SVN working copy`);
			}

			// Use isFileInSvn to definitively check if file is versioned
			const isVersioned = await this.isFileInSvn(filePath);
			
			if (!isVersioned) {
				// File is unversioned, add it
				loggerInfo(this, `File ${filePath} is not versioned. Adding it.`);
				await this.add(filePath, false);
			} else {
				// File is already versioned, check its current status
				const status = await this.getStatus(filePath);
				const fileStatus = status.find(s => this.comparePaths(s.filePath, filePath));
				
				if (fileStatus && fileStatus.status === SvnStatusCode.ADDED) {
					loggerInfo(this, `File ${filePath} is already added to SVN.`);
				} else {
					loggerInfo(this, `File ${filePath} is already versioned.`);
				}
			}
		} catch (error) {
			loggerError(this, `Error ensuring file is added: ${error.message}`);
			throw new Error(`Failed to ensure file is added to SVN: ${error.message}`);
		}
	}

	/**
	 * Clear the status request cache to ensure fresh data after SVN operations
	 */
	private clearStatusCache(): void {
		loggerInfo(this, 'Clearing SVNClient status-related caches');
		this.statusRequestCache.clear();
		this.findWorkingCopyCache.clear();
		this.isFileInSvnResultCache.clear();
		if (this.cacheInvalidationCallback) {
			this.cacheInvalidationCallback();
		}
	}

	// Add the new move method here
	public async move(oldPath: string, newPath: string, options: SvnOperationOptions = {}): Promise<SvnCommandResult<string>> {
		const absoluteOldPath = this.resolveAbsolutePath(oldPath);
		const absoluteNewPath = this.resolveAbsolutePath(newPath);
		const absoluteOldPathDir = dirname(absoluteOldPath);
		const absoluteNewPathDir = dirname(absoluteNewPath);

		loggerInfo(this, `Attempting SVN move: from "${oldPath}" to "${newPath}"`);

		const workingCopyRoot = this.findSvnWorkingCopy(absoluteOldPath);
		if (!workingCopyRoot) {
			const msg = `Source path "${oldPath}" is not in an SVN working copy. No SVN move performed.`;
			loggerInfo(this, msg); // Changed from loggerWarn to loggerInfo as it's a common case
			// Return a result indicating skipped operation
			return { success: true, output: msg, skipped: true, message: msg };
		}

		const destDirWorkingCopyRoot = this.findSvnWorkingCopy(absoluteNewPathDir);
		if (!destDirWorkingCopyRoot || destDirWorkingCopyRoot !== workingCopyRoot) {
			const msg = `Destination path "${newPath}" (parent: "${absoluteNewPathDir}") appears to be outside (found WC: ${destDirWorkingCopyRoot || 'none'}) or in a different SVN working copy than the source (source WC: ${workingCopyRoot}). SVN move with history preservation is typically within the same working copy.`;
			loggerError(this, msg);
			throw new SvnError(msg + " This operation may not preserve history or may require manual SVN commands for repository-level moves.");
		}

		const command = `${this.svnPath} move --parents "${absoluteOldPath}" "${absoluteNewPath}"`;
		try {
			loggerInfo(this, 'Executing SVN move command:', command, 'in CWD:', workingCopyRoot);
			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });

			// Even if execPromise resolves, SVN might have put critical errors in stderr and exited with 0 (less common for E errors but possible for warnings)
			if (stderr && /svn: E\d+:/.test(stderr)) {
				// Check for specific skippable errors first
				if (/svn: E155010:/.test(stderr) || /svn: E200009:/.test(stderr) || /not under version control/.test(stderr.toLowerCase()) || /is not a working copy file/.test(stderr.toLowerCase())) {
					const msg = `SVN move skipped for source "${oldPath}": Source not versioned or does not exist in SVN. Detail: ${stderr.split('\n')[0]}`;
					loggerInfo(this, msg);
					this.invalidateCachesForPaths([oldPath, newPath, absoluteOldPathDir, absoluteNewPathDir]);
					return { success: true, output: msg, skipped: true, message: msg };
				} else if (/svn: E155033:/.test(stderr)) {
					// Handle E155033 specifically as it was observed
					const errLogMsg = `SVN move for "${oldPath}" to "${newPath}" failed with E155033: Target path issue. SVN stderr: ${stderr.split('\n')[0]}. SVN stdout: ${stdout || '[empty]'}`;
					loggerError(this, errLogMsg);
					this.invalidateCachesForPaths([oldPath, newPath, absoluteOldPathDir, absoluteNewPathDir]);
					throw new SvnCommandError(command, -1, stderr); // Exit code unknown if execPromise didn't throw
				}
				// For other E-errors not caught by execPromise rejection (unlikely but defensive)
				loggerError(this, 'SVN move command returned error on stderr despite resolving promise:', stderr);
				this.invalidateCachesForPaths([oldPath, newPath, absoluteOldPathDir, absoluteNewPathDir]);
				throw new SvnCommandError(command, -1, stderr);
			}

			loggerInfo(this, 'SVN move command stdout:', stdout || '[empty]');
			if (stderr) loggerInfo(this, 'SVN move command stderr (info/warnings):', stderr);

			this.invalidateCachesForPaths([oldPath, newPath, absoluteOldPathDir, absoluteNewPathDir]);
			const successMsg = `Successfully SVN moved ${basename(oldPath)} to ${newPath}.`;
			return { success: true, output: stdout || successMsg, message: successMsg };

		} catch (error: any) {
			this.invalidateCachesForPaths([oldPath, newPath, absoluteOldPathDir, absoluteNewPathDir]);

			const stderrFromError = String(error.stderr || '');
			const stdoutFromError = String(error.stdout || '');
			const exitCode = typeof error.code === 'number' ? error.code : -1;

			loggerError(this, `SVN move command execution failed for "${oldPath}" to "${newPath}":`, {
				message: error.message,
				code: exitCode,
				stderr: stderrFromError.split('\n')[0], // Log first line for brevity
				stdout: stdoutFromError
			});

			// Check for skippable errors (source not versioned/found)
			if (/svn: E155010:/.test(stderrFromError) || /svn: E200009:/.test(stderrFromError) || /not under version control/.test(stderrFromError.toLowerCase()) || /is not a working copy file/.test(stderrFromError.toLowerCase())) {
				const msg = `SVN move skipped for source "${oldPath}": Source not versioned or does not exist in SVN. Detail: ${stderrFromError.split('\n')[0]}`;
				loggerInfo(this, msg);
				return { success: true, output: msg, skipped: true, message: msg };
			}

			// Handle E155033 ("is not a directory") specifically
			if (/svn: E155033:/.test(stderrFromError)) {
				const errLogMsg = `SVN move for "${oldPath}" to "${newPath}" failed with E155033: Target path issue. SVN stderr: ${stderrFromError.split('\n')[0]}. SVN stdout: ${stdoutFromError || '[empty]'}`;
				loggerError(this, errLogMsg); // Already logged above, this is more for the throw
				throw new SvnCommandError(command, exitCode, stderrFromError); 
			}
			
			// For other SVN errors caught by execPromise rejection
			if (stderrFromError && /svn: E\d+:/.test(stderrFromError)) {
				throw new SvnCommandError(command, exitCode, stderrFromError);
			}

			// Fallback for non-SVN errors or SVN errors not matching the pattern
			throw new SvnError(`Failed to SVN move "${oldPath}" to "${newPath}": ${error.message || 'Unknown error'}`, command, stderrFromError);
		}
	}

	private invalidateCachesForPaths(pathsToInvalidate: string[]) {
		const uniqueAbsolutePaths = new Set<string>();

		pathsToInvalidate.forEach(p => {
			try {
				const absP = this.resolveAbsolutePath(p);
				uniqueAbsolutePaths.add(absP);
				// Also invalidate parent directory if it's a file path
				// For directories, the path itself is what we care about for status.
				// findSvnWorkingCopy cache is more complex, clearing specific entries is best.
				const dir = dirname(absP);
				if (dir && dir !== absP) { // Ensure it's a parent and not the path itself (e.g. for root paths)
					uniqueAbsolutePaths.add(dir);
				}
			} catch (e) {
				loggerWarn(this, `Could not resolve path for cache invalidation: ${p} - ${e.message}`);
			}
		});

		uniqueAbsolutePaths.forEach(absPath => {
			loggerDebug(this, `Invalidating cache for: ${absPath}`);
			this.statusRequestCache.delete(absPath); 
			this.isFileInSvnResultCache.delete(absPath);
			this.findWorkingCopyCache.delete(absPath); // findSvnWorkingCopy caches based on the input path

			// Attempt to clear parent paths for findWorkingCopyCache as well, as structure might affect lookups
			// This part needs to be careful not to over-invalidate or run too long.
			let current = dirname(absPath);
			while (current && current !== dirname(current) && current.startsWith(this.vaultPath)) {
				this.findWorkingCopyCache.delete(current);
				const parent = dirname(current);
				if (parent === current) break; 
				current = parent;
			}
		});

		if (this.cacheInvalidationCallback) {
			this.cacheInvalidationCallback();
		}
		loggerInfo(this, 'Caches invalidated for relevant paths:', Array.from(uniqueAbsolutePaths));
	}
}







