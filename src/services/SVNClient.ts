import { exec } from 'child_process';
import { promisify } from 'util';
import { join, dirname, isAbsolute, relative } from 'path'; // Added relative
import { existsSync, statSync } from 'fs';
import { SvnLogEntry, SvnStatus, SvnCommandResult, SvnBlameEntry, SvnInfo } from '@/types';
import { SvnError, SvnNotInstalledError, NotWorkingCopyError, SvnCommandError } from '@/utils/errors';
import { debug, info as logInfo, warn, error, registerLoggerClass } from '@/utils/obsidian-logger';

const execPromise = promisify(exec);

export class SVNClient {
	private svnPath: string;
	private vaultPath: string;
	private statusRequestCache = new Map<string, Promise<SvnStatus[]>>();
	
	// Callback for notifying when cache should be cleared
	private cacheInvalidationCallback?: () => void;
	constructor(svnPath: string = 'svn', vaultPath: string = '') {
		this.svnPath = svnPath;
		this.vaultPath = vaultPath;
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
	}	private findSvnWorkingCopy(absolutePath: string): string | null {
		// Start from the path itself, then check parent directories
		let currentPath = absolutePath;
		debug(this, 'findWorkingCopyRoot', `Looking for SVN working copy starting from: ${currentPath}`);
		
		// If the path is a file, start from its directory
		if (existsSync(currentPath) && !statSync(currentPath).isDirectory()) {
			currentPath = dirname(currentPath);
			debug(this, `Path is a file, starting from directory: ${currentPath}`);
		}
		
		while (currentPath && currentPath !== dirname(currentPath)) {
			const svnPath = join(currentPath, '.svn');			debug(this, `Checking for .svn directory at: ${svnPath}`);
			if (existsSync(svnPath)) {
				logInfo(this, 'findSvnWorkingCopy', `Found SVN working copy at: ${currentPath}`);
				return currentPath;
			}
			currentPath = dirname(currentPath);
		}
		
		error(this, `No SVN working copy found starting from: ${absolutePath}`);
		return null;
	}

