/**
 * Custom error classes for better error handling
 */

export class SvnError extends Error {
    public readonly command?: string;
    public readonly output?: string;
    
    constructor(message: string, command?: string, output?: string) {
        super(message);
        this.name = 'SvnError';
        this.command = command;
        this.output = output;
    }
}

export class SvnNotInstalledError extends SvnError {
    constructor() {
        super('SVN binary not found. Please install SVN or check the binary path in settings.');
        this.name = 'SvnNotInstalledError';
    }
}

export class NotWorkingCopyError extends SvnError {
    constructor(path: string) {
        super(`The path "${path}" is not an SVN working copy.`);
        this.name = 'NotWorkingCopyError';
    }
}

export class SvnCommandError extends SvnError {
    constructor(command: string, exitCode: number, stderr: string) {
        super(`SVN command failed: ${command}`);
        this.name = 'SvnCommandError';
    }
}
