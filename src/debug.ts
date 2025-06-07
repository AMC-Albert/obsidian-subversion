// Debug logging system using namespace-based debugging
// Users can enable debug messages by running: window.DEBUG?.enable('subversion') in the console
// Or enable Console > Verbose mode to see console.debug() messages

// Define interfaces for our debug system
interface DebugController {
	enable(namespace: string): string;
	disable(namespace: string): string;
	enabled(namespace: string): boolean;
}

// We'll use intersection type since extending Window has conflicts
type SubversionWindow = Window & {
	DEBUG?: DebugController;
	_subversionDebugEnabled?: boolean;
};

// Simple debug namespace implementation
const DEBUG_NAMESPACE = 'subversion';

// Simple flag-based approach for more reliability
function isDebugEnabledSimple(): boolean {
	if (typeof window === 'undefined') return false;
	return !!(window as unknown as SubversionWindow)._subversionDebugEnabled;
}

function setDebugEnabled(enabled: boolean): void {
	if (typeof window !== 'undefined') {
		(window as unknown as SubversionWindow)._subversionDebugEnabled = enabled;
	}
}

// Initialize simple DEBUG controller - force recreation for reliability
function ensureDebugController() {
	if (typeof window === 'undefined') return;
	
	const win = window as unknown as SubversionWindow;
	
	// Create or override the DEBUG controller to ensure it works
	if (!win.DEBUG) {
		win.DEBUG = {
			enable: () => '',
			disable: () => '',
			enabled: () => false
		};
	}
	
	// Store original methods if they exist
	const originalEnable = win.DEBUG.enable;
	const originalDisable = win.DEBUG.disable;
	const originalEnabled = win.DEBUG.enabled;
	
	win.DEBUG.enable = function(namespace: string): string {
		// Handle our namespace
		if (namespace === DEBUG_NAMESPACE || namespace === '*') {
			setDebugEnabled(true);
			const message = `Debug enabled for namespace: ${namespace}`;
			return message;
		}
		
		// Call original if it exists for other namespaces
		if (originalEnable && typeof originalEnable === 'function') {
			return originalEnable.call(this, namespace);
		}
		
		return `Debug enabled for namespace: ${namespace}`;
	};
	
	win.DEBUG.disable = function(namespace: string): string {
		// Handle our namespace
		if (namespace === DEBUG_NAMESPACE || namespace === '*') {
			setDebugEnabled(false);
			const message = `Debug disabled for namespace: ${namespace}`;
			return message;
		}
		
		// Call original if it exists for other namespaces
		if (originalDisable && typeof originalDisable === 'function') {
			return originalDisable.call(this, namespace);
		}
		return `Debug disabled for namespace: ${namespace}`;
	};
	
	win.DEBUG.enabled = function(namespace: string): boolean {
		// Handle our namespace
		if (namespace === DEBUG_NAMESPACE) {
			return isDebugEnabledSimple();
		}
		if (namespace === '*') {
			return isDebugEnabledSimple(); // For wildcard, return our status
		}
		
		// Call original if it exists for other namespaces
		if (originalEnabled && typeof originalEnabled === 'function') {
			return originalEnabled.call(this, namespace);
		}
		return false;
	};
}

// Check if debugging is enabled for our namespace
function isDebugEnabled(): boolean {
	return isDebugEnabledSimple();
}

// Debug logging functions - use console.debug() so they can be controlled by Console settings
export function svnDebug(...args: any[]) {
	if (isDebugEnabled()) {
		console.debug(`%c${DEBUG_NAMESPACE}`, 'color: #4A90E2; font-weight: bold;', ...args);
	}
}

export function svnWarn(...args: any[]) {
	if (isDebugEnabled()) {
		console.warn(`%c${DEBUG_NAMESPACE}`, 'color: #FF8C00; font-weight: bold;', ...args);
	}
}

export function svnInfo(...args: any[]) {
	if (isDebugEnabled()) {
		console.info(`%c${DEBUG_NAMESPACE}`, 'color: #4A90E2; font-weight: bold;', ...args);
	}
}

export function svnError(...args: any[]) {
	if (isDebugEnabled()) {
		console.error(`%c${DEBUG_NAMESPACE}`, 'color: #E74C3C; font-weight: bold;', ...args);
	}
}

// Initialize the debug controller when this module loads
ensureDebugController();
