import { execPromise } from '@/utils/AsyncUtils';
import { SvnCommandError } from '@/utils/errors';
import { dirname } from 'path';

export interface CommandOutput {
	stdout: string;
	stderr: string;
}

export class SVNCommandExecutor {
	constructor(private svnPath: string, private svnAdminPath: string = 'svnadmin') {}

	private async execute(command: string, cwd: string, operationName: string): Promise<CommandOutput> {
		try {
			// console.log(`Executing: ${command} in ${cwd}`); // For debugging
			const { stdout, stderr } = await execPromise(command, { cwd });
			return { stdout, stderr };
		} catch (error: any) {
			// console.error(`Error executing ${operationName}:`, error); // For debugging
			throw new SvnCommandError(
				`SVN ${operationName} operation failed. Command: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`,
				error.code, // exit code
				error.stderr || error.message // stderr or general message
			);
		}
	}

	async executeLog(targetPath: string, revisionRange: string, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const args = ['log', '--xml', `-r ${revisionRange}`, ...additionalArgs, `"${targetPath}"`];
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'log');
	}

	async executeCat(targetPath: string, revision: string | undefined, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const revisionArg = revision ? `-r ${revision}` : '';
		const args = ['cat', revisionArg, ...additionalArgs, `"${targetPath}"`].filter(arg => arg !== '');
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'cat');
	}

	async executeInfo(targetPath: string, revision: string | undefined, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const revisionArg = revision ? `-r ${revision}` : '';
		// Ensure --xml is part of additionalArgs or hardcoded if always needed by parser
		const finalArgs = ['info', '--xml', revisionArg, ...additionalArgs, `"${targetPath}"`].filter(arg => arg !== '');
		const command = `"${this.svnPath}" ${finalArgs.join(' ')}`;
		return this.execute(command, cwd, 'info');
	}

	async executeStatus(targetPath: string | undefined, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const pathArg = targetPath ? `"${targetPath}"` : '';
		const args = ['status', ...additionalArgs, pathArg].filter(arg => arg !== '' || additionalArgs.length > 0); // Keep 'status' if no path and no other args
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'status');
	}

	async executeList(targetPath: string, revision: string | undefined, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const targetWithRevision = revision ? `"${targetPath}@${revision}"` : `"${targetPath}"`;
		const args = ['list', ...additionalArgs, targetWithRevision];
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'list');
	}

	async executeSvnAdminRevSize(repoPath: string, revision: string): Promise<CommandOutput> {
		const args = ['rev-size', `"${repoPath}"`, `-r ${revision}`, '-q'];
		const command = `"${this.svnAdminPath}" ${args.join(' ')}`;
		// svnadmin commands usually don't need a CWD related to a working copy.
		// Using dirname(repoPath) might be problematic if repoPath is a URL for svnlook.
		// For local file paths, it's okay. Assuming repoPath is a local filesystem path.
		return this.execute(command, dirname(repoPath), 'rev-size');
	}

	async executeRevert(targetPaths: string[], cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const pathsString = targetPaths.map(p => `"${p}"`).join(' ');
		const args = ['revert', ...additionalArgs, pathsString];
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'revert');
	}

	async executeUpdate(targetPaths: string[], revision: string | undefined, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const revisionArg = revision ? `-r ${revision}` : '';
		const pathsString = targetPaths.map(p => `"${p}"`).join(' ');
		const args = ['update', revisionArg, ...additionalArgs, pathsString].filter(arg => arg !== '');
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'update');
	}

	async executeCommit(targetPaths: string[], message: string, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const pathsString = targetPaths.map(p => `"${p}"`).join(' ');
		const escapedMessage = message.replace(/"/g, '\"'); // Basic escaping for double quotes
		const args = ['commit', `-m "${escapedMessage}"`, ...additionalArgs, pathsString];
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'commit');
	}

	async executeAdd(targetPaths: string[], cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const pathsString = targetPaths.map(p => `"${p}"`).join(' ');
		const args = ['add', ...additionalArgs, pathsString];
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'add');
	}

	async executeDiff(targetPath: string, revision: string | undefined, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const revisionArgs = revision ? [`-r ${revision}`] : [];
		const args = ['diff', ...revisionArgs, ...additionalArgs, `"${targetPath}"`];
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'diff');
	}

	async executeBlame(targetPath: string, revision: string | undefined, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const revisionArg = revision ? `-r ${revision}` : '';
		const args = ['blame', '--xml', revisionArg, ...additionalArgs, `"${targetPath}"`].filter(arg => arg !== '');
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'blame');
	}

	async executePropList(targetPath: string, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const args = ['proplist', '--verbose', '--xml', ...additionalArgs, `"${targetPath}"`];
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'proplist');
	}

	async executeMove(oldPath: string, newPath: string, cwd: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const args = ['move', ...additionalArgs, `"${oldPath}"`, `"${newPath}"`];
		const command = `"${this.svnPath}" ${args.join(' ')}`;
		return this.execute(command, cwd, 'move');
	}
	
	async executeSvnAdminCreate(repoPath: string, additionalArgs: string[] = []): Promise<CommandOutput> {
		const args = ['create', ...additionalArgs, `"${repoPath}"`];
		const command = `"${this.svnAdminPath}" ${args.join(' ')}`;
		// svnadmin create doesn't need a CWD in the typical sense, use parent of repo path or a sensible default.
		return this.execute(command, dirname(repoPath) || '.', 'create repository');
	}
}
