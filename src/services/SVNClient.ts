import { exec } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { SvnLogEntry, SvnStatus, SvnCommandResult, SvnBlameEntry, SvnInfo } from '../types';
import { SvnError, SvnNotInstalledError, NotWorkingCopyError, SvnCommandError } from '../utils/errors';

const execPromise = promisify(exec);

export class SVNClient {
	private svnPath: string;
	private vaultPath: string;

	constructor(svnPath: string = 'svn', vaultPath: string = '') {
		this.svnPath = svnPath;
		this.vaultPath = vaultPath;
	}

	setVaultPath(vaultPath: string) {
		this.vaultPath = vaultPath;
	}

	getVaultPath(): string {
		return this.vaultPath;
	}

	private resolveAbsolutePath(relativePath: string): string {
		if (!this.vaultPath) {
			throw new Error('Vault path not set');
		}
		return join(this.vaultPath, relativePath);
	}

	private findSvnWorkingCopy(absolutePath: string): string | null {
		let currentPath = dirname(absolutePath);
		
		while (currentPath && currentPath !== dirname(currentPath)) {
			const svnPath = join(currentPath, '.svn');
			if (existsSync(svnPath)) {
				return currentPath;
			}
			currentPath = dirname(currentPath);
		}
		
		return null;
	}

