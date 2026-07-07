export interface QaCoreHealConfig {
    baseUrl?: string;
    testDir?: string;
    selectorPreference?: string[];
    pageObjects?: {
        enabled?: boolean;
        dir?: string;
    };
    auth?: {
        storageState?: string;
    };
    heal?: {
        dryRunByDefault?: boolean;
        maxHealsPerRun?: number;
        verifyAfterApply?: boolean;
    };
    audit?: {
        logPath?: string;
    };
}
export interface LoadedConfig {
    config: QaCoreHealConfig;
    dir: string;
    path: string;
}
/**
 * Load qa-core.config.json from the explicit path, else the working directory.
 * Absent file with no explicit path means flag-only behavior, so return null.
 * Relative paths inside the config resolve against the config file's directory.
 */
export declare function loadConfig(explicitPath?: string): LoadedConfig | null;
