import { exec } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { SvnLogEntry, SvnStatus, SvnCommandResult } from '../types';
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
            
            const command = `${this.svnPath} log --xml "${absolutePath}"`;
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
    }

    async checkoutRevision(filePath: string, revision: string): Promise<void> {
        try {
            const absolutePath = this.resolveAbsolutePath(filePath);
            const workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
            
            if (!workingCopyRoot) {
                throw new Error('File is not in an SVN working copy');
            }
            
            const command = `${this.svnPath} update -r ${revision} "${absolutePath}"`;
            await execPromise(command, { cwd: workingCopyRoot });
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
    }

    async getStatus(path?: string): Promise<SvnStatus[]> {
        try {
            let workingCopyRoot: string | null;
            let targetPath: string;
            
            if (path) {
                const absolutePath = this.resolveAbsolutePath(path);
                workingCopyRoot = this.findSvnWorkingCopy(absolutePath);
                targetPath = absolutePath;
            } else {
                workingCopyRoot = this.findSvnWorkingCopy(this.vaultPath);
                targetPath = '';
            }
            
            if (!workingCopyRoot) {
                throw new Error('Path is not in an SVN working copy');
            }
            
            const command = targetPath ? 
                `${this.svnPath} status "${targetPath}"` : 
                `${this.svnPath} status`;
            const { stdout } = await execPromise(command, { cwd: workingCopyRoot });
            return this.parseStatus(stdout);
        } catch (error) {
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
            
            // Use svn status to check if file is tracked
            const command = `${this.svnPath} status "${absolutePath}"`;
            const { stdout, stderr } = await execPromise(command, { cwd: workingCopyRoot });
            
            // If the file is not tracked, svn status will show it with '?' prefix
            // If it's tracked, it will show its status or nothing if clean
            const lines = stdout.split('\n').filter(line => line.trim());
            
            // Check if any line shows this file as untracked (starts with '?')
            for (const line of lines) {
                if (line.trim().startsWith('?') && line.includes(absolutePath)) {
                    console.log('File is untracked (? status)');
                    return false; // File is not tracked
                }
            }
            
            // If no '?' status found, try svn info to be sure
            try {
                await execPromise(`${this.svnPath} info "${absolutePath}"`, { cwd: workingCopyRoot });
                console.log('File is tracked (svn info succeeded)');
                return true; // File is tracked
            } catch (infoError) {
                // svn info failed, probably not tracked
                console.log('File is not tracked (svn info failed):', infoError.message);
                return false;
            }
            
        } catch (error) {
            // If svn status fails entirely, assume not tracked
            console.log('isFileInSvn failed:', error.message);
            return false;
        }
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
        const lines = statusOutput.split('\n').filter(line => line.trim());
        return lines.map(line => ({
            status: line.charAt(0),
            filePath: line.substring(8).trim()
        }));
    }
}