import { join, dirname, isAbsolute, basename } from 'path';
import { existsSync, statSync } from 'fs';
import { loggerDebug, loggerInfo, loggerWarn, loggerError } from '@/utils/obsidian-logger';

// @registerLoggerClass // Temporarily removed to resolve tslib/decorator issue
export class SVNPathResolver {
	private vaultPath: string;
	private findWorkingCopyCache = new Map<string, string | null>();

	constructor(vaultPath: string) {
		this.vaultPath = vaultPath;
		loggerInfo(this, 'SVNPathResolver constructor: Received vault path:', vaultPath);
		
		if (!vaultPath) {
			loggerWarn(this, 'SVNPathResolver constructor: Vault path is empty or undefined');
		}
	}

	public setVaultPath(vaultPath: string): void {
		this.vaultPath = vaultPath;
		this.findWorkingCopyCache.clear();
		loggerInfo(this, 'Vault path updated in SVNPathResolver.');
	}

	public getVaultPath(): string {
		return this.vaultPath;
	}

	public resolveAbsolutePath(filePath: string): string {
		if (isAbsolute(filePath)) {
			return filePath;
		}
		if (!this.vaultPath) {
			loggerError(this, 'Vault path not set in SVNPathResolver during resolveAbsolutePath.');
			throw new Error('Vault path not set in SVNPathResolver');
		}
		return join(this.vaultPath, filePath);
	}

	public findSvnWorkingCopy(filePathOrDirPath: string): string | null {
		const absolutePath = this.resolveAbsolutePath(filePathOrDirPath);

		if (this.findWorkingCopyCache.has(absolutePath)) {
			return this.findWorkingCopyCache.get(absolutePath)!;
		}

		let currentPath = absolutePath;
		// If the path is a file, start from its directory
		try {
			if (existsSync(currentPath) && statSync(currentPath).isFile()) {
				currentPath = dirname(currentPath);
				loggerDebug(this, `Path is a file, starting from directory: ${currentPath}`);
			}
		} catch (error) {
			loggerWarn(this, `Error accessing path ${currentPath} during findSvnWorkingCopy: ${error.message}`);
			this.findWorkingCopyCache.set(absolutePath, null);
			return null; // Cannot determine working copy if path is inaccessible
		}


		let result: string | null = null;
		let searchPath = currentPath;
		// Ensure searchPath is valid and we are not going above a sensible root.
		// The dirname(searchPath) check prevents infinite loops on root paths.
		while (searchPath && searchPath !== dirname(searchPath)) {
			const svnAdminDir = join(searchPath, '.svn');
			loggerDebug(this, `Checking for .svn directory at: ${svnAdminDir}`);
			try {
				if (existsSync(svnAdminDir) && statSync(svnAdminDir).isDirectory()) {
					loggerInfo(this, 'findSvnWorkingCopy', `Found SVN working copy at: ${searchPath}`);
					result = searchPath;
					break;
				}
			} catch (error) {
				// Ignore errors from existsSync/statSync if a path segment is not accessible, continue search upwards
				loggerDebug(this, `Error checking ${svnAdminDir}, continuing search: ${error.message}`);
			}
			searchPath = dirname(searchPath);
		}

		if (!result) {
			loggerInfo(this, `No SVN working copy found for path: ${absolutePath}`);
		}

		this.findWorkingCopyCache.set(absolutePath, result);
		return result;
	}
	
	public comparePaths(path1: string, path2: string): boolean {
		const normalizedPath1 = this.resolveAbsolutePath(path1).replace(/\\/g, '/').toLowerCase();
		const normalizedPath2 = this.resolveAbsolutePath(path2).replace(/\\/g, '/').toLowerCase();
		
		// Only log when paths don't match to reduce noise
		const areEqual = normalizedPath1 === normalizedPath2;
		if (!areEqual) {
			loggerDebug(this, `comparePaths: "${path1}" vs "${path2}" - no match`);
		}
		return areEqual;
	}

	/**
	 * Resolves the directory name of a given path.
	 * @param filePath The path to resolve.
	 * @returns The directory name of the path.
	 */
	dirname(filePath: string): string {
		const absolutePath = this.resolveAbsolutePath(filePath);
		return dirname(absolutePath);
	}

	/**
	 * Resolves the base name of a given path.
	 * @param filePath The path to resolve.
	 * @returns The base name of the path.
	 */
	basename(filePath: string): string {
		const absolutePath = this.resolveAbsolutePath(filePath);
		return basename(absolutePath);
	}    /**
	 * Returns a display-friendly version of the path, relative to the vault if possible.
	 * @param filePath The absolute path.
	 * @returns A display-friendly path string.
	 */
	getDisplayPath(filePath: string): string {
		const absolutePath = this.resolveAbsolutePath(filePath);
		if (this.vaultPath && absolutePath.startsWith(this.vaultPath)) {
			// Make it relative to vault and use forward slashes for display
			return join('.', absolutePath.substring(this.vaultPath.length)).replace(/\\/g, '/');
		}
		return absolutePath.replace(/\\/g, '/'); // Fallback to absolute path with forward slashes
	}    /**
	 * Checks if childPath is a subpath of parentPath.
	 * @param parentPath The potential parent path.
	 * @param childPath The potential child path.
	 * @returns True if childPath is a subpath of parentPath, false otherwise.
	 */
	isSubpath(parentPath: string, childPath: string): boolean {
		const normalizedParent = this.resolveAbsolutePath(parentPath).replace(/\\/g, '/');
		const normalizedChild = this.resolveAbsolutePath(childPath).replace(/\\/g, '/');
		
		// Ensure parent ends with '/' for proper subpath comparison
		const parentWithSlash = normalizedParent.endsWith('/') ? normalizedParent : normalizedParent + '/';
		
		// Child should start with parent (with trailing slash) to be a true subpath
		const isSubpath = normalizedChild.startsWith(parentWithSlash);
		
		// Only log when result is true to reduce noise
		if (isSubpath) {
			loggerDebug(this, `isSubpath check: "${childPath}" is subpath of "${parentPath}"`);
		}
		
		return isSubpath;
	}
}