	async getFileHistory(filePath: string): Promise<SvnLogEntry[]> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}
			// Get the repository URL for this file to query history directly from repository
			let repositoryUrl = null;
			try {
				// Get repository root and relative path to construct full repository URL
				const infoResult = await execPromise(`${this.svnPath} info --xml "${workingCopyRoot}"`, { cwd: workingCopyRoot });
				const rootMatch = infoResult.stdout.match(/<root>(.*?)<\/root>/);
			
			if (rootMatch) {
				const repositoryRoot = rootMatch[1];
				// Calculate relative path from working copy root to file
				const relativePath = relative(workingCopyRoot, absolutePath).replace(/\\/g, '/');
				repositoryUrl = `${repositoryRoot}/${relativePath}`;
				logInfo(this, 'logInfo', `Constructed repository URL:`, { repositoryRoot, relativePath, repositoryUrl });
			}
		} catch (infoError) {
			error(this, `Failed to get repository URL, using local path:`, infoError.message);
		}
		
		// Get complete history from repository
		// Use repository URL if available, otherwise fall back to local path
		const targetPath = repositoryUrl || absolutePath;
		const command = `${this.svnPath} log --xml --verbose --limit 100 "${targetPath}"`;
		debug(this, 'getFileHistory debug:', {
			originalFilePath: filePath,
			absolutePath,
			workingCopyRoot,
			repositoryUrl,
			targetPath,
			command,
			svnPath: this.svnPath,
			note: 'Using repository URL for direct repository query'
		});

		logInfo(this, 'Executing getFileHistory command:', command);
		logInfo(this, 'Working directory:', workingCopyRoot);
		const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
		debug(this, 'getFileHistory raw XML output:', stdout);

		const entries = this.parseXmlLog(stdout);
		debug(this, 'getFileHistory parsed entries:', entries);

		// Enrich entries with size information
		const entriesWithSize = await this.enrichHistoryWithSizes(filePath, entries);

		return entriesWithSize;
		} catch (error) {
			error(this, 'getFileHistory error:', { filePath, error: error.message });
			// Check if this is a "file not in SVN" error and preserve the original message
			const errorMessage = error.message.toLowerCase();
			if (errorMessage.includes('node was not found') || 
				errorMessage.includes('is not under version control') ||
				errorMessage.includes('no such file or directory') ||
				errorMessage.includes('path not found') ||
				errorMessage.includes('svn: e155010') || // node not found
				errorMessage.includes('svn: e200009') || // node not found (different context)
				errorMessage.includes('svn: e160013')) { // path not found
				throw error; // Preserve original error
			}
			throw new Error(`Failed to get file history: ${error.message}`);
		}
	}
	/**
	 * Enrich log entries with file size information for each revision
	 */
	private async enrichHistoryWithSizes(filePath: string, entries: SvnLogEntry[]): Promise<SvnLogEntry[]> {
		const enrichedEntries: SvnLogEntry[] = [];
		
		for (const entry of entries) {			try {
				const [size, repoSize] = await Promise.all([
					this.getFileSizeAtRevision(filePath, entry.revision),
					this.getRevisionStorageSize(entry.revision)
				]);
				
				enrichedEntries.push({
					...entry,
					size: size !== null ? size : undefined,
					repoSize: repoSize !== null ? repoSize : undefined
				});
			} catch (error) {
				error(this, `Failed to get size info for revision ${entry.revision}:`, error.message);
				// Add entry without size information
				enrichedEntries.push(entry);
			}
		}
		
		return enrichedEntries;
	}

	async getFileRevisions(filePath: string): Promise<string[]> {
		try {
			const history = await this.getFileHistory(filePath);
			return history.map(entry => entry.revision);
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
			error(this, `Failed to get file size for revision ${revision}:`, error.message);
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
				debug(this, `Strategy 1 - Vault path ${this.vaultPath}, found working copy:`, workingCopyRoot);
			}
			
			// Strategy 2: Try parent of vault path
			if (!workingCopyRoot && this.vaultPath) {
				const parentPath = dirname(this.vaultPath);
				workingCopyRoot = this.findSvnWorkingCopy(parentPath);
				debug(this, `Strategy 2 - Parent of vault path ${parentPath}, found working copy:`, workingCopyRoot);
			}
			
			// Strategy 3: Try current working directory
			if (!workingCopyRoot) {
				workingCopyRoot = this.findSvnWorkingCopy(process.cwd());
				debug(this, `Strategy 3 - CWD ${process.cwd()}, found working copy:`, workingCopyRoot);
			}
			
			// Strategy 4: Try parent of current working directory
			if (!workingCopyRoot) {
				const parentCwd = dirname(process.cwd());
				workingCopyRoot = this.findSvnWorkingCopy(parentCwd);
				debug(this, `Strategy 4 - Parent of CWD ${parentCwd}, found working copy:`, workingCopyRoot);
			}
			
			if (!workingCopyRoot) {
				error(this, `Could not find SVN working copy. Vault path: ${this.vaultPath}, CWD: ${process.cwd()}`);
				return null;
			}

			logInfo(this, 'logInfo', `Getting repository size for revision ${revision}, working copy: ${workingCopyRoot}`);

			// Get repository root path from svn info
			const infoCommand = `${this.svnPath} info --xml "${workingCopyRoot}"`;
			const infoResult = await execPromise(infoCommand, { cwd: workingCopyRoot });
			
			const rootMatch = infoResult.stdout.match(/<root>(.*?)<\/root>/);
			if (!rootMatch) {
				error(this, 'Could not determine repository path from svn info');
				return null;
			}
			
			const repositoryUrl = rootMatch[1];
			debug(this, 'Repository URL found:', repositoryUrl);
			
			// Convert file:// URL to local path for svnadmin
			let repositoryPath = repositoryUrl.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
			// Convert forward slashes to backslashes on Windows
			repositoryPath = repositoryPath.replace(/\//g, '\\');
			
			debug(this, 'Repository path converted:', repositoryPath);
			
			// Use svnadmin rev-size to get the actual repository storage size
			const command = `svnadmin rev-size "${repositoryPath}" -r ${revision} -q`;
			debug(this, 'Executing command:', command);
			
			const result = await execPromise(command);
			
			const size = parseInt(result.stdout.trim(), 10);
			if (!isNaN(size)) {
				logInfo(this, 'logInfo', `Repository size for revision ${revision}: ${size} bytes`);
				return size;
			}
			
			error(this, `Could not parse repository size from output: ${result.stdout}`);
			return null;		} catch (error: any) {
			error(this, `Failed to get repository size for revision ${revision}:`, error.message);
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
				logInfo(this, 'logInfo', 'Reverted local changes before checkout');
			} catch (revertError) {
				// Ignore revert errors if file has no local changes
				error(this, 'No local changes to revert:', revertError.message);
			}
			
			// Use svn update with specific revision for the single file
			// This properly updates the working copy metadata while changing just this file
			const updateCommand = `${this.svnPath} update -r ${revision} "${absolutePath}"`;
			const result = await execPromise(updateCommand, { cwd: workingCopyRoot });
			logInfo(this, 'SVN update result:', result.stdout);
			
			logInfo(this, 'logInfo', `Checked out revision ${revision} for file ${filePath}`);
		} catch (error) {
			throw new Error(`Failed to checkout revision ${revision}: ${error.message}`);
		}
	}
	
	async commitFile(filePath: string, message: string): Promise<void> {
		const fullPath = this.resolveAbsolutePath(filePath);
		logInfo(this, 'commitFile called with:', { fullPath, message });

		try {
			// Ensure parent directories are versioned before committing
			await this.ensureParentDirectoriesAreVersioned(fullPath);
			
			// Ensure the file itself is added to SVN
			await this.ensureFileIsAdded(fullPath);

			const command = `svn commit -m "${message}" "${fullPath}"`;
			logInfo(this, 'Executing command:', { command });
			const { stdout, stderr } = await execPromise(command);

			if (stderr) {
				error(this, `Error committing file ${fullPath}: ${stderr}`);

				// Check for the specific error about parent directory not being versioned
				if (stderr.includes('is not known to exist in the repository')) {
					throw new Error(`Failed to commit file: Parent directory is not versioned. This should have been handled automatically. ${stderr}`);
				}
				
				throw new Error(`Failed to commit file: ${stderr}`);
			}
			logInfo(this, 'logInfo', `File ${fullPath} committed successfully: ${stdout}`);
		} catch (error) {
			error(this, `Exception in commitFile for ${fullPath}: ${error}`);
			throw error; // Re-throw the original error for higher-level handling
		}
		
		// Clear cache after commit operation to ensure fresh status data
		this.clearStatusCache();
	}
	
	async ensureParentDirectoriesAreVersioned(filePath: string): Promise<void> {
		let parentDir = dirname(filePath);
		const repoRoot = this.findSvnWorkingCopy(filePath);

		if (!repoRoot) {
			error(this, `Could not determine repository root for ${filePath}. Skipping parent directory check.`);
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
				
				if (dirStatus && dirStatus.status === 'A') {
					// Directory is added but not committed
					dirsToCommit.unshift(parentDir);
					logInfo(this, 'logInfo', `Directory ${parentDir} is added but needs to be committed`);
				} else {
					// Directory is not versioned at all
					dirsToAdd.unshift(parentDir);
					logInfo(this, 'logInfo', `Directory ${parentDir} needs to be added`);
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
			logInfo(this, 'logInfo', `Adding directory ${dirToAdd} with --depth empty`);
			try {
				await this.add(dirToAdd, true); // true for --depth empty
			} catch (addError) {
				error(this, `Failed to add directory ${dirToAdd}: ${addError}`);
				throw new Error(`Failed to add directory ${dirToAdd} during pre-commit check: ${addError}`);
			}
		}

		// Then, commit directories that are added but not committed
		for (const dirToCommit of dirsToCommit) {
			logInfo(this, 'logInfo', `Committing directory ${dirToCommit}`);
			try {
				const command = `svn commit -m "Add directory" "${dirToCommit}"`;
				await execPromise(command);
				logInfo(this, 'logInfo', `Successfully committed directory ${dirToCommit}`);
			} catch (commitError) {
				error(this, `Failed to commit directory ${dirToCommit}: ${commitError}`);
				throw new Error(`Failed to commit directory ${dirToCommit} during pre-commit check: ${commitError}`);
			}
		}
	}

	async add(filePath: string, depthEmpty: boolean = false): Promise<void> {
		const fullPath = this.resolveAbsolutePath(filePath);
		logInfo(this, 'add called with:', { fullPath, depthEmpty });
		const depthOption = depthEmpty ? '--depth empty ' : '';
		const command = `svn add ${depthOption}"${fullPath}"`;
		logInfo(this, 'Executing command:', { command });
		try {
			const { stdout, stderr } = await execPromise(command);
			if (stderr) {
				// Ignore "already under version control" error for adds
				if (!stderr.includes("is already under version control")) {
					error(this, `Error adding file/directory ${fullPath}: ${stderr}`);
					throw new Error(`Failed to add file/directory: ${stderr}`);
				} else {
					logInfo(this, 'logInfo', `${fullPath} is already under version control. No action needed.`);
				}
			}
			if (stdout) {
				logInfo(this, 'logInfo', `${fullPath} added successfully: ${stdout}`);
			}
		} catch (error) {
			error(this, `Exception in add for ${fullPath}: ${error}`);
			// Check if the error is because the file is already versioned
			if (error.message && error.message.includes("is already under version control")) {
				logInfo(this, 'logInfo', `${fullPath} is already under version control. No action needed.`);
			} else {
				throw error; // Re-throw other errors
			}
		}
		
		// Clear cache after add operation to ensure fresh status data
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
			logInfo(this, 'logInfo', cacheKey);
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

			logInfo(this, 'getStatus called with path:', path);

			if (path) {
				const absolutePath = this.resolveAbsolutePath(path);
				workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
				targetPath = absolutePath;
				logInfo(this, 'Resolved paths:', {
					originalPath: path,
					absolutePath,
					workingCopyRoot,
					targetPath
				});
			} else {
				workingCopyRoot = this.findSvnWorkingCopy(this.vaultPath);
				targetPath = '';
				logInfo(this, 'Using vault path:', {
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

			logInfo(this, 'Executing command:', {
				command,
				cwd: workingCopyRoot
			});
			
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			
			logInfo(this, 'Raw status output:', {
				stdout: stdout.substring(0, 200) + (stdout.length > 200 ? '...' : ''),
				outputLength: stdout.length
			});
			
			const result = this.parseStatus(stdout);
			logInfo(this, 'Parsed status result:', {
				resultCount: result.length,
				results: result
			});
			
			return result;
		} catch (error) {
			error(this, 'getStatus error:', error);
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
		logInfo(this, 'addFile called:', { filePath });
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);

			logInfo(this, 'addFile paths resolved:', {
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
			logInfo(this, 'Executing add command:', { command, cwd: workingCopyRoot });

			const result = await execPromise(command, { cwd: workingCopyRoot });
			logInfo(this, 'Add command result:', {
				stdout: result.stdout,
				stderr: result.stderr
			});
		} catch (error) {
			error(this, 'addFile failed:', error);
			throw new Error(`Failed to add file to SVN: ${error.message}`);
		}
		
		// Clear cache after addFile operation to ensure fresh status data
		logInfo(this, 'logInfo', 'Clearing status cache after add operation');
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
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				logInfo(this, 'logInfo', filePath);
				return false;
			}

			// Use svn info directly to definitively check if file is tracked by SVN
			// This avoids cache coherency issues and provides the most accurate result
			try {
				const infoCommand = `${this.svnPath} info "${absolutePath}"`;
				await execPromise(infoCommand, { cwd: workingCopyRoot });
				// If svn info succeeds, file is definitely versioned
				logInfo(this, 'logInfo', filePath);
				return true;
			} catch (infoError) {
				// If svn info fails, file is not versioned
				logInfo(this, 'logInfo', filePath, infoError.message);
				return false;
			}
		} catch (error) {
			logInfo(this, 'isFileInSvn: Error occurred:', { filePath, error: error.message });
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
				throw new error(this, `File not found in repository: ${filePath}`);
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
					currentEntry.revision = revMatch[1];
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
			info.revision = entryRevisionMatch[1];
			debug(this, 'parseSvnInfo', `Entry revision: ${entryRevisionMatch[1]}`);
		}
		  // Look for last changed revision, author, and date in the commit section
		for (const line of lines) {
			if (line.includes('<commit')) {
				inCommitSection = true;				// Check for revision attribute on the same line
				const commitRevMatch = line.match(/revision="(\d+)"/);
				if (commitRevMatch) {
					debug(this, 'parseSvnInfo', `Commit revision: ${commitRevMatch[1]}`);
					info.lastChangedRev = commitRevMatch[1];
				}
			}
					// Check for revision attribute on the next line after <commit
			if (inCommitSection && !info.lastChangedRev && line.includes('revision=')) {
				const revMatch = line.match(/revision="(\d+)"/);
				if (revMatch) {
					debug(this, 'parseSvnInfo', `Revision: ${revMatch[1]}`);
					info.lastChangedRev = revMatch[1];
				}
			}
			
			if (inCommitSection) {				if (line.includes('<author>')) {
					const authorMatch = line.match(/<author>(.*?)<\/author>/);
					if (authorMatch) {
						debug(this, 'parseSvnInfo', `Author: ${authorMatch[1]}`);
						info.lastChangedAuthor = authorMatch[1];
					}
				}				if (line.includes('<date>')) {
					const dateMatch = line.match(/<date>(.*?)<\/date>/);
					if (dateMatch) {
						debug(this, 'parseSvnInfo', `Date: ${dateMatch[1]}`);
						info.lastChangedDate = dateMatch[1];
					}
				}
			}
			
			if (line.includes('</commit>')) {
				inCommitSection = false;
			}
		}
		
		logInfo(this, 'parseSvnInfo', 'Parsed SVN Info:', info);
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

		logInfo(this, 'parseXmlLog: Starting to parse XML, length:', String(xmlOutput.length));
		logInfo(this, 'parseXmlLog: First 500 chars:', xmlOutput.substring(0, 500));

		// Simple XML parsing for SVN log entries
		const logEntryRegex = /<logentry[^>]*revision="([^"]+)"[^>]*>([\s\S]*?)<\/logentry>/g;
		let match;
		let matchCount = 0;
		
		while ((match = logEntryRegex.exec(xmlOutput)) !== null) {
			matchCount++;
			const entryContent = match[2];
			const revision = match[1];

			logInfo(this, 'logInfo', `parseXmlLog: Found logentry ${matchCount}, revision: ${revision}`);

			const authorMatch = entryContent.match(/<author>(.*?)<\/author>/);
			const dateMatch = entryContent.match(/<date>(.*?)<\/date>/);
			const messageMatch = entryContent.match(/<msg>([\s\S]*?)<\/msg>/);
			
			const entry = {
				revision: revision,
				author: authorMatch ? authorMatch[1] : 'Unknown',
				date: dateMatch ? dateMatch[1] : '',
				message: messageMatch ? messageMatch[1].trim() : ''
			};
			
			logInfo(this, 'parseXmlLog: Parsed entry:', entry);
			entries.push(entry);
		}

		logInfo(this, 'logInfo', `parseXmlLog: Finished parsing, found ${entries.length} entries`);
		return entries;
	}

	private parseStatus(statusOutput: string): SvnStatus[] {
		const lines = statusOutput.split('\n').filter(line => line.trim() !== '');
		return lines.map(line => ({
			status: line.charAt(0),
			filePath: line.substring(8).trim()
		}));
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

			logInfo(this, 'logInfo', `SVN repository created at: ${repoPath}`);
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
		
		debug(this, `comparePaths: "${path1}" -> "${normalizedPath1}"`);
		debug(this, `comparePaths: "${path2}" -> "${normalizedPath2}"`);

		// Direct comparison first
		if (normalizedPath1 === normalizedPath2) {
			debug(this, `comparePaths: Direct match - TRUE`);
			return true;
		}

		debug(this, `comparePaths: No direct match - FALSE`);
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
			logInfo(this, 'logInfo', `Checking if directory is versioned: ${dirPath}`);

			const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
			
			// If svn info succeeds and returns output, check if it's actually committed
			if (stdout && stdout.includes('Path:')) {
				// Check if the directory has "Schedule: add" which means it's added but not committed
				if (stdout.includes('Schedule: add')) {
					logInfo(this, 'logInfo', `Directory ${dirPath} is added but not committed yet`);
					return false; // Not yet committed to repository
				}

				logInfo(this, 'logInfo', `Directory ${dirPath} is versioned and committed`);
				return true;
			}

			logInfo(this, 'logInfo', `Directory ${dirPath} is not versioned (no info output)`);
			return false;
		} catch (error) {
			// If svn info fails, the directory is likely not versioned
			logInfo(this, 'logInfo', `Directory ${dirPath} is not versioned (svn info failed): ${error.message}`);
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
				logInfo(this, 'logInfo', `File ${filePath} is not versioned. Adding it.`);
				await this.add(filePath, false);
			} else {
				// File is already versioned, check its current status
				const status = await this.getStatus(filePath);
				const fileStatus = status.find(s => this.comparePaths(s.filePath, filePath));
				
				if (fileStatus && fileStatus.status === 'A') {
					logInfo(this, 'logInfo', `File ${filePath} is already added to SVN.`);
				} else {
					logInfo(this, 'logInfo', `File ${filePath} is already versioned.`);
				}
			}
		} catch (error) {
			error(this, `Error ensuring file is added: ${error.message}`);
			throw new Error(`Failed to ensure file is added to SVN: ${error.message}`);
		}
	}

	/**
	 * Clear the status request cache to ensure fresh data after SVN operations
	 */
	private clearStatusCache(): void {
		logInfo(this, 'logInfo', `Clearing status request cache`);
		this.statusRequestCache.clear();
		
		// Notify DataStore to clear its cache as well
		if (this.cacheInvalidationCallback) {
			logInfo(this, 'logInfo', `Notifying DataStore to clear cache`);
			this.cacheInvalidationCallback();
		}
	}
}







