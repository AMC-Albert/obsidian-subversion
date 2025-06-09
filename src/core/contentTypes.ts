export const CONTENT_TYPES = {
    LOADING: 'loading',
    ERROR: 'error',
    NO_FILE: 'no-file',
    WAITING_FOR_DATA: 'waiting-for-data',
    REPOSITORY_SETUP: 'repository-setup',
    UNVERSIONED_FILE: 'unversioned-file',
    NOT_TRACKED_FILE: 'not-tracked-file',
    ADDED_NOT_COMMITTED: 'added-not-committed',
    NO_HISTORY: 'no-history',
    HISTORY: 'history',
    SETUP: 'setup' // Added for repository setup view
} as const;

export type ContentType = typeof CONTENT_TYPES[keyof typeof CONTENT_TYPES];