	async getFileHistory(filePath: string): Promise<SvnLogEntry[]> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}
			
			// Get complete history from repository (not just working copy)
			const command = `${this.svnPath} log --xml -r HEAD:1 "${absolutePath}"`;
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			return this.parseXmlLog(stdout);
		} catch (error) {
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

	async getFileRevisions(filePath: string): Promise<string[]> {
		try {
			const history = await this.getFileHistory(filePath);
			return history.map(entry => entry.revision);
		} catch (error) {
			throw new Error(`Failed to get file revisions: ${error.message}`);
		}
	}    async checkoutRevision(filePath: string, revision: string): Promise<void> {
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
				console.log('Reverted local changes before checkout');
			} catch (revertError) {
				// Ignore revert errors if file has no local changes
				console.log('No local changes to revert:', revertError.message);
			}
			
			// Use svn update with specific revision for the single file
			// This properly updates the working copy metadata while changing just this file
			const updateCommand = `${this.svnPath} update -r ${revision} "${absolutePath}"`;
			const result = await execPromise(updateCommand, { cwd: workingCopyRoot });
			console.log('SVN update result:', result.stdout);
			
			console.log(`Checked out revision ${revision} for file ${filePath}`);
		} catch (error) {
			throw new Error(`Failed to checkout revision ${revision}: ${error.message}`);
		}
	}

	async commitFile(filePath: string, message: string): Promise<void> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}
			
			// First add the file if it's not already added
			try {
				await execPromise(`${this.svnPath} add "${absolutePath}"`, { cwd: workingCopyRoot });
			} catch {
				// File might already be added, continue
			}

			// Check if we need to commit parent directories first
			await this.commitParentDirectoriesIfNeeded(absolutePath, workingCopyRoot, message);
			
			// Try to commit the file
			try {
				const command = `${this.svnPath} commit -m "${message}" "${absolutePath}"`;
				await execPromise(command, { cwd: workingCopyRoot });
			} catch (commitError) {
				// Check if this is an "out of date" error
				const errorMsg = commitError.message.toLowerCase();
				if (errorMsg.includes('is out of date') || 
					errorMsg.includes('e155011') || 
					errorMsg.includes('e160028')) {
					
					// Update the file first, then try to commit again
					await this.updateFileAndRetryCommit(absolutePath, workingCopyRoot, message);
				} else {
					// Some other error, re-throw it
					throw commitError;
				}
			}
		} catch (error) {
			throw new Error(`Failed to commit file: ${error.message}`);
		}
	}

	private async updateFileAndRetryCommit(absolutePath: string, workingCopyRoot: string, message: string): Promise<void> {
		try {
			// Update the file to get the latest version
			const updateCommand = `${this.svnPath} update "${absolutePath}"`;
			const { stdout } = await execPromise(updateCommand, { cwd: workingCopyRoot });
			
			// Check if there are conflicts after update
			if (stdout.includes('C ') || stdout.includes('Conflict')) {
				throw new Error('File has conflicts after update. Please resolve conflicts manually and try again.');
			}
			
			// If update was successful and no conflicts, try to commit again
			const commitCommand = `${this.svnPath} commit -m "${message}" "${absolutePath}"`;
			await execPromise(commitCommand, { cwd: workingCopyRoot });
			
		} catch (error) {
			if (error.message.includes('File has conflicts')) {
				throw error; // Re-throw conflict errors as-is
			}
			throw new Error(`Failed to update and commit file: ${error.message}`);
		}
	}

	private async commitParentDirectoriesIfNeeded(absolutePath: string, workingCopyRoot: string, message: string): Promise<void> {
		const path = require('path');
		
		let currentDir = path.dirname(absolutePath);
		const dirsToCommit: string[] = [];
		
		// Walk up the directory tree and find directories that are added but not committed
		while (currentDir !== workingCopyRoot && currentDir !== path.dirname(currentDir)) {
			try {
				// Check if this directory is added but not committed
				const statusCommand = `${this.svnPath} status "${currentDir}"`;
				const { stdout } = await execPromise(statusCommand, { cwd: workingCopyRoot });
				
				// If status shows 'A' (added), it needs to be committed
				if (stdout.trim().startsWith('A')) {
					dirsToCommit.unshift(currentDir); // Add to beginning so we commit parent first
				}
				
				currentDir = path.dirname(currentDir);
			} catch (error) {
				// Directory might not be in working copy, stop here
				break;
			}
		}
		
		// Commit directories in order (parent first)
		for (const dir of dirsToCommit) {
			try {
				const commitCommand = `${this.svnPath} commit -m "${message}" --depth=empty "${dir}"`;
				await execPromise(commitCommand, { cwd: workingCopyRoot });
			} catch (error) {
				// If commit fails, it might already be committed or there might be another issue
				console.warn(`Failed to commit directory ${dir}:`, error.message);
			}
		}
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
	}    async getStatus(path?: string): Promise<SvnStatus[]> {
		try {
			let workingCopyRoot: string | null;
			let targetPath: string;
			
			console.log('[SVN Client] getStatus called with path:', path);
			
			if (path) {
				const absolutePath = this.resolveAbsolutePath(path);
				workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
				targetPath = absolutePath;
				console.log('[SVN Client] Resolved paths:', {
					originalPath: path,
					absolutePath,
					workingCopyRoot,
					targetPath
				});
			} else {
				workingCopyRoot = this.findSvnWorkingCopy(this.vaultPath);
				targetPath = '';
				console.log('[SVN Client] Using vault path:', {
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
			
			console.log('[SVN Client] Executing command:', {
				command,
				cwd: workingCopyRoot
			});
			
			const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
			
			console.log('[SVN Client] Raw status output:', {
				stdout: stdout.substring(0, 200) + (stdout.length > 200 ? '...' : ''),
				outputLength: stdout.length
			});
			
			const result = this.parseStatus(stdout);
			console.log('[SVN Client] Parsed status result:', {
				resultCount: result.length,
				results: result
			});
			
			return result;
		} catch (error) {
			console.error('[SVN Client] getStatus error:', error);
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
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}

			// Add parent directories first if they're not already in SVN
			await this.addParentDirectories(absolutePath, workingCopyRoot);
			
			// Now add the file itself
			const command = `${this.svnPath} add "${absolutePath}"`;
			await execPromise(command, { cwd: workingCopyRoot });
		} catch (error) {
			throw new Error(`Failed to add file to SVN: ${error.message}`);
		}
	}

	async removeFile(filePath: string): Promise<void> {
		try {
			const absolutePath = this.resolveAbsolutePath(filePath);
			const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
			
			if (!workingCopyRoot) {
				throw new Error('File is not in an SVN working copy');
			}

			// Remove the file from SVN tracking (keeps local copy)
			const command = `${this.svnPath} remove --keep-local "${absolutePath}"`;
			await execPromise(command, { cwd: workingCopyRoot });
		} catch (error) {
			throw new Error(`Failed to remove file from SVN: ${error.message}`);
		}
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
				return false;
			}

			const { stdout } = await execPromise(`"${this.svnPath}" status "${absolutePath}"`, {
				cwd: workingCopyRoot
			});

			return !stdout.includes('?');
		} catch (error) {
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
				throw new SvnError(`File not found in repository: ${filePath}`);
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
			console.log('Found entry revision (working copy):', entryRevisionMatch[1]);
		}
		  // Look for last changed revision, author, and date in the commit section
		for (const line of lines) {
			if (line.includes('<commit')) {
				inCommitSection = true;
				// Check for revision attribute on the same line
				const commitRevMatch = line.match(/revision="(\d+)"/);
				if (commitRevMatch) {
					console.log('Found commit revision on same line:', commitRevMatch[1]);
					info.lastChangedRev = commitRevMatch[1];
				}
			}
			
			// Check for revision attribute on the next line after <commit
			if (inCommitSection && !info.lastChangedRev && line.includes('revision=')) {
				const revMatch = line.match(/revision="(\d+)"/);
				if (revMatch) {
					console.log('Found commit revision on separate line:', revMatch[1]);
					info.lastChangedRev = revMatch[1];
				}
			}
			
			if (inCommitSection) {
				if (line.includes('<author>')) {
					const authorMatch = line.match(/<author>(.*?)<\/author>/);
					if (authorMatch) {
						console.log('Found commit author:', authorMatch[1]);
						info.lastChangedAuthor = authorMatch[1];
					}
				}
				if (line.includes('<date>')) {
					const dateMatch = line.match(/<date>(.*?)<\/date>/);
					if (dateMatch) {
						console.log('Found commit date:', dateMatch[1]);
						info.lastChangedDate = dateMatch[1];
					}
				}
			}
			
			if (line.includes('</commit>')) {
				inCommitSection = false;
			}
		}
		
		console.log('Parsed SVN Info:', info);
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
		
		// Simple XML parsing for SVN log entries
		const logEntryRegex = /<logentry[^>]*revision="([^"]+)"[^>]*>([\s\S]*?)<\/logentry>/g;
		let match;
		
		while ((match = logEntryRegex.exec(xmlOutput)) !== null) {
			const entryContent = match[2];
			const revision = match[1];
			
			const authorMatch = entryContent.match(/<author>(.*?)<\/author>/);
			const dateMatch = entryContent.match(/<date>(.*?)<\/date>/);
			const messageMatch = entryContent.match(/<msg>([\s\S]*?)<\/msg>/);
			
			entries.push({
				revision: revision,
				author: authorMatch ? authorMatch[1] : 'Unknown',
				date: dateMatch ? dateMatch[1] : '',
				message: messageMatch ? messageMatch[1].trim() : ''
			});
		}        
		return entries;
	}

	private parseStatus(statusOutput: string): SvnStatus[] {
		const lines = statusOutput.split('\n').filter(line => line.trim() !== '');
		return lines.map(line => ({
			status: line.charAt(0),
			filePath: line.substring(8).trim()
		}));
	}    async createRepository(repoName: string): Promise<void> {
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

			console.log(`SVN repository created at: ${repoPath}`);
		} catch (error) {
			throw new Error(`Failed to create SVN repository: ${error.message}`);
		}
	}
}