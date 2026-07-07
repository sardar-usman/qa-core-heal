import fs from 'node:fs';
import path from 'node:path';
/**
 * Load qa-core.config.json from the explicit path, else the working directory.
 * Absent file with no explicit path means flag-only behavior, so return null.
 * Relative paths inside the config resolve against the config file's directory.
 */
export function loadConfig(explicitPath) {
    const p = explicitPath ? path.resolve(explicitPath) : path.resolve('qa-core.config.json');
    if (!fs.existsSync(p)) {
        if (explicitPath)
            throw new Error(`Config file not found: ${p}`);
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    catch (e) {
        throw new Error(`Could not parse ${p}: ${e.message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${p} must contain a single JSON object.`);
    }
    return { config: parsed, dir: path.dirname(p), path: p };
}
